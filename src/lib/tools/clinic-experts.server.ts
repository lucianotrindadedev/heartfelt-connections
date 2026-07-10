// Clinic Experts API integration (clinicaexperts.com.br): agendamentos e pacientes.
// Espelha clinicorp.server.ts na estrutura, mas com o contrato REST do Clinic
// Experts (Bearer token, JSON, uuid como identificador).
//
// A API do Clinic Experts NÃO expõe o expediente de cada profissional (GET
// /professionals só traz dados cadastrais) — por isso guardamos isso nós
// mesmos em clinic_experts_config.professionals (jsonb), um item por
// profissional selecionado, cada um com seu próprio business_hours_json (mesmo
// formato usado pelo componente BusinessHoursEditor do embed / pelas agendas
// Google). listClinicExpertsSlots usa esse expediente pra (a) não gastar
// chamada de API em dias que o profissional não atende e (b) filtrar horários
// fora da janela configurada, já que a API não garante isso sozinha.
import { getSelfhost } from "@/integrations/selfhost/client.server";
import { decryptValue } from "@/lib/crypto.server";
import {
  diaSemanaChave,
  parseDisponibilidadeFromSettings,
  type Disponibilidade,
} from "./google-calendar.server";

interface ClinicExpertsProfessionalConfig {
  uuid: string;
  name: string;
  duracaoMinutos?: number;
  businessHoursJson?: string;
}

interface ClinicExpertsConfig {
  apiToken: string; // Bearer
  procedureId: number | null;
  procedureName: string | null;
  duracaoConsulta: number; // fallback quando o profissional não tem duração própria
  professionals: ClinicExpertsProfessionalConfig[];
  baseUrl: string;
}

const DEFAULT_BASE = "https://api.clinicaexperts.com.br/api/v1";
const CE_TIMEOUT_MS = 20_000;
const TZ = "America/Sao_Paulo";

function fetchCe(url: string, init?: RequestInit): Promise<Response> {
  return fetch(url, { ...init, signal: AbortSignal.timeout(CE_TIMEOUT_MS) });
}

async function loadConfig(accountId: string): Promise<ClinicExpertsConfig> {
  const sb = getSelfhost();
  const { data, error } = await sb
    .from("clinic_experts_config")
    .select("api_token_enc, procedure_id, procedure_name, duracao_consulta, professionals, ativo")
    .eq("account_id", accountId)
    .single();

  if (error || !data) throw new Error("Clinic Experts não configurado para esta conta");
  if (!data.ativo) throw new Error("Clinic Experts não está ativo para esta conta");

  const apiToken = await decryptValue(data.api_token_enc as unknown as string);
  if (!apiToken) throw new Error("Token Clinic Experts inválido");

  const rawProfs = data.professionals as unknown;
  const professionals: ClinicExpertsProfessionalConfig[] = Array.isArray(rawProfs)
    ? (rawProfs as Record<string, unknown>[])
        .map((p) => ({
          uuid: String(p.uuid ?? ""),
          name: String(p.name ?? ""),
          duracaoMinutos: typeof p.duracao_minutos === "number" ? p.duracao_minutos : undefined,
          businessHoursJson:
            typeof p.business_hours_json === "string" ? p.business_hours_json : undefined,
        }))
        .filter((p) => p.uuid)
    : [];

  return {
    apiToken,
    procedureId: typeof data.procedure_id === "number" ? data.procedure_id : null,
    procedureName: (data.procedure_name as string | null) ?? null,
    duracaoConsulta: (data.duracao_consulta as number | null) ?? 40,
    professionals,
    baseUrl: DEFAULT_BASE,
  };
}

function authHeaders(config: ClinicExpertsConfig) {
  return {
    Authorization: `Bearer ${config.apiToken}`,
    "Content-Type": "application/json",
    accept: "application/json",
  };
}

/** Extrai o array `data` de qualquer envelope comum da API (array direto, {data:[]}, {items:[]}). */
function extractDataArray(json: unknown): Record<string, unknown>[] {
  if (Array.isArray(json)) return json as Record<string, unknown>[];
  if (!json || typeof json !== "object") return [];
  const obj = json as Record<string, unknown>;
  const candidate = obj.data ?? obj.items ?? obj.professionals ?? obj.procedures ?? obj.bookings;
  return Array.isArray(candidate) ? (candidate as Record<string, unknown>[]) : [];
}

// ── Profissionais ────────────────────────────────────────────────────────

export interface ClinicExpertsProfessional {
  uuid: string;
  name: string;
}

export async function listClinicExpertsProfessionals(
  accountId: string,
): Promise<ClinicExpertsProfessional[]> {
  const config = await loadConfig(accountId);

  const url = new URL(`${config.baseUrl}/professionals`);
  url.searchParams.set("per_page", "100");

  const res = await fetchCe(url.toString(), { headers: authHeaders(config) });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Clinic Experts professionals failed: ${res.status} — ${err.slice(0, 300)}`);
  }

  const json = (await res.json()) as unknown;
  return extractDataArray(json)
    .map((p) => ({
      uuid: String(p.uuid ?? ""),
      name: String(p.name ?? [p.first_name, p.last_name].filter(Boolean).join(" ") ?? ""),
    }))
    .filter((p) => p.uuid);
}

// ── Procedimentos ────────────────────────────────────────────────────────

export interface ClinicExpertsProcedure {
  id: number;
  name: string;
  durationMinutes?: number;
}

export async function listClinicExpertsProcedures(
  accountId: string,
): Promise<ClinicExpertsProcedure[]> {
  const config = await loadConfig(accountId);

  const url = new URL(`${config.baseUrl}/procedures`);
  url.searchParams.set("per_page", "100");

  const res = await fetchCe(url.toString(), { headers: authHeaders(config) });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Clinic Experts procedures failed: ${res.status} — ${err.slice(0, 300)}`);
  }

  const json = (await res.json()) as unknown;
  return extractDataArray(json)
    .map((p) => ({
      id: Number(p.id),
      name: String(p.name ?? ""),
      durationMinutes: typeof p.duration === "number" ? p.duration : undefined,
    }))
    .filter((p) => p.id && p.name);
}

// ── Horários disponíveis ─────────────────────────────────────────────────

export interface ClinicExpertsSlot {
  start: string; // ISO 8601 -03:00
  end: string;
  professionalUuid: string;
  localDate: string; // YYYY-MM-DD
  fromTime: string; // HH:MM
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
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startD) || !/^\d{4}-\d{2}-\d{2}$/.test(endD)) return [];

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
  return `${date}T${hhmm}:00-03:00`; // offset fixo BRT, mesma convenção do clinicorp.server.ts
}

function timeToMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

/** true quando `time` (HH:MM) cai dentro de algum bloco [inicio,fim) do dia. */
function withinBlocks(time: string, blocks: Disponibilidade[string]): boolean {
  if (!blocks?.length) return false;
  const t = timeToMinutes(time);
  return blocks.some((b) => {
    const start = timeToMinutes(b.inicio);
    let end = timeToMinutes(b.fim);
    if (end === 0) end = 1440; // "00:00" de fim = meia-noite
    return t >= start && t < end;
  });
}

function addMinutesToTime(hhmm: string, minutes: number): string {
  const total = timeToMinutes(hhmm) + minutes;
  const h = Math.floor(total / 60) % 24;
  const m = total % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

async function fetchAvailableHoursForDay(
  config: ClinicExpertsConfig,
  prof: ClinicExpertsProfessionalConfig,
  date: string,
): Promise<ClinicExpertsSlot[]> {
  const url = new URL(`${config.baseUrl}/available-hours`);
  url.searchParams.set("professional_uuid", prof.uuid);
  url.searchParams.set("date", date);
  if (config.procedureId) url.searchParams.set("procedure_id", String(config.procedureId));

  const res = await fetchCe(url.toString(), { headers: authHeaders(config) });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Clinic Experts available-hours failed: ${res.status} — ${err.slice(0, 200)}`);
  }

  const json = (await res.json()) as unknown;
  const times: string[] = Array.isArray(json)
    ? (json as unknown[]).map((t) => String(t)).filter((t) => /^\d{1,2}:\d{2}$/.test(t))
    : [];

  const disponibilidade = parseDisponibilidadeFromSettings(prof.businessHoursJson);
  const dayKey = diaSemanaChave(new Date(`${date}T12:00:00-03:00`));
  const blocks = disponibilidade[dayKey];
  const duracao = prof.duracaoMinutos ?? config.duracaoConsulta;

  return times
    .filter((t) => !blocks?.length || withinBlocks(t, blocks)) // sem blocks configurados = confia 100% na API
    .map((t) => {
      const toTime = addMinutesToTime(t, duracao);
      return {
        start: slotIsoInBrazil(date, t),
        end: slotIsoInBrazil(date, toTime),
        professionalUuid: prof.uuid,
        localDate: date,
        fromTime: t,
        toTime,
      };
    });
}

export async function listClinicExpertsSlots(
  accountId: string,
  from: string,
  to: string,
): Promise<ClinicExpertsSlot[]> {
  const config = await loadConfig(accountId);
  if (config.professionals.length === 0) return [];
  const dates = enumerateDates(from, to);
  if (!dates.length) return [];

  const tasks: Promise<ClinicExpertsSlot[]>[] = [];
  for (const prof of config.professionals) {
    const disponibilidade = parseDisponibilidadeFromSettings(prof.businessHoursJson);
    const hasAnyConfiguredDay = Object.values(disponibilidade).some((b) => (b?.length ?? 0) > 0);
    for (const date of dates) {
      // Sem expediente configurado pra esse profissional = não sabemos os dias
      // dele, então consulta todos; com expediente, pula dias sem bloco ativo
      // (evita chamada de API desperdiçada).
      if (hasAnyConfiguredDay) {
        const dayKey = diaSemanaChave(new Date(`${date}T12:00:00-03:00`));
        if (!disponibilidade[dayKey]?.length) continue;
      }
      tasks.push(fetchAvailableHoursForDay(config, prof, date).catch(() => []));
    }
  }

  const perCall = await Promise.all(tasks);
  let merged = perCall.flat();

  const seen = new Set<string>();
  merged = merged.filter((s) => {
    const key = `${s.localDate}|${s.fromTime}|${s.professionalUuid}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return merged.sort((a, b) => a.start.localeCompare(b.start));
}

// ── Paciente ──────────────────────────────────────────────────────────────

export interface ClinicExpertsPatient {
  uuid: string;
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

async function fetchPatientByPhone(
  config: ClinicExpertsConfig,
  phoneValue: string,
): Promise<ClinicExpertsPatient | null> {
  const url = new URL(`${config.baseUrl}/patients`);
  url.searchParams.set("phone", phoneValue);

  const res = await fetchCe(url.toString(), { headers: authHeaders(config) });
  if (!res.ok) {
    // Não lança (o caller tenta várias variantes de telefone e trata "não
    // encontrado" como sinal pra criar o paciente) — mas loga o corpo real do
    // erro, senão uma falha de validação vira silenciosamente "não encontrado"
    // e mascara bugs (caso real: /professionals 422 por causa de active=true).
    const err = await res.text();
    console.warn(
      `[clinic-experts] busca de paciente falhou (${res.status}): ${err.slice(0, 200)}`,
    );
    return null;
  }

  const json = (await res.json()) as unknown;
  const rows = extractDataArray(json);
  const row = rows[0];
  if (!row?.uuid) return null;
  return {
    uuid: String(row.uuid),
    name: String(row.name ?? ""),
    phone: String(row.phone ?? phoneValue),
  };
}

export async function findClinicExpertsPatient(
  accountId: string,
  phone: string,
): Promise<ClinicExpertsPatient | null> {
  const config = await loadConfig(accountId);
  for (const variant of phoneVariantsForPatientGet(phone)) {
    const found = await fetchPatientByPhone(config, variant);
    if (found?.uuid) return found;
  }
  return null;
}

async function createClinicExpertsPatient(
  config: ClinicExpertsConfig,
  params: { name: string; phone: string },
): Promise<string | null> {
  const res = await fetchCe(`${config.baseUrl}/patients`, {
    method: "POST",
    headers: authHeaders(config),
    body: JSON.stringify({ name: params.name, phone: params.phone }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Clinic Experts create patient failed: ${res.status} ${err.slice(0, 200)}`);
  }
  const json = (await res.json()) as unknown;
  const row = (json && typeof json === "object" ? (json as Record<string, unknown>).data ?? json : {}) as Record<
    string,
    unknown
  >;
  return typeof row.uuid === "string" ? row.uuid : null;
}

// ── Agendamento ───────────────────────────────────────────────────────────

export interface AppointmentResult {
  id: string;
  datetime: string;
  patientName: string;
}

function extractSpTime(isoStr: string): { localDate: string; localTime: string } {
  const d = new Date(isoStr);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "00";
  return {
    localDate: `${get("year")}-${get("month")}-${get("day")}`,
    localTime: `${get("hour")}:${get("minute")}`,
  };
}

export async function createClinicExpertsAppointment(
  accountId: string,
  params: {
    phone: string;
    name: string;
    datetime: string; // ISO 8601
    endDatetime?: string; // ISO 8601
    professionalUuid?: string; // sobrescreve o único profissional configurado
    notes?: string;
  },
): Promise<AppointmentResult> {
  const config = await loadConfig(accountId);

  const professionalUuid =
    params.professionalUuid ??
    (config.professionals.length === 1 ? config.professionals[0].uuid : undefined);
  if (!professionalUuid) {
    throw new Error(
      "Clinic Experts: profissional não identificado (selected slot sem professional_uuid e conta tem múltiplos profissionais configurados)",
    );
  }
  if (!config.procedureId) {
    throw new Error("Clinic Experts: procedimento padrão não configurado (procedure_id ausente)");
  }

  // 1. Busca ou cria paciente
  let patient = await findClinicExpertsPatient(accountId, params.phone);
  let patientUuid = patient?.uuid ?? null;
  if (!patientUuid) {
    patientUuid = await createClinicExpertsPatient(config, { name: params.name, phone: params.phone });
  }
  if (!patientUuid) throw new Error("Não foi possível obter uuid do paciente Clinic Experts");

  // 2. starts_at / ends_at no formato exigido (offset -03:00 explícito)
  const { localDate, localTime: fromTime } = extractSpTime(params.datetime);
  const prof = config.professionals.find((p) => p.uuid === professionalUuid);
  const duracao = prof?.duracaoMinutos ?? config.duracaoConsulta;
  const toTime = params.endDatetime
    ? extractSpTime(params.endDatetime).localTime
    : addMinutesToTime(fromTime, duracao);

  const startsAt = slotIsoInBrazil(localDate, fromTime);
  const endsAt = slotIsoInBrazil(localDate, toTime);

  const body: Record<string, unknown> = {
    starts_at: startsAt,
    ends_at: endsAt,
    status: "scheduled",
    patient: patientUuid,
    professional: professionalUuid,
    procedures: [config.procedureId],
  };
  const notes = (params.notes ?? "").trim();
  if (notes) body.annotation = notes.slice(0, 500);

  console.log("[clinic-experts] create booking body:", JSON.stringify(body));

  // A doc oficial descreve a resposta de sucesso como "objeto vazio" — igual ao
  // que já vimos no Clinicorp acontecer às vezes, tratamos com a MESMA
  // reconciliação: se não vier uuid na resposta, buscamos o booking recém
  // criado por paciente+profissional+horário antes de decidir se falhou.
  const res = await fetchCe(`${config.baseUrl}/bookings`, {
    method: "POST",
    headers: authHeaders(config),
    body: JSON.stringify(body),
  });
  const rawBody = await res.text();
  if (!res.ok) {
    throw new Error(`Clinic Experts create booking failed: ${res.status} — ${rawBody.slice(0, 300)}`);
  }

  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(rawBody) as Record<string, unknown>;
  } catch {
    json = {};
  }
  const dataObj = (json.data as Record<string, unknown> | undefined) ?? json;
  let apptUuid = typeof dataObj.uuid === "string" ? dataObj.uuid : "";

  if (!apptUuid) {
    console.warn("[clinic-experts] resposta de create sem uuid — reconciliando via GET /bookings");
    apptUuid = await reconcileCreatedBookingUuid(config, {
      patientUuid,
      professionalUuid,
      startsAt,
      endsAt,
    });
  }
  if (!apptUuid) {
    throw new Error("Clinic Experts: agendamento não confirmado (resposta sem uuid e reconciliação falhou)");
  }

  return { id: apptUuid, datetime: startsAt, patientName: patient?.name ?? params.name };
}

async function reconcileCreatedBookingUuid(
  config: ClinicExpertsConfig,
  args: { patientUuid: string; professionalUuid: string; startsAt: string; endsAt: string },
): Promise<string> {
  try {
    const url = new URL(`${config.baseUrl}/bookings`);
    url.searchParams.set("patient", args.patientUuid);
    url.searchParams.set("professional", args.professionalUuid);
    url.searchParams.set("starts_at", args.startsAt);
    url.searchParams.set("ends_at", args.endsAt);
    const res = await fetchCe(url.toString(), { headers: authHeaders(config) });
    if (!res.ok) return "";
    const json = (await res.json()) as unknown;
    const rows = extractDataArray(json);
    const match = rows.find(
      (r) => r.starts_at === args.startsAt && r.status !== "canceled",
    );
    return typeof match?.uuid === "string" ? match.uuid : "";
  } catch (e) {
    console.error("[clinic-experts] reconciliação de booking falhou:", e);
    return "";
  }
}

/**
 * Cancela um agendamento pelo uuid. NUNCA usa /reschedule para cancelar (o
 * fluxo n8n de referência tinha esse bug — os dois endpoints da API são
 * distintos: PATCH /bookings/{uuid}/cancel e PATCH /bookings/{uuid}/reschedule).
 */
export async function cancelClinicExpertsAppointment(
  accountId: string,
  appointmentUuid: string,
  _reason?: string,
): Promise<{ ok: boolean; message: string }> {
  const config = await loadConfig(accountId);

  const res = await fetchCe(`${config.baseUrl}/bookings/${appointmentUuid}/cancel`, {
    method: "PATCH",
    headers: authHeaders(config),
  });
  if (!res.ok) {
    const err = await res.text();
    return { ok: false, message: `Erro ao cancelar: ${res.status} ${err.slice(0, 100)}` };
  }
  return { ok: true, message: "Agendamento cancelado com sucesso." };
}

// ── Warm-up: agendamentos próximos ───────────────────────────────────────

function normalizeBrPhone(raw: string): string {
  const digits = (raw || "").replace(/\D/g, "");
  if (digits.length >= 12 && digits.startsWith("55")) return digits.slice(2);
  return digits;
}

export async function listClinicExpertsUpcomingAppointments(
  accountId: string,
  from: string,
  to: string,
): Promise<{ id: string; start: string; patientName: string; phone: string; status: string }[]> {
  const config = await loadConfig(accountId);

  const url = new URL(`${config.baseUrl}/bookings`);
  url.searchParams.set("starts_at", `${from.slice(0, 10)}T00:00:00-03:00`);
  url.searchParams.set("ends_at", `${to.slice(0, 10)}T23:59:59-03:00`);

  const res = await fetchCe(url.toString(), { headers: authHeaders(config) });
  if (!res.ok) {
    const body = await res.text();
    console.error(`[clinic-experts] list upcoming falhou: ${res.status} — ${body.slice(0, 200)}`);
    return [];
  }

  const json = (await res.json()) as unknown;
  const rows = extractDataArray(json);

  return rows
    .filter((r) => r.status !== "canceled")
    .map((r) => {
      const patient = (r.patient as Record<string, unknown> | undefined) ?? {};
      return {
        id: String(r.uuid ?? ""),
        start: String(r.starts_at ?? ""),
        patientName: String(patient.name ?? ""),
        phone: normalizeBrPhone(String(patient.phone ?? "")),
        status: String(r.status ?? ""),
      };
    })
    .filter((a) => a.id && a.start);
}
