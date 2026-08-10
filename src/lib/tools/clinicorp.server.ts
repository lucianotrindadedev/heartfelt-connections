// Clinicorp API integration: agendamentos e pacientes
import { getSelfhost } from "@/integrations/selfhost/client.server";
import { decryptValue } from "@/lib/crypto.server";

interface ClinicorpConfig {
  apiToken: string;         // Basic auth base64
  subscriberId: string;
  businessId: number;
  codeLink: string | null;        // agenda_id: Code Link da agenda online
  profissionalIds: number[];      // dentist_person_id[]: profissionais selecionados ([] = todos)
  duracaoConsulta: number;        // minutos (default 40)
  categoryDescription: string | null; // CategoryDescription enviado no create (categoria escolhida)
  categoryColor: string | null;       // CategoryColor enviado no create (ex.: "#FF5733")
  uppercaseName: boolean;             // grava o nome do paciente em MAIÚSCULAS no Clinicorp
  baseUrl: string;
}

const DEFAULT_BASE = "https://api.clinicorp.com";
const CLINICORP_TIMEOUT_MS = 20_000;

function fetchClinicorp(url: string, init?: RequestInit): Promise<Response> {
  return fetch(url, {
    ...init,
    signal: AbortSignal.timeout(CLINICORP_TIMEOUT_MS),
  });
}

async function loadConfig(accountId: string): Promise<ClinicorpConfig> {
  const sb = getSelfhost();
  const { data, error } = await sb
    .from("clinicorp_config")
    .select("api_token_enc, subscriber_id, business_id, agenda_id, dentist_person_id, duracao_consulta, category_description, category_color, uppercase_patient_name, ativo")
    .eq("account_id", accountId)
    .single();

  if (error || !data) throw new Error("Clinicorp não configurado para esta conta");
  if (!data.ativo) throw new Error("Clinicorp não está ativo para esta conta");

  const apiToken = await decryptValue(data.api_token_enc as unknown as string);
  if (!apiToken) throw new Error("Token Clinicorp inválido");

  // dentist_person_id é jsonb: null | number[] (ex: [111, 222])
  let profissionalIds: number[] = [];
  const raw = data.dentist_person_id as unknown;
  if (Array.isArray(raw)) {
    profissionalIds = (raw as unknown[]).map(Number).filter(Boolean);
  }

  return {
    apiToken,
    subscriberId: data.subscriber_id as string,
    businessId: data.business_id as number,
    codeLink: (data.agenda_id as string | number | null)
      ? String(data.agenda_id)
      : null,
    profissionalIds,
    duracaoConsulta: (data.duracao_consulta as number | null) ?? 40,
    categoryDescription: (data.category_description as string | null)?.trim() || null,
    categoryColor: (data.category_color as string | null)?.trim() || null,
    uppercaseName: data.uppercase_patient_name === true,
    baseUrl: DEFAULT_BASE,
  };
}

function authHeaders(config: ClinicorpConfig) {
  return {
    Authorization: `Basic ${config.apiToken}`,
    "Content-Type": "application/json",
    accept: "application/json",
  };
}

// ── Profissionais ──────────────────────────────────────────────────────────

export interface ClinicorpProfessional {
  id: number;
  name: string;
}

export async function listClinicorpProfessionals(
  accountId: string,
): Promise<ClinicorpProfessional[]> {
  const config = await loadConfig(accountId);

  const res = await fetchClinicorp(
    `${config.baseUrl}/rest/v1/professional/list_all_professionals`,
    { headers: authHeaders(config) },
  );
  if (!res.ok) throw new Error(`Clinicorp professionals failed: ${res.status}`);

  const json = (await res.json()) as unknown;

  // API pode retornar array direto, ou { professionals: [] }, ou { data: [] }
  let list: Record<string, unknown>[] = [];
  if (Array.isArray(json)) {
    list = json as Record<string, unknown>[];
  } else if (json && typeof json === "object") {
    const obj = json as Record<string, unknown>;
    const arr = obj.professionals ?? obj.data ?? obj.dentists ?? [];
    if (Array.isArray(arr)) list = arr as Record<string, unknown>[];
  }

  return list
    .map((d) => ({
      // suporta Person_Id, person_id ou id
      id: (d.Person_Id ?? d.person_id ?? d.id) as number,
      name: String(d.Name ?? d.name ?? ""),
    }))
    .filter((d) => d.id);
}

// ── Categorias de Agendamento ───────────────────────────────────────────────

export interface ClinicorpCategory {
  id: string;          // id da categoria (aceita number ou string)
  description: string; // Description → CategoryDescription no create
  color: string;       // Color → CategoryColor no create (ex.: "#FF5733")
}

/**
 * Lista as Categorias de Agendamento (GET /appointment/list_categories →
 * [{ id, Description, Color }]). Usadas para o proprietário escolher a categoria
 * que colore os agendamentos criados pela IA na agenda do Clinicorp.
 */
export async function listClinicorpCategories(
  accountId: string,
): Promise<ClinicorpCategory[]> {
  const config = await loadConfig(accountId);

  const url = new URL(`${config.baseUrl}/rest/v1/appointment/list_categories`);
  if (config.subscriberId) url.searchParams.set("subscriber_id", config.subscriberId);

  const res = await fetchClinicorp(url.toString(), { headers: authHeaders(config) });
  if (!res.ok) throw new Error(`Clinicorp categories failed: ${res.status}`);

  const json = (await res.json()) as unknown;

  // API pode retornar array direto, ou { categories: [] } / { data: [] }.
  let list: Record<string, unknown>[] = [];
  if (Array.isArray(json)) {
    list = json as Record<string, unknown>[];
  } else if (json && typeof json === "object") {
    const obj = json as Record<string, unknown>;
    const arr = obj.categories ?? obj.Categories ?? obj.data ?? [];
    if (Array.isArray(arr)) list = arr as Record<string, unknown>[];
  }

  return list
    .map((c) => ({
      id: String(c.id ?? c.Id ?? c.ID ?? ""),
      description: String(c.Description ?? c.description ?? ""),
      color: String(c.Color ?? c.color ?? c.CategoryColor ?? ""),
    }))
    .filter((c) => c.description);
}

// ── Horários disponíveis ───────────────────────────────────────────────────

export interface ClinicorpSlot {
  start: string; // ISO 8601
  end: string;
  dentistPersonId?: number;
  /** Data local YYYY-MM-DD (igual ao parâmetro do n8n buscar_horarios). */
  localDate: string;
  /** Horário local hh:mm — usar em agendar_clinicorp via horario ISO ou campos explícitos. */
  fromTime: string;
  toTime: string;
}

function addCalendarDay(isoDate: string, days: number): string {
  const [y, m, d] = isoDate.split("-").map(Number);
  const dt = new Date(y, m - 1, d + days);
  const mm = String(dt.getMonth() + 1).padStart(2, "0");
  const dd = String(dt.getDate()).padStart(2, "0");
  return `${dt.getFullYear()}-${mm}-${dd}`;
}

function enumerateDates(from: string, to: string): string[] {
  const startD = from.slice(0, 10);
  const endD = to.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startD) || !/^\d{4}-\d{2}-\d{2}$/.test(endD)) {
    return [];
  }

  const dates: string[] = [];
  let cur = startD;
  const limit = 14;
  while (cur <= endD && dates.length < limit) {
    dates.push(cur);
    cur = addCalendarDay(cur, 1);
  }
  return dates;
}

function slotIsoInBrazil(date: string, time: string): string {
  const hhmm = time.length === 5 ? time : time.slice(0, 5);
  // Offset fixo BRT (UTC-3), alinhado ao createClinicorpAppointment
  return `${date}T${hhmm}:00-03:00`;
}

function extractCalendarEntries(json: unknown): Record<string, unknown>[] {
  if (Array.isArray(json)) return json as Record<string, unknown>[];
  if (!json || typeof json !== "object") return [];

  const obj = json as Record<string, unknown>;
  const candidates = [
    obj.availableTimes,
    obj.AvailableTimes,
    obj.times,
    obj.Times,
    obj.slots,
    obj.Slots,
    obj.data,
  ];
  for (const c of candidates) {
    if (Array.isArray(c)) return c as Record<string, unknown>[];
  }
  return [];
}

/** Normaliza "8:30" → "08:30". Retorna "" se não bater com HH:MM. */
function padHourMinute(raw: string): string {
  const match = raw.match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return "";
  const hh = match[1].padStart(2, "0");
  return `${hh}:${match[2]}`;
}

function parseCalendarDay(json: unknown, date: string): ClinicorpSlot[] {
  const entries = extractCalendarEntries(json);
  const slots: ClinicorpSlot[] = [];

  for (const row of entries) {
    // API real retorna { From, To, ProfessionalId } — mantemos fallbacks para outras variantes.
    const rawFrom = String(
      row.From ?? row.from ?? row.fromTime ?? row.FromTime ?? row.start_time ?? row.StartTime ?? "",
    ).trim();
    const rawTo = String(
      row.To ?? row.to ?? row.toTime ?? row.ToTime ?? row.end_time ?? row.EndTime ?? "",
    ).trim();

    const fromTime = padHourMinute(rawFrom);
    if (!fromTime) continue;
    const toTime = padHourMinute(rawTo) || fromTime;

    const dentistPersonId = Number(
      row.ProfessionalId ??
        row.professionalId ??
        row.Dentist_PersonId ??
        row.dentist_person_id ??
        row.person_id,
    ) || undefined;

    slots.push({
      localDate: date,
      fromTime,
      toTime,
      start: slotIsoInBrazil(date, fromTime),
      end: slotIsoInBrazil(date, toTime),
      dentistPersonId,
    });
  }

  return slots;
}

/** Mesmo endpoint do n8n `buscar_horarios`: uma data por requisição. */
async function fetchAvailableTimesForDate(
  config: ClinicorpConfig,
  date: string,
): Promise<ClinicorpSlot[]> {
  if (!config.codeLink) {
    throw new Error(
      "Agenda online (code_link) não configurada no Clinicorp — necessária para buscar horários.",
    );
  }

  const url = new URL(`${config.baseUrl}/rest/v1/appointment/get_avaliable_times_calendar`);
  url.searchParams.set("subscriber_id", config.subscriberId);
  url.searchParams.set("date", date.slice(0, 10));
  url.searchParams.set("code_link", config.codeLink);

  const res = await fetchClinicorp(url.toString(), { headers: authHeaders(config) });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(
      `Clinicorp get_avaliable_times_calendar failed: ${res.status} — ${err.slice(0, 200)}`,
    );
  }

  const json = await res.json();
  return parseCalendarDay(json, date.slice(0, 10));
}

/** "HH:MM" (ou "H:MM") → minutos do dia. -1 se inválido. */
function timeToMin(t: string): number {
  const m = /(\d{1,2}):(\d{2})/.exec(t ?? "");
  if (!m) return -1;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (!Number.isFinite(h) || !Number.isFinite(mi)) return -1;
  return h * 60 + mi;
}

interface BusyInterval {
  localDate: string; // YYYY-MM-DD
  professionalId?: number;
  fromMin: number;
  toMin: number;
}

/**
 * Intervalos REALMENTE ocupados na agenda (appointment/list), por dia e
 * profissional. A agenda ONLINE (get_avaliable_times_calendar) devolve horários
 * como livres que na verdade já têm consulta marcada — validado em produção
 * (Costa Lima Recreio: 17/07 09:45 vinha "livre" mas havia paciente 09:45-10:00,
 * e o create batia em "O horário solicitado encontra-se ocupado"). Cruzamos as
 * duas fontes para só ofertar o que está de fato livre.
 */
async function fetchBusyIntervals(
  config: ClinicorpConfig,
  from: string,
  to: string,
): Promise<BusyInterval[]> {
  const url = new URL(`${config.baseUrl}/rest/v1/appointment/list`);
  url.searchParams.set("subscriber_id", config.subscriberId);
  url.searchParams.set("business_id", String(config.businessId));
  url.searchParams.set("from", from.slice(0, 10));
  url.searchParams.set("to", to.slice(0, 10));

  const res = await fetchClinicorp(url.toString(), { headers: authHeaders(config) });
  if (!res.ok) {
    console.error(`[clinicorp] busy intervals: list falhou ${res.status}`);
    return [];
  }
  const json = (await res.json()) as unknown;
  const rows = Array.isArray(json) ? (json as Record<string, unknown>[]) : [];
  const out: BusyInterval[] = [];
  for (const a of rows) {
    if (a.Deleted) continue;
    const localDate = String(a.date ?? "").slice(0, 10);
    const fromMin = timeToMin(String(a.fromTime ?? ""));
    const toMin = timeToMin(String(a.toTime ?? ""));
    if (!localDate || fromMin < 0 || toMin < 0) continue;
    const dpid = Number(
      a.Dentist_PersonId ?? a.dentist_person_id ?? a.DentistPersonId ?? a.dentistPersonId,
    );
    out.push({
      localDate,
      professionalId: Number.isFinite(dpid) && dpid > 0 ? dpid : undefined,
      fromMin,
      toMin,
    });
  }
  return out;
}

/**
 * Um slot (fromTime + duração) está LIVRE quando nenhum agendamento real do
 * mesmo dia/profissional se sobrepõe à janela de reserva. Janela = [start,
 * start+dur). Profissional diferente não conflita; agendamento adjacente
 * (termina onde o slot começa) não conflita. É a mesma checagem que o Clinicorp
 * faz no create — por isso casa com o "horário ocupado" que ele devolve.
 */
export function isSlotFreeAgainstBusy(
  slot: { localDate: string; fromTime: string; dentistPersonId?: number },
  durMin: number,
  busy: ReadonlyArray<{ localDate: string; professionalId?: number; fromMin: number; toMin: number }>,
): boolean {
  const startMin = timeToMin(slot.fromTime);
  if (startMin < 0) return true; // sem hora parseável, não descarta
  const endMin = startMin + durMin;
  for (const b of busy) {
    if (b.localDate !== slot.localDate) continue;
    if (slot.dentistPersonId && b.professionalId && b.professionalId !== slot.dentistPersonId) {
      continue; // profissionais diferentes não conflitam
    }
    if (startMin < b.toMin && endMin > b.fromMin) return false; // sobreposição
  }
  return true;
}

/**
 * Remove os slots cuja consulta (fromTime + durMin) ultrapassaria o fim do
 * expediente. O Clinicorp não expõe horário de funcionamento; a grade de
 * get_avaliable_times_calendar é a fonte — o fim da ÚLTIMA janela do dia, por
 * profissional, é o fechamento efetivo. Sem isto um slot de 17:15 com consulta
 * de 40 min era ofertado numa agenda que fecha 17:30 (17:15+40=17:55): depois de
 * fechar não há grade nem agendamento, então o cross-check de ocupados deixava
 * passar. Caso real (Odonto Carioca/occampogrande, lead que só podia após 17h).
 *
 * IMPORTANTE: receba a grade CRUA (antes de remover ocupados). Um agendamento na
 * última janela do dia não adianta o horário de FECHAR — quem fecha 17:30 segue
 * fechando 17:30 mesmo com a última vaga tomada, e 16:50 continua cabendo.
 *
 * Só limita pelo FIM do dia (última janela), não por buracos no meio — um buraco
 * mid-day é agendamento (tratado por isSlotFreeAgainstBusy) ou padrão da própria
 * grade, e cortar por ele derrubaria horários válidos (medido em produção: a
 * cobertura contígua derrubava até 50% dos slots, incluindo os do meio do dia).
 */
export function filterSlotsByClosing<
  T extends { localDate: string; fromTime: string; toTime: string; dentistPersonId?: number },
>(slots: T[], durMin: number): T[] {
  const closingByKey = new Map<string, number>();
  for (const s of slots) {
    const key = `${s.localDate}|${s.dentistPersonId ?? ""}`;
    const end = timeToMin(s.toTime);
    if (end < 0) continue;
    const cur = closingByKey.get(key);
    if (cur == null || end > cur) closingByKey.set(key, end);
  }
  return slots.filter((s) => {
    const closing = closingByKey.get(`${s.localDate}|${s.dentistPersonId ?? ""}`);
    if (closing == null) return true;
    const start = timeToMin(s.fromTime);
    if (start < 0) return true; // sem hora parseável, não descarta
    return start + durMin <= closing;
  });
}

export async function listClinicorpSlots(
  accountId: string,
  from: string,
  to: string,
): Promise<ClinicorpSlot[]> {
  const config = await loadConfig(accountId);
  const dates = enumerateDates(from, to);
  if (!dates.length) return [];

  const [perDay, busy] = await Promise.all([
    Promise.all(dates.map((d) => fetchAvailableTimesForDate(config, d).catch(() => []))),
    fetchBusyIntervals(config, from, to).catch(() => [] as BusyInterval[]),
  ]);
  let merged = perDay.flat();

  if (config.profissionalIds.length > 0) {
    const allowed = new Set(config.profissionalIds);
    merged = merged.filter(
      (s) => !s.dentistPersonId || allowed.has(s.dentistPersonId),
    );
  }

  const dur = config.duracaoConsulta > 0 ? config.duracaoConsulta : 40;

  // FECHAMENTO: a consulta INTEIRA precisa caber antes do fim do expediente
  // (calculado da grade CRUA, antes de remover ocupados — ver filterSlotsByClosing).
  {
    const before = merged.length;
    merged = filterSlotsByClosing(merged, dur);
    const removed = before - merged.length;
    if (removed > 0) {
      console.log(
        `[clinicorp] fechamento: removidos ${removed}/${before} horários cuja consulta (${dur}min) passaria do fim do expediente`,
      );
    }
  }

  // CROSS-CHECK: remove o horário que colide com um agendamento REAL. A janela
  // de reserva vai de fromTime até fromTime+duração (o que o create tenta). Um
  // slot é livre só se NENHUM agendamento do mesmo profissional (ou de qualquer
  // um, quando o slot não traz profissional) se sobrepõe a essa janela. Sem
  // isto, o agente ofertava horário ocupado e o create falhava.
  if (busy.length > 0) {
    const before = merged.length;
    merged = merged.filter((s) => isSlotFreeAgainstBusy(s, dur, busy));
    const removed = before - merged.length;
    if (removed > 0) {
      console.log(
        `[clinicorp] cross-check: removidos ${removed}/${before} horários ocupados (agenda online x agendamentos reais)`,
      );
    }
  }

  return dedupSlotsByDateTime(merged).sort((a, b) => a.start.localeCompare(b.start));
}

/**
 * Dedup por data+hora, SEM o profissional na chave.
 *
 * O lead nunca escolhe profissional — é implementação interna (o slot escolhido
 * já carrega o dentist_person_id certo). Com o dentista na chave, dois dentistas
 * livres no MESMO horário viravam duas entradas idênticas em offered_slots
 * ("terça 11/08 10:00" duas vezes). Aí o lead responde "às 10 horas",
 * tryAutoSelectOfferedSlot encontra 2 candidatos ambíguos e NUNCA preenche
 * selected_slot_iso → criar_agendamento falha por slot ausente → a trava de
 * confirmação falsa re-oferta → LOOP até um humano assumir.
 *
 * Caso real (Sorriso Saúde, 27 99922-9610, 10/08/2026): a lead pediu "às 10
 * horas" duas vezes e recebeu de volta 13:00/13:30 e depois 09:00/09:30.
 * Mesma correção já aplicada no Clinic Experts (8415c1d); o Clinup já
 * deduplicava por data+hora (dedupPorDataHora). Mantém o 1º profissional livre.
 */
export function dedupSlotsByDateTime<T extends { localDate: string; fromTime: string }>(
  slots: T[],
): T[] {
  const seen = new Set<string>();
  return slots.filter((s) => {
    const key = `${s.localDate}|${s.fromTime}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ── Paciente ──────────────────────────────────────────────────────────────

export interface ClinicorpPatient {
  id: number | null;
  name: string;
  phone: string;
}

function phoneVariantsForPatientGet(phone: string): string[] {
  const digits = phone.replace(/\D/g, "");
  const without55 = digits.replace(/^55/, "");
  const variants = new Set<string>();
  if (without55) variants.add(without55);
  if (digits) variants.add(digits);
  if (phone.startsWith("+")) variants.add(phone);
  variants.add(`+55${without55 || digits}`);
  return [...variants];
}

/**
 * Núcleo comparável de um telefone BR: só dígitos, sem prefixo 55, sem o "9"
 * de celular (alguns cadastros gravam com, outros sem). Ex.: "+55 (21)
 * 97012-8245", "5521970128245", "21970128245", "2170128245" → "2170128245".
 * Usado para casar o telefone do cadastro Clinicorp com o do lead na dedup
 * por nome (a busca por ?Phone= do Clinicorp NÃO acha pacientes criados só com
 * MobilePhone — ver findClinicorpPatient).
 */
function brazilPhoneCore(raw: string | number | null | undefined): string {
  let d = String(raw ?? "").replace(/\D/g, "");
  if (d.length > 11 && d.startsWith("55")) d = d.slice(2);
  // Remove o 9 extra de celular após o DDD (11 dígitos → 10) para comparar
  // cadastros gravados com e sem o nono dígito.
  if (d.length === 11 && d[2] === "9") d = d.slice(0, 2) + d.slice(3);
  return d;
}

export function sameBrazilPhone(a: string | number | null | undefined, b: string | number | null | undefined): boolean {
  const ca = brazilPhoneCore(a);
  const cb = brazilPhoneCore(b);
  return ca.length >= 8 && ca === cb;
}

interface ClinicorpPatientRaw {
  PatientId?: number;
  Patient_PersonId?: number;
  Person_Id?: number;
  person_id?: number;
  id?: number;
  Name?: string;
  name?: string;
  Phone?: string;
  phone?: string;
  Status?: string;
  status?: string;
}

function pickActivePatient(rows: ClinicorpPatientRaw[]): ClinicorpPatientRaw | null {
  if (!rows.length) return null;
  // Prioriza ACTIVE — descarta DELETED/INACTIVE.
  const active = rows.find(
    (r) => (r.Status ?? r.status ?? "").toUpperCase() === "ACTIVE",
  );
  return active ?? rows.find((r) => (r.Status ?? r.status ?? "").toUpperCase() !== "DELETED") ?? null;
}

function normalizePatient(raw: ClinicorpPatientRaw, fallbackPhone: string): ClinicorpPatient | null {
  const id =
    raw.PatientId ??
    raw.Patient_PersonId ??
    raw.Person_Id ??
    raw.person_id ??
    raw.id ??
    null;
  if (!id) return null;
  return {
    id: id as number,
    name: String(raw.Name ?? raw.name ?? ""),
    phone: String(raw.Phone ?? raw.phone ?? fallbackPhone),
  };
}

async function fetchPatientByPhone(
  config: ClinicorpConfig,
  phoneValue: string,
): Promise<ClinicorpPatient | null> {
  const url = new URL(`${config.baseUrl}/rest/v1/patient/get`);
  url.searchParams.set("subscriber_id", config.subscriberId);
  url.searchParams.set("Phone", phoneValue);

  const res = await fetchClinicorp(url.toString(), { headers: authHeaders(config) });
  if (!res.ok) return null;

  const json = (await res.json()) as unknown;

  // API real retorna ARRAY direto: [{ PatientId, Name, Phone, Status, BirthDate }]
  // Algumas variantes podem retornar { patient: {...} } ou { patients: [...] }.
  let rows: ClinicorpPatientRaw[] = [];
  if (Array.isArray(json)) {
    rows = json as ClinicorpPatientRaw[];
  } else if (json && typeof json === "object") {
    const obj = json as Record<string, unknown>;
    if (Array.isArray(obj.patients)) rows = obj.patients as ClinicorpPatientRaw[];
    else if (obj.patient && typeof obj.patient === "object")
      rows = [obj.patient as ClinicorpPatientRaw];
  }

  const picked = pickActivePatient(rows);
  if (!picked) return null;
  return normalizePatient(picked, phoneValue);
}

/**
 * Busca pacientes pelo Name (endpoint patient/get?Name=). Retorna TODOS os
 * cadastros com esse nome (a API só casa nome praticamente completo). Usada
 * como fallback da dedup quando a busca por telefone falha.
 */
async function fetchPatientsByName(
  config: ClinicorpConfig,
  name: string,
): Promise<ClinicorpPatientRaw[]> {
  const url = new URL(`${config.baseUrl}/rest/v1/patient/get`);
  url.searchParams.set("subscriber_id", config.subscriberId);
  url.searchParams.set("Name", name);

  const res = await fetchClinicorp(url.toString(), { headers: authHeaders(config) });
  if (!res.ok) return [];

  const json = (await res.json()) as unknown;
  if (Array.isArray(json)) return json as ClinicorpPatientRaw[];
  if (json && typeof json === "object") {
    const obj = json as Record<string, unknown>;
    if (Array.isArray(obj.patients)) return obj.patients as ClinicorpPatientRaw[];
    if (obj.patient && typeof obj.patient === "object") return [obj.patient as ClinicorpPatientRaw];
  }
  return [];
}

export async function findClinicorpPatient(
  accountId: string,
  phone: string,
  name?: string,
): Promise<ClinicorpPatient | null> {
  const config = await loadConfig(accountId);

  // 1. Busca por telefone (n8n usa dígitos sem prefixo 55; tentamos variantes).
  for (const variant of phoneVariantsForPatientGet(phone)) {
    const found = await fetchPatientByPhone(config, variant);
    if (found?.id) return found;
  }

  // 2. Fallback por NOME + verificação de telefone. A busca por ?Phone= do
  // Clinicorp NÃO encontra pacientes que o agente criou (gravados só com
  // MobilePhone) — o passo 1 volta vazio e, sem este fallback, cada
  // agendamento cria um cadastro NOVO do mesmo paciente (duplicatas). Aqui
  // buscamos por nome e só reutilizamos um cadastro cujo telefone bate com o
  // do lead — homônimos com telefone diferente NÃO são reaproveitados.
  if (name?.trim()) {
    const rows = await fetchPatientsByName(config, name.trim());
    const matches = rows.filter((r) => sameBrazilPhone(r.Phone ?? r.phone, phone));
    const picked = pickActivePatient(matches);
    if (picked) return normalizePatient(picked, phone);
  }

  return null;
}

async function createClinicorpPatient(
  config: ClinicorpConfig,
  params: { name: string; phone: string },
): Promise<number | null> {
  // Remove tudo exceto dígitos para MobilePhone (API espera número sem +55)
  const mobilePhone = Number(
    params.phone.replace(/\D/g, "").replace(/^55/, ""),
  );

  // Título do agendamento no Clinicorp = Name do paciente. Algumas clínicas
  // exigem o nome em MAIÚSCULAS (config uppercase_patient_name). Só afeta o que
  // é GRAVADO no Clinicorp — a confirmação ao lead usa o nome normal.
  const registerName = config.uppercaseName
    ? params.name.toLocaleUpperCase("pt-BR")
    : params.name;

  const res = await fetchClinicorp(`${config.baseUrl}/rest/v1/patient/create`, {
    method: "POST",
    headers: authHeaders(config),
    body: JSON.stringify({
      subscriber_id: config.subscriberId,
      Name: registerName,
      MobilePhone: mobilePhone,
      IgnoreSameName: "X",
    }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Clinicorp create patient failed: ${res.status} ${err.slice(0, 200)}`);
  }

  const json = (await res.json()) as unknown;

  // Suporta: { patient: {...} } | { PatientId } | [{ PatientId }] | array
  let row: ClinicorpPatientRaw | null = null;
  if (Array.isArray(json)) row = (json as ClinicorpPatientRaw[])[0] ?? null;
  else if (json && typeof json === "object") {
    const obj = json as Record<string, unknown>;
    if (obj.patient && typeof obj.patient === "object") row = obj.patient as ClinicorpPatientRaw;
    else row = obj as ClinicorpPatientRaw;
  }
  if (!row) return null;

  return (
    row.PatientId ?? row.Patient_PersonId ?? row.Person_Id ?? row.person_id ?? row.id ?? null
  );
}

// ── Agendamento ────────────────────────────────────────────────────────────

export interface AppointmentResult {
  id: number | string;
  datetime: string;
  patientName: string;
}

// Extrai data e hora no fuso America/Sao_Paulo a partir de qualquer ISO 8601.
// Retorna { localDate: "YYYY-MM-DD", localTime: "HH:MM" } no horário de Brasília.
function extractSpTime(isoStr: string): { localDate: string; localTime: string } {
  const TZ = "America/Sao_Paulo";
  const d = new Date(isoStr);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit",
    hour12: false,
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "00";
  return {
    localDate: `${get("year")}-${get("month")}-${get("day")}`,
    localTime: `${get("hour")}:${get("minute")}`,
  };
}

export async function createClinicorpAppointment(
  accountId: string,
  params: {
    phone: string;
    name: string;
    datetime: string;   // ISO 8601 — usado para extrair date, fromTime
    endDatetime?: string; // ISO 8601 — usado para toTime (opcional)
    dentistPersonId?: number; // sobrescreve o profissional da config
    notes?: string; // resumo do caso → campo Notes no Clinicorp (máx 150 chars)
  },
): Promise<AppointmentResult> {
  const config = await loadConfig(accountId);

  // Duração da consulta: usa o valor configurado (default 40 min)
  const duracaoMin = config.duracaoConsulta;

  // 1. Busca ou cria paciente. Passa o nome para a dedup por nome+telefone
  // (a busca só por telefone não acha cadastros criados pelo agente — ver
  // findClinicorpPatient), evitando criar um paciente duplicado a cada visita.
  let patient = await findClinicorpPatient(accountId, params.phone, params.name);
  let patientId: number | null = patient?.id ?? null;

  if (!patientId) {
    patientId = await createClinicorpPatient(config, {
      name: params.name,
      phone: params.phone,
    });
  }
  if (!patientId) throw new Error("Não foi possível obter ID do paciente Clinicorp");

  // 2. Extrai fromTime / toTime / date no fuso horário de Brasília (America/Sao_Paulo)
  const { localDate, localTime: fromTime } = extractSpTime(params.datetime);

  let toTime: string;
  if (params.endDatetime) {
    toTime = extractSpTime(params.endDatetime).localTime;
  } else {
    // Calcula fim baseado na duração configurada
    const startMs = new Date(params.datetime).getTime();
    toTime = extractSpTime(new Date(startMs + duracaoMin * 60 * 1000).toISOString()).localTime;
  }

  // date: formato que a Clinicorp API espera — midnight BRT (UTC-3 = T03:00:00.000Z)
  const dateStr = localDate + "T03:00:00.000Z";

  // 3. Dentist_PersonId: parâmetro passado > primeiro da config > omite
  const dentistPersonId =
    params.dentistPersonId ??
    (config.profissionalIds.length === 1 ? config.profissionalIds[0] : undefined);

  const body: Record<string, unknown> = {
    subscriber_id: config.subscriberId,
    Patient_PersonId: patientId,
    fromTime,
    toTime,
    date: dateStr,
    Clinic_BusinessId: config.businessId,
  };
  if (dentistPersonId) {
    body.Dentist_PersonId = dentistPersonId;
  }
  // Categoria de Agendamento (cor + descrição) escolhida na config — o
  // agendamento aparece com a cor certa na agenda do Clinicorp. Só envia se
  // configurada; sem categoria, o create segue sem esses campos.
  if (config.categoryColor) {
    body.CategoryColor = config.categoryColor;
  }
  if (config.categoryDescription) {
    body.CategoryDescription = config.categoryDescription;
  }
  // Observações do agendamento (resumo do caso) → campo Notes. Limite
  // defensivo de 150 chars; vazio não é enviado.
  const notes = (params.notes ?? "").trim();
  if (notes) {
    body.Notes = notes.slice(0, 150);
  }

  console.log("[clinicorp] create appointment body:", JSON.stringify(body));

  const pickId = (o: unknown): string | number | undefined => {
    if (!o || typeof o !== "object") return undefined;
    const r = o as Record<string, unknown>;
    const cand =
      r.id ?? r.Id ?? r.ID ?? r.appointment_id ?? r.Appointment_Id ?? r.AppointmentId;
    return typeof cand === "string" || typeof cand === "number" ? cand : undefined;
  };
  const pickDt = (o: unknown): string | undefined => {
    if (!o || typeof o !== "object") return undefined;
    const r = o as Record<string, unknown>;
    const cand = r.start_datetime ?? r.StartDateTime ?? r.datetime ?? r.date;
    return typeof cand === "string" ? cand : undefined;
  };

  // Re-consulta a agenda do paciente e localiza o agendamento que bate com o
  // horário escolhido. Distingue três casos, o que é essencial para re-tentar
  // sem duplicar:
  //   { id }      → encontrado (usar este id, não criar de novo)
  //   { absent }  → consulta OK e NÃO existe → seguro re-tentar o create
  //   { unknown } → a consulta em si falhou → NÃO re-tentar (risco de duplicar)
  const findCreatedAppointmentId = async (): Promise<
    { id: string | number } | { absent: true } | { unknown: true }
  > => {
    try {
      const target = extractSpTime(params.datetime);
      const list = await listClinicorpPatientAppointments(accountId, params.phone);
      const match = list.find((a) => {
        if (!a.datetime) return false;
        const t = extractSpTime(a.datetime);
        return t.localDate === target.localDate && t.localTime === target.localTime;
      });
      if (match?.id) return { id: match.id };
      return { absent: true };
    } catch (e) {
      console.error("[clinicorp] re-consulta de agenda falhou:", e);
      return { unknown: true };
    }
  };

  // O create do Clinicorp às vezes responde 2xx SEM devolver o id (ou em formato
  // não reconhecido). Antes, isso retornava id="" e o sistema tratava como
  // sucesso — gerando confirmação falsa ao lead, troca de etiqueta e nenhuma
  // notificação. Agora: tentamos extrair o id; se não vier, re-consultamos a
  // agenda; e só re-tentamos o POST quando a re-consulta CONFIRMA ausência
  // (nunca quando ela falha — aí poderíamos duplicar). Sem id confiável ao
  // final, lançamos erro (o caller trata como falha e não confirma).
  const MAX_ATTEMPTS = 2;
  let apptId: string | number = "";
  let apptDt: string = params.datetime;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const res = await fetchClinicorp(
      `${config.baseUrl}/rest/v1/appointment/create_appointment_by_api`,
      {
        method: "POST",
        headers: authHeaders(config),
        body: JSON.stringify(body),
      },
    );
    const rawBody = await res.text();
    if (!res.ok) {
      const msg = `Clinicorp create appointment failed: ${res.status} — ${rawBody.slice(0, 300)}`;
      console.error(`[clinicorp] tentativa ${attempt}/${MAX_ATTEMPTS}:`, msg);
      if (attempt < MAX_ATTEMPTS) continue;
      throw new Error(msg);
    }

    console.log("[clinicorp] create appointment response:", rawBody.slice(0, 500));
    let json: Record<string, unknown> = {};
    try {
      json = JSON.parse(rawBody) as Record<string, unknown>;
    } catch {
      json = {};
    }
    const apptObj =
      (json.appointment as unknown) ??
      (json.Appointment as unknown) ??
      (json.data as unknown) ??
      json;
    apptId = pickId(apptObj) ?? pickId(json) ?? "";
    apptDt = pickDt(apptObj) ?? pickDt(json) ?? params.datetime;
    if (apptId) break;

    // Sem id na resposta — confere na agenda antes de decidir re-tentar.
    console.warn(
      `[clinicorp] tentativa ${attempt}/${MAX_ATTEMPTS}: id ausente na resposta — re-consultando agenda`,
    );
    const found = await findCreatedAppointmentId();
    if ("id" in found) {
      apptId = found.id;
      console.log(`[clinicorp] id recuperado via lista: ${apptId}`);
      break;
    }
    if ("unknown" in found) {
      // Não dá pra confirmar se existe — re-tentar poderia duplicar. Falha.
      throw new Error(
        "Clinicorp: agendamento não confirmado (resposta sem id e re-consulta da agenda falhou)",
      );
    }
    // found.absent: o agendamento comprovadamente não existe → re-tenta o create.
    if (attempt < MAX_ATTEMPTS) {
      console.warn(
        `[clinicorp] agendamento ausente na agenda — nova tentativa de create (${attempt + 1}/${MAX_ATTEMPTS})`,
      );
    }
  }

  if (!apptId) {
    throw new Error(
      `Clinicorp: agendamento não confirmado após ${MAX_ATTEMPTS} tentativas (sem id e ausente na agenda)`,
    );
  }

  return {
    id: apptId,
    datetime: apptDt,
    patientName: patient?.name ?? params.name,
  };
}

// ── Agendamentos do paciente ────────────────────────────────────────────────

export interface ClinicorpAppointment {
  id: number | string;
  datetime: string;
  status: string;
  dentistName?: string;
}

/**
 * Busca os agendamentos de um paciente pelo telefone.
 * Primeiro encontra o Patient_PersonId, depois lista os agendamentos.
 */
export async function listClinicorpPatientAppointments(
  accountId: string,
  phone: string,
): Promise<ClinicorpAppointment[]> {
  const config = await loadConfig(accountId);

  // 1. Localiza o paciente para obter o PersonId
  const patient = await findClinicorpPatient(accountId, phone);
  if (!patient?.id) return [];

  // 2. Lista agendamentos — mesmo contrato do n8n (POST com from/to/businessId/patientId)
  const today = new Date().toISOString().slice(0, 10);
  const inOneYear = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);

  const res = await fetchClinicorp(`${config.baseUrl}/rest/v1/appointment/list`, {
    method: "POST",
    headers: authHeaders(config),
    body: JSON.stringify({
      subscriber_id: config.subscriberId,
      from: today,
      to: inOneYear,
      businessId: config.businessId,
      patientId: patient.id,
    }),
  });
  if (!res.ok) return [];

  const json = (await res.json()) as {
    appointments?: {
      id?: number | string;
      Id?: number | string;
      start_datetime?: string;
      StartDateTime?: string;
      status?: string;
      Status?: string;
      dentist_name?: string;
      DentistName?: string;
    }[];
  };

  return (json.appointments ?? []).map((a) => ({
    id: a.id ?? a.Id ?? "",
    datetime: a.start_datetime ?? a.StartDateTime ?? "",
    status: a.status ?? a.Status ?? "",
    dentistName: a.dentist_name ?? a.DentistName,
  }));
}

/**
 * Cancela um agendamento pelo ID.
 */
export async function cancelClinicorpAppointment(
  accountId: string,
  appointmentId: number | string,
  _reason?: string,
): Promise<{ ok: boolean; message: string }> {
  const config = await loadConfig(accountId);

  const res = await fetchClinicorp(
    `${config.baseUrl}/rest/v1/appointment/cancel_appointment`,
    {
      method: "POST",
      headers: authHeaders(config),
      body: JSON.stringify({
        subscriber_id: config.subscriberId,
        id: Number(appointmentId),
      }),
    },
  );

  if (!res.ok) {
    const err = await res.text();
    return { ok: false, message: `Erro ao cancelar: ${res.status} ${err.slice(0, 100)}` };
  }
  return { ok: true, message: "Agendamento cancelado com sucesso." };
}

// ── Warm-up: agendamentos próximos ─────────────────────────────────────────

/** Normaliza telefone BR para o formato de conversations.phone (DDD+número,
 *  sem DDI). Ex.: "+5521994880302" → "21994880302". */
function normalizeBrPhone(raw: string): string {
  const digits = (raw || "").replace(/\D/g, "");
  if (digits.length >= 12 && digits.startsWith("55")) return digits.slice(2);
  return digits;
}

export async function listClinicorpUpcomingAppointments(
  accountId: string,
  from: string,
  to: string,
): Promise<
  {
    id: number | string;
    start: string;
    patientName: string;
    phone: string;
    status: string;
    dentistPersonId?: number;
  }[]
> {
  const config = await loadConfig(accountId);

  // Contrato real da API: GET com `from`/`to` (YYYY-MM-DD). A resposta é um
  // ARRAY direto de agendamentos — cada item traz date + fromTime (hora local
  // BRT), PatientName, MobilePhone e id. (Os nomes antigos date_from/date_to e
  // o envelope {appointments:[...]} nunca existiram → warm-up sempre vinha vazio.)
  const url = new URL(`${config.baseUrl}/rest/v1/appointment/list`);
  url.searchParams.set("subscriber_id", config.subscriberId);
  url.searchParams.set("business_id", String(config.businessId));
  url.searchParams.set("from", from.slice(0, 10));
  url.searchParams.set("to", to.slice(0, 10));

  const res = await fetchClinicorp(url.toString(), { headers: authHeaders(config) });
  if (!res.ok) {
    const body = await res.text();
    console.error(`[clinicorp] list upcoming falhou: ${res.status} — ${body.slice(0, 200)}`);
    return [];
  }

  const json = (await res.json()) as unknown;
  const rows = Array.isArray(json) ? (json as Record<string, unknown>[]) : [];

  const out: {
    id: number | string;
    start: string;
    patientName: string;
    phone: string;
    status: string;
    dentistPersonId?: number;
  }[] = [];
  for (const a of rows) {
    if (a.Deleted) continue; // agendamento excluído
    const dateRaw = String(a.date ?? ""); // "2026-06-26T03:00:00.000Z" (00:00 BRT do dia)
    const fromTime = String(a.fromTime ?? ""); // "13:30" ou "9:30"
    if (!dateRaw || !fromTime) continue;
    const [hh, mm] = fromTime.split(":");
    if (!hh || !mm) continue;
    const localTime = `${hh.padStart(2, "0")}:${mm.padStart(2, "0")}`;
    const start = `${dateRaw.slice(0, 10)}T${localTime}:00-03:00`;

    // Profissional do agendamento (para filtrar warm-up por profissional).
    const dpidRaw =
      a.Dentist_PersonId ?? a.dentist_person_id ?? a.DentistPersonId ?? a.dentistPersonId;
    const dpid = Number(dpidRaw);

    out.push({
      id: (a.id as number | string) ?? "",
      start,
      patientName: String(a.PatientName ?? a.Name ?? ""),
      phone: normalizeBrPhone(String(a.MobilePhone ?? "")),
      status: String(a.CategoryDescription ?? ""),
      dentistPersonId: Number.isFinite(dpid) && dpid > 0 ? dpid : undefined,
    });
  }
  return out;
}
