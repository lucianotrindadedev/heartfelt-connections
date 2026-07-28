// Clinup API integration: https://app.sistemaclinup.com.br/api/open
// Auth: Authorization header com o token direto (sem "Bearer")
// Phone format: remove não-dígitos e prefixo 55
import { getSelfhost } from "@/integrations/selfhost/client.server";
import { decryptValue } from "@/lib/crypto.server";
// Mesmos helpers de expediente do Clinic Experts/Google Calendar — o formato do
// business_hours_json é idêntico (BusinessHoursEditor do embed), então o filtro
// de dia/turno e a checagem de "a consulta INTEIRA cabe antes do fechamento"
// são reaproveitados em vez de reimplementados.
import { diaSemanaChave, parseDisponibilidadeFromSettings } from "./google-calendar.server";
import { withinBlocks } from "./clinic-experts.server";

const CLINUP_BASE = "https://app.sistemaclinup.com.br/api/open";

export interface ClinupProfessionalConfig {
  /** profissionalId do Clinup — INTEIRO (não uuid, ao contrário do Clinic Experts). */
  id: string;
  name: string;
  duracaoMinutos?: number;
  /** RESTRIÇÃO opcional. A API já devolve os horários reais do profissional;
   *  isto só estreita ("não ofereça este profissional fora destes dias/horas").
   *  Vazio = confia 100% na API. */
  businessHoursJson?: string;
}

interface ClinupConfig {
  apiToken: string;
  /** LEGADO: profissionalId único (agenda_id). Só usado quando `professionals`
   *  está vazio — contas antigas configuradas antes do suporte a vários. */
  profissionalId: string;
  duracaoConsulta: number;
  professionals: ClinupProfessionalConfig[];
}

async function loadConfig(accountId: string): Promise<ClinupConfig> {
  const sb = getSelfhost();
  const { data, error } = await sb
    .from("clinup_config")
    .select("api_token_enc, agenda_id, duracao_consulta, professionals, ativo")
    .eq("account_id", accountId)
    .single();

  if (error || !data) throw new Error("Clinup não configurado para esta conta");
  if (!data.ativo) throw new Error("Clinup não está ativo para esta conta");

  const apiToken = await decryptValue(data.api_token_enc as unknown as string);
  if (!apiToken) throw new Error("Token Clinup inválido");

  const rawProfs = data.professionals as unknown;
  const professionals: ClinupProfessionalConfig[] = Array.isArray(rawProfs)
    ? (rawProfs as Record<string, unknown>[])
        .map((p) => ({
          id: String(p.id ?? ""),
          name: String(p.name ?? ""),
          duracaoMinutos: typeof p.duracao_minutos === "number" ? p.duracao_minutos : undefined,
          businessHoursJson:
            typeof p.business_hours_json === "string" ? p.business_hours_json : undefined,
        }))
        .filter((p) => p.id)
    : [];

  return {
    apiToken,
    profissionalId: (data.agenda_id as string) ?? "",
    duracaoConsulta: (data.duracao_consulta as number) || 40,
    professionals,
  };
}

/**
 * Profissionais que o agente pode agendar. Usa os selecionados no painel; se
 * nenhum foi selecionado, cai no `agenda_id` legado (1 profissional).
 */
function resolveProfessionals(config: ClinupConfig): ClinupProfessionalConfig[] {
  if (config.professionals.length > 0) return config.professionals;
  if (config.profissionalId?.trim()) {
    return [{ id: config.profissionalId.trim(), name: "(profissional configurado)" }];
  }
  return [];
}

// ============================================================
// PROFISSIONAIS
// ============================================================

export interface ClinupProfessional {
  id: string;
  name: string;
}

/**
 * Lista os profissionais da clínica. GET /profissionais devolve um ARRAY CRU
 * (sem envelope): [{"nome":"Ariane Lopes","id":3497}, …] — confirmado contra a
 * API real em 28/07.
 *
 * Por que isto importa: a API NÃO valida o profissionalId nas buscas de
 * horário. Um id inexistente (testado com 999999) devolve uma grade cheia em
 * vez de erro — ou seja, um id digitado errado ofertaria horários que não são
 * de ninguém, silenciosamente. Selecionar da lista real elimina esse risco.
 */
export async function listClinupProfessionals(
  accountId: string,
): Promise<ClinupProfessional[]> {
  const config = await loadConfig(accountId);

  const res = await fetch(`${CLINUP_BASE}/profissionais`, { headers: authHeaders(config) });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Clinup listar profissionais failed: ${res.status} — ${err.slice(0, 200)}`);
  }

  const json = (await res.json()) as
    | { id?: number | string; nome?: string; name?: string }[]
    | { profissionais?: { id?: number | string; nome?: string }[] }
    | null;
  const lista = Array.isArray(json)
    ? json
    : ((json as { profissionais?: { id?: number | string; nome?: string }[] })?.profissionais ?? []);

  return lista
    .map((p) => ({ id: String(p.id ?? ""), name: String(p.nome ?? (p as { name?: string }).name ?? "") }))
    .filter((p) => p.id);
}

function authHeaders(config: ClinupConfig): Record<string, string> {
  return {
    Authorization: config.apiToken,
    "Content-Type": "application/json",
  };
}

function sanitizePhone(phone: string): string {
  return phone.replace(/\D/g, "").replace(/^55/, "");
}

const TZ = "America/Sao_Paulo";

/** Data e hora de um ISO qualquer, no fuso da clínica. */
function extractSpDateTime(isoStr: string): { localDate: string; localTime: string } {
  const d = new Date(isoStr);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "00";
  return {
    localDate: `${get("year")}-${get("month")}-${get("day")}`,
    localTime: `${get("hour")}:${get("minute")}:${get("second")}`,
  };
}

/** ISO com offset BRT fixo — mesma convenção de clinicorp/clinic-experts. */
function slotIsoInBrazil(date: string, time: string): string {
  const hhmmss = time.length >= 8 ? time.slice(0, 8) : `${time.slice(0, 5)}:00`;
  return `${date}T${hhmmss}-03:00`;
}

// ============================================================
// PACIENTES
// ============================================================

export interface ClinupPatient {
  id: string | null;
  name: string;
  phone: string;
  email: string | null;
}

interface ClinupPacienteRaw {
  id?: string | number;
  nome?: string;
  /** A API usa `celular1` (não `celular`, que é o nome do parâmetro de BUSCA). */
  celular1?: string;
  celular?: string;
  cpf?: string;
  email?: string;
}

/**
 * Extrai o paciente de qualquer formato de resposta.
 *
 * A API do Clinup ENVELOPA tudo, e cada endpoint com uma chave diferente:
 * {datas:[…]}, {horas:[…]}, {consultas:[…]} e — medido em 28/07 —
 * {"paciente":{…}} aqui. Lendo `json.id` direto no envelope, o id vinha
 * sempre undefined: findClinupPatient devolvia null para TODO mundo, o
 * agendamento partia para criar um paciente que já existia, e a criação
 * também não achava o id → "Não foi possível obter ID do paciente Clinup".
 * Caso real: Implanto Master Venda Nova, 32991607088, 28/07.
 */
function extrairPaciente(json: unknown): ClinupPacienteRaw | null {
  if (!json || typeof json !== "object") return null;
  if (Array.isArray(json)) return (json[0] as ClinupPacienteRaw) ?? null;
  const o = json as Record<string, unknown>;
  const candidato = (o.paciente ?? o.Paciente ?? o.data ?? o) as ClinupPacienteRaw | null;
  if (!candidato || typeof candidato !== "object") return null;
  return candidato.id != null ? candidato : null;
}

/** Nome comparável: sem acento, sem pontuação, minúsculo, espaços colapsados. */
function normalizarNome(n: string): string {
  return (n ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * TODOS os pacientes de um telefone. GET /pacientes (plural) devolve
 * {"pacientes":[…]}; o singular devolve só o PRIMEIRO — e o primeiro pode ser
 * outra pessoa da mesma casa. Medido em 28/07: o telefone 32991607088 tinha 7
 * cadastros, e o singular devolvia "Maria do Carmo" para um lead chamado
 * Luciano.
 */
async function listarPacientesPorTelefone(
  config: ClinupConfig,
  celular: string,
): Promise<ClinupPacienteRaw[]> {
  const url = `${CLINUP_BASE}/pacientes?celular=${encodeURIComponent(celular)}`;
  const res = await fetch(url, { headers: authHeaders(config) });
  if (!res.ok) return [];
  const json = (await res.json()) as
    | ClinupPacienteRaw[]
    | { pacientes?: ClinupPacienteRaw[] }
    | null;
  const lista = Array.isArray(json)
    ? json
    : ((json as { pacientes?: ClinupPacienteRaw[] })?.pacientes ?? []);
  return lista.filter((p) => p?.id != null);
}

/**
 * Paciente do lead. Quando o `name` é informado, o cadastro com o MESMO nome
 * vence — um telefone de família tem vários cadastros e agendar no primeiro
 * marcaria a consulta para a pessoa errada.
 *
 * Reaproveitar o cadastro certo também é o que impede a enxurrada de
 * duplicatas: quando a criação falhava por parsing, cada retentativa criava
 * outro paciente (6 "Luciano Trindade" no mesmo telefone, 28/07). Achando o
 * recém-criado, a retentativa reusa em vez de multiplicar.
 */
export async function findClinupPatient(
  accountId: string,
  phone: string,
  name?: string,
): Promise<ClinupPatient | null> {
  const config = await loadConfig(accountId);
  const celular = sanitizePhone(phone);

  const lista = await listarPacientesPorTelefone(config, celular);

  let p: ClinupPacienteRaw | null = null;
  const alvo = normalizarNome(name ?? "");
  if (alvo) {
    p =
      lista.find((c) => normalizarNome(c.nome ?? "") === alvo) ??
      // Cadastro abreviado ("Luciano T.") ou o lead informando o nome completo
      // depois: aceita quando um contém o outro, desde que não seja trivial.
      lista.find((c) => {
        const n = normalizarNome(c.nome ?? "");
        return n.length >= 5 && (n.startsWith(alvo) || alvo.startsWith(n));
      }) ??
      null;
    // Sem nenhum cadastro com esse nome, NÃO reutiliza o de outra pessoa:
    // devolve null para o chamador criar o cadastro correto.
    if (!p) return null;
  } else {
    // Sem nome coletado ainda (ex.: buscar_paciente no início da conversa):
    // devolve o primeiro, só para informar o agente. O agendamento sempre
    // acontece com o nome já em mãos.
    p = lista[0] ?? null;
  }

  if (!p?.id) return null;

  if (lista.length > 1) {
    console.warn(
      `[clinup] telefone ${celular} tem ${lista.length} cadastros — usando id=${p.id} (${p.nome ?? "?"})`,
    );
  }

  return {
    id: String(p.id),
    name: p.nome ?? "",
    phone: p.celular1 ?? p.celular ?? phone,
    email: p.email ?? null,
  };
}

export async function createClinupPatient(
  accountId: string,
  params: { name: string; phone: string },
): Promise<ClinupPatient> {
  const config = await loadConfig(accountId);

  const res = await fetch(`${CLINUP_BASE}/paciente`, {
    method: "POST",
    headers: authHeaders(config),
    body: JSON.stringify({
      nome: params.name,
      celular: sanitizePhone(params.phone),
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Clinup criar paciente failed: ${res.status} ${err.slice(0, 200)}`);
  }

  // Mesmo envelope da busca. Se o id não vier, NÃO devolvemos id:null: quem
  // chama só sabe dizer "não foi possível obter ID", uma mensagem que não
  // ajuda ninguém a descobrir o porquê. Falha aqui, com o corpo real.
  const bruto = await res.json();
  const p = extrairPaciente(bruto);
  if (!p?.id) {
    throw new Error(
      `Clinup: paciente criado mas a resposta não trouxe id (${JSON.stringify(bruto).slice(0, 250)})`,
    );
  }

  return {
    id: String(p.id),
    name: p.nome ?? params.name,
    phone: p.celular1 ?? p.celular ?? params.phone,
    email: null,
  };
}

// ============================================================
// DISPONIBILIDADE
// ============================================================

export interface ClinupSlot {
  date: string; // YYYY-MM-DD
  time: string; // HH:MM:SS
  profissionalId: string;
  professionalName?: string;
}

/**
 * Datas disponíveis, normalizadas para YYYY-MM-DD.
 *
 * A API devolve timestamp UTC completo — `{"datas":["2026-07-28T00:00:00Z",…]}`
 * (medido contra a API real em 28/07). Sem o corte, o valor era concatenado
 * cru mais adiante e produzia "2026-07-28T00:00:00ZT15:30:00", uma data
 * inválida que derrubava a montagem do slot inteiro.
 */
async function fetchDatasDoProfissional(
  config: ClinupConfig,
  profissionalId: string,
  fromDate: string,
): Promise<string[]> {
  const url = `${CLINUP_BASE}/datas?profissionalId=${encodeURIComponent(profissionalId)}&data=${encodeURIComponent(fromDate)}`;
  const res = await fetch(url, { headers: authHeaders(config) });
  if (!res.ok) throw new Error(`Clinup buscar datas failed: ${res.status}`);

  const json = (await res.json()) as string[] | { datas?: string[] } | null;
  const raw = Array.isArray(json) ? json : ((json as { datas?: string[] })?.datas ?? []);
  return raw.map((d) => String(d).slice(0, 10)).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d));
}

/** Datas disponíveis do PRIMEIRO profissional habilitado (compat). */
export async function listClinupAvailableDates(
  accountId: string,
  fromDate: string,
): Promise<string[]> {
  const config = await loadConfig(accountId);
  const profs = resolveProfessionals(config);
  if (profs.length === 0) {
    // A API aceita a chamada SEM profissionalId e responde {"datas":[]} com
    // status 200 — silêncio que viraria "não temos vaga" para o lead em vez de
    // "a integração está mal configurada".
    throw new Error(
      "Clinup: nenhum profissional habilitado nesta conta (painel de Integrações → Clinup)",
    );
  }
  return fetchDatasDoProfissional(config, profs[0]!.id, fromDate);
}

async function fetchHorasDoProfissional(
  config: ClinupConfig,
  prof: ClinupProfessionalConfig,
  date: string,
): Promise<ClinupSlot[]> {
  const url = `${CLINUP_BASE}/horas?profissionalId=${encodeURIComponent(prof.id)}&data=${encodeURIComponent(date)}`;
  const res = await fetch(url, { headers: authHeaders(config) });
  if (!res.ok) throw new Error(`Clinup buscar horarios failed: ${res.status}`);

  // O campo é `horas`, NÃO `horarios`. Medido contra a API real (28/07):
  //   {"temHoras":true,"horas":["08:00:00","08:30:00",…]}
  // Lendo a chave errada, isto devolvia SEMPRE lista vazia — ou seja, o Clinup
  // nunca teria horário nenhum para oferecer, sem erro nenhum aparecer.
  const json = (await res.json()) as
    | string[]
    | { temHoras?: boolean; horas?: string[]; horarios?: string[] }
    | null;
  const times: string[] = Array.isArray(json)
    ? json
    : ((json as { horas?: string[] })?.horas ??
       (json as { horarios?: string[] })?.horarios ??
       []);

  // Expediente configurado = RESTRIÇÃO adicional (a API já filtra pela agenda
  // real do profissional). Sem expediente, confia 100% na API. Com expediente,
  // a consulta INTEIRA (início + duração) precisa caber num bloco — mesma regra
  // do Clinic Experts, para não ofertar horário que estoura o fim do turno.
  const disponibilidade = parseDisponibilidadeFromSettings(prof.businessHoursJson);
  const dayKey = diaSemanaChave(new Date(`${date}T12:00:00-03:00`));
  const blocks = disponibilidade[dayKey];
  const duracao = prof.duracaoMinutos ?? config.duracaoConsulta;

  return times
    .filter((t) => !blocks?.length || withinBlocks(t.slice(0, 5), blocks, duracao))
    .map((t) => ({
      date,
      time: t,
      profissionalId: prof.id,
      professionalName: prof.name,
    }));
}

/** Horários de TODOS os profissionais habilitados numa data. */
export async function listClinupSlots(
  accountId: string,
  date: string,
): Promise<ClinupSlot[]> {
  const config = await loadConfig(accountId);
  const profs = resolveProfessionals(config);
  if (profs.length === 0) {
    throw new Error(
      "Clinup: nenhum profissional habilitado nesta conta (painel de Integrações → Clinup)",
    );
  }

  const porProf = await Promise.all(
    profs.map((p) =>
      fetchHorasDoProfissional(config, p, date).catch((e) => {
        console.error(
          `[clinup] horários falharam conta=${accountId} prof=${p.id} data=${date}:`,
          e instanceof Error ? e.message : String(e),
        );
        return [] as ClinupSlot[];
      }),
    ),
  );
  return dedupPorDataHora(porProf.flat());
}

/**
 * Dedup por data+hora, SEM o profissional na chave.
 *
 * O lead nunca escolhe profissional (é implementação interna, igual
 * Clinicorp/Clinic Experts). Se dois profissionais têm o MESMO horário livre,
 * oferecer os dois como entradas idênticas (mesmo time_label, profissionalId
 * diferente) quebra a auto-seleção: o lead responde só "09:30", a heurística
 * acha 2 candidatos ambíguos e nunca preenche selected_slot_iso — a conversa
 * trava. Mantém o primeiro profissional livre naquele horário.
 */
function dedupPorDataHora(slots: ClinupSlot[]): ClinupSlot[] {
  const seen = new Set<string>();
  return slots
    .filter((s) => {
      const key = `${s.date}|${s.time}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => `${a.date}T${a.time}`.localeCompare(`${b.date}T${b.time}`));
}

// ============================================================
// CONSULTAS
// ============================================================

export interface ClinupAppointment {
  id: string | number;
  patientName: string;
  date: string;
  time: string;
  status: string;
}

export async function getClinupAppointments(
  accountId: string,
  pacienteId: string,
): Promise<ClinupAppointment[]> {
  const config = await loadConfig(accountId);

  const url = `${CLINUP_BASE}/consultas?pacienteId=${encodeURIComponent(pacienteId)}`;
  const res = await fetch(url, { headers: authHeaders(config) });
  if (!res.ok) return [];

  // A resposta vem ENVELOPADA: {"consultas":[…]} (medido em 28/07). O código
  // esperava um array cru e chamava .map direto no objeto — TypeError a cada
  // consulta de agendamento existente.
  type Consulta = {
    id?: string | number;
    data?: string;
    hora?: string;
    status?: string;
    paciente?: { nome?: string };
  };
  const json = (await res.json()) as Consulta[] | { consultas?: Consulta[] } | null;
  const lista: Consulta[] = Array.isArray(json)
    ? json
    : ((json as { consultas?: Consulta[] })?.consultas ?? []);

  return lista.map((c) => ({
    id: c.id ?? "",
    patientName: c.paciente?.nome ?? "",
    date: c.data ?? "",
    time: c.hora ?? "",
    status: c.status ?? "",
  }));
}

export async function createClinupAppointment(
  accountId: string,
  params: {
    phone: string;
    name: string;
    datetime: string; // ISO 8601 ou "YYYY-MM-DD HH:MM:SS"
    notes?: string;
    /** Profissional do slot escolhido. Obrigatório quando a conta tem mais de
     *  um habilitado — sem isto a consulta cairia no primeiro da lista, que
     *  pode nem atender naquele horário. */
    profissionalId?: string;
  },
): Promise<{ id: string; datetime: string; patientName: string; profissionalId: string }> {
  const config = await loadConfig(accountId);

  const profs = resolveProfessionals(config);
  const profissionalId =
    params.profissionalId?.trim() || (profs.length === 1 ? profs[0]!.id : "");
  if (!profissionalId) {
    throw new Error(
      profs.length === 0
        ? "Clinup: nenhum profissional habilitado nesta conta"
        : "Clinup: profissional não identificado (o slot escolhido não trouxe profissionalId e a conta tem vários habilitados)",
    );
  }

  // ── PACIENTE: buscar → criar se não houver → usar o id ───────────────────
  //
  // Nesta ordem, e SEMPRE dentro da criação da consulta — não como um passo
  // separado que dependa do LLM lembrar de chamar `buscar_paciente` antes. Foi
  // o que aconteceu no caso real de 28/07: o agente chamou só criar_agendamento
  // e a sequência precisou se sustentar sozinha aqui dentro.
  //
  // O NOME entra na busca de propósito: sem ele, um telefone com vários
  // cadastros devolveria o primeiro, e a consulta seria marcada para outra
  // pessoa da mesma casa.
  let patient = await findClinupPatient(accountId, params.phone, params.name);
  if (patient) {
    console.log(
      `[clinup] paciente ENCONTRADO conta=${accountId} id=${patient.id} nome="${patient.name}"`,
    );
  } else {
    console.log(
      `[clinup] paciente NÃO encontrado conta=${accountId} nome="${params.name}" — criando cadastro`,
    );
    patient = await createClinupPatient(accountId, { name: params.name, phone: params.phone });
    console.log(`[clinup] paciente CRIADO conta=${accountId} id=${patient.id}`);
  }

  if (!patient.id) throw new Error("Não foi possível obter ID do paciente Clinup");

  // Data e hora no fuso da CLÍNICA (America/Sao_Paulo).
  //
  // Antes: `toISOString()` (UTC) para a data + `toTimeString()` (fuso do
  // servidor) para a hora — duas referências diferentes na mesma consulta. Com
  // o servidor em UTC, um horário de 15:30 BRT virava 18:30 no Clinup; perto da
  // meia-noite a data também saía trocada.
  const { localDate: data, localTime: hora } = extractSpDateTime(params.datetime);

  // profissionalId vai como NÚMERO e pacienteId como STRING — é o formato que o
  // fluxo n8n de referência usa contra esta mesma API.
  const body: Record<string, unknown> = {
    profissionalId: Number(profissionalId),
    pacienteId: patient.id,
    data,
    hora,
  };
  if (params.notes) body.Observacao = params.notes;

  const res = await fetch(`${CLINUP_BASE}/consultas`, {
    method: "POST",
    headers: authHeaders(config),
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Clinup criar consulta failed: ${res.status} ${err.slice(0, 200)}`);
  }

  const json = (await res.json()) as {
    id?: string | number;
    consultaId?: string | number;
    data?: string;
    hora?: string;
    consulta?: { id?: string | number };
  };

  // Sem id no retorno, NÃO temos como provar que a consulta existe. Falhar aqui
  // é obrigatório: devolver "ok" sem appointment_id faria o agente dizer
  // "agendado" para o lead sem nada na agenda — exatamente a classe de bug que
  // a trava de confirmação falsa existe para impedir.
  const apptId = json.id ?? json.consultaId ?? json.consulta?.id;
  if (apptId == null || apptId === "") {
    throw new Error(
      `Clinup: agendamento não confirmado (POST /consultas respondeu sem id: ${JSON.stringify(json).slice(0, 200)})`,
    );
  }

  return {
    id: String(apptId),
    datetime: `${json.data ?? data} ${json.hora ?? hora}`,
    patientName: patient.name,
    profissionalId,
  };
}

export async function manageClinupAppointment(
  accountId: string,
  params: {
    consultaId: number | string;
    confirmada: boolean;
    motivo?: string;
  },
): Promise<boolean> {
  const config = await loadConfig(accountId);

  const res = await fetch(`${CLINUP_BASE}/consultas`, {
    method: "PUT",
    headers: authHeaders(config),
    body: JSON.stringify({
      consultaId: Number(params.consultaId),
      confirmada: params.confirmada,
      motivo: params.motivo ?? "",
    }),
  });

  return res.ok;
}

// Listagem de slots com range de datas (interface compatível com tool-registry)
export async function listClinupSlotsRange(
  accountId: string,
  from: string,
  to: string,
): Promise<{ start: string; end: string }[]> {
  const slots = await listClinupSlotsDetailed(accountId, from, to);
  return slots.map((s) => ({ start: s.start, end: s.end }));
}

export interface ClinupRangeSlot {
  start: string;
  end: string;
  profissionalId: string;
  professionalName?: string;
  date: string;
  time: string;
}

/**
 * Horários de todos os profissionais habilitados no intervalo, JÁ com o
 * profissionalId de cada slot — é este id que precisa chegar ao
 * criar_agendamento, senão a consulta seria criada para o profissional errado.
 */
export async function listClinupSlotsDetailed(
  accountId: string,
  from: string,
  to: string,
): Promise<ClinupRangeSlot[]> {
  const config = await loadConfig(accountId);
  const profs = resolveProfessionals(config);
  if (profs.length === 0) {
    // Erro de configuração PROPAGA de propósito: engolir aqui era o que fazia o
    // "Testar conexão" do painel responder OK com a integração quebrada.
    throw new Error(
      "Clinup: nenhum profissional habilitado nesta conta (painel de Integrações → Clinup)",
    );
  }

  const limite = to.slice(0, 10);
  const brutos: ClinupSlot[] = [];

  // Cada profissional tem a SUA lista de datas — um pode atender terça e outro
  // não. Buscar as datas por profissional evita gastar chamada de /horas em dia
  // que ele não atende.
  for (const prof of profs) {
    let datas: string[];
    try {
      datas = await fetchDatasDoProfissional(config, prof.id, from);
    } catch (e) {
      console.error(
        `[clinup] datas falharam conta=${accountId} prof=${prof.id}:`,
        e instanceof Error ? e.message : String(e),
      );
      continue;
    }

    const disponibilidade = parseDisponibilidadeFromSettings(prof.businessHoursJson);
    const temExpediente = Object.values(disponibilidade).some((b) => (b?.length ?? 0) > 0);

    const validas = datas
      .filter((d) => d <= limite)
      .filter((d) => {
        if (!temExpediente) return true;
        const dayKey = diaSemanaChave(new Date(`${d}T12:00:00-03:00`));
        return (disponibilidade[dayKey]?.length ?? 0) > 0;
      })
      .slice(0, 5);

    for (const date of validas) {
      try {
        brutos.push(...(await fetchHorasDoProfissional(config, prof, date)));
      } catch (e) {
        console.error(
          `[clinup] horários falharam conta=${accountId} prof=${prof.id} data=${date}:`,
          e instanceof Error ? e.message : String(e),
        );
      }
    }
  }

  return dedupPorDataHora(brutos).map((s) => {
    const prof = profs.find((p) => p.id === s.profissionalId);
    const duracao = prof?.duracaoMinutos ?? config.duracaoConsulta;
    const start = slotIsoInBrazil(s.date, s.time);
    return {
      start,
      end: new Date(new Date(start).getTime() + duracao * 60 * 1000).toISOString(),
      profissionalId: s.profissionalId,
      professionalName: s.professionalName,
      date: s.date,
      time: s.time,
    };
  });
}
