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
    .select("api_token_enc, subscriber_id, business_id, agenda_id, dentist_person_id, duracao_consulta, ativo")
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

// ── Horários disponíveis ───────────────────────────────────────────────────

export interface ClinicorpSlot {
  start: string; // ISO 8601
  end: string;
  dentistPersonId?: number;
}

async function fetchSlots(
  config: ClinicorpConfig,
  from: string,
  to: string,
  dentistPersonId?: number,
): Promise<ClinicorpSlot[]> {
  const url = new URL(`${config.baseUrl}/rest/v1/appointment/list`);
  url.searchParams.set("subscriber_id", config.subscriberId);
  url.searchParams.set("business_id", String(config.businessId));
  if (config.codeLink) url.searchParams.set("code_link", config.codeLink);
  if (dentistPersonId) url.searchParams.set("dentist_person_id", String(dentistPersonId));
  url.searchParams.set("date_from", from.slice(0, 10));
  url.searchParams.set("date_to", to.slice(0, 10));
  url.searchParams.set("available_only", "true");

  const res = await fetchClinicorp(url.toString(), { headers: authHeaders(config) });
  if (!res.ok) throw new Error(`Clinicorp list failed: ${res.status}`);

  const json = (await res.json()) as {
    appointments?: {
      start_datetime?: string;
      end_datetime?: string;
      Dentist_PersonId?: number;
      dentist_person_id?: number;
    }[];
  };

  return (json.appointments ?? []).map((a) => ({
    start: a.start_datetime ?? "",
    end: a.end_datetime ?? "",
    dentistPersonId: a.Dentist_PersonId ?? a.dentist_person_id,
  }));
}

export async function listClinicorpSlots(
  accountId: string,
  from: string,
  to: string,
): Promise<ClinicorpSlot[]> {
  const config = await loadConfig(accountId);

  if (config.profissionalIds.length === 0) {
    // Nenhum profissional configurado — retorna todos os horários disponíveis
    return fetchSlots(config, from, to);
  }

  if (config.profissionalIds.length === 1) {
    // Um único profissional — passamos diretamente o filtro
    return fetchSlots(config, from, to, config.profissionalIds[0]);
  }

  // Múltiplos profissionais — requisições paralelas, merge e ordena por horário
  const results = await Promise.all(
    config.profissionalIds.map((id) => fetchSlots(config, from, to, id).catch(() => [])),
  );
  const merged = results.flat();
  // Remove duplicatas (mesmo start + mesmo dentist) e ordena
  const seen = new Set<string>();
  return merged
    .filter((s) => {
      const key = `${s.start}|${s.dentistPersonId ?? ""}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => a.start.localeCompare(b.start));
}

// ── Paciente ──────────────────────────────────────────────────────────────

export interface ClinicorpPatient {
  id: number | null;
  name: string;
  phone: string;
}

export async function findClinicorpPatient(
  accountId: string,
  phone: string,
): Promise<ClinicorpPatient | null> {
  const config = await loadConfig(accountId);

  // Normaliza: mantém o + se já tiver, senão adiciona +55
  const normalizedPhone = phone.startsWith("+")
    ? phone
    : `+55${phone.replace(/\D/g, "")}`;

  const url = new URL(`${config.baseUrl}/rest/v1/patient/get`);
  url.searchParams.set("subscriber_id", config.subscriberId);
  url.searchParams.set("Phone", normalizedPhone); // capital P

  const res = await fetchClinicorp(url.toString(), { headers: authHeaders(config) });
  if (!res.ok) return null;

  const json = (await res.json()) as {
    patient?: {
      Person_Id?: number;
      person_id?: number;
      id?: number;
      Name?: string;
      name?: string;
      Phone?: string;
      phone?: string;
    };
  };
  if (!json.patient) return null;

  const p = json.patient;
  const id = p.Person_Id ?? p.person_id ?? p.id ?? null;

  return {
    id: id as number | null,
    name: String(p.Name ?? p.name ?? ""),
    phone: String(p.Phone ?? p.phone ?? phone),
  };
}

async function createClinicorpPatient(
  config: ClinicorpConfig,
  params: { name: string; phone: string },
): Promise<number | null> {
  // Remove tudo exceto dígitos para MobilePhone (API espera número)
  const mobilePhone = Number(params.phone.replace(/\D/g, ""));

  const res = await fetchClinicorp(`${config.baseUrl}/rest/v1/patient/create`, {
    method: "POST",
    headers: authHeaders(config),
    body: JSON.stringify({
      subscriber_id: config.subscriberId,
      Name: params.name,
      MobilePhone: mobilePhone,
      IgnoreSameName: "X",
    }),
  });
  if (!res.ok) throw new Error(`Clinicorp create patient failed: ${res.status}`);

  const created = (await res.json()) as {
    patient?: { Person_Id?: number; person_id?: number; id?: number };
  };
  return created.patient?.Person_Id ?? created.patient?.person_id ?? created.patient?.id ?? null;
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
  },
): Promise<AppointmentResult> {
  const config = await loadConfig(accountId);

  // Duração da consulta: usa o valor configurado (default 40 min)
  const duracaoMin = config.duracaoConsulta;

  // 1. Busca ou cria paciente
  let patient = await findClinicorpPatient(accountId, params.phone);
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

  console.log("[clinicorp] create appointment body:", JSON.stringify(body));

  const res = await fetchClinicorp(
    `${config.baseUrl}/rest/v1/appointment/create_appointment_by_api`,
    {
      method: "POST",
      headers: authHeaders(config),
      body: JSON.stringify(body),
    },
  );

  if (!res.ok) {
    const err = await res.text();
    const msg = `Clinicorp create appointment failed: ${res.status} — ${err.slice(0, 300)}`;
    console.error("[clinicorp]", msg);
    throw new Error(msg);
  }

  const json = (await res.json()) as {
    appointment?: { id?: number | string; start_datetime?: string };
    Appointment?: { Id?: number | string; StartDateTime?: string };
  };

  const appt = json.appointment ?? json.Appointment;
  const apptId = (appt as { id?: number | string })?.id ?? (appt as { Id?: number | string })?.Id ?? "";
  const apptDt = (appt as { start_datetime?: string })?.start_datetime ?? (appt as { StartDateTime?: string })?.StartDateTime ?? params.datetime;

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

  // 2. Lista agendamentos filtrando pelo Patient_PersonId
  const url = new URL(`${config.baseUrl}/rest/v1/appointment/list`);
  url.searchParams.set("subscriber_id", config.subscriberId);
  url.searchParams.set("business_id", String(config.businessId));
  url.searchParams.set("patient_person_id", String(patient.id));

  const res = await fetchClinicorp(url.toString(), { headers: authHeaders(config) });
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

export async function listClinicorpUpcomingAppointments(
  accountId: string,
  from: string,
  to: string,
): Promise<{ id: number | string; start: string; patientName: string; phone: string; status: string }[]> {
  const config = await loadConfig(accountId);

  const url = new URL(`${config.baseUrl}/rest/v1/appointment/list`);
  url.searchParams.set("subscriber_id", config.subscriberId);
  url.searchParams.set("business_id", String(config.businessId));
  if (config.codeLink) url.searchParams.set("code_link", config.codeLink);
  if (config.profissionalIds.length === 1) {
    url.searchParams.set("dentist_person_id", String(config.profissionalIds[0]));
  }
  url.searchParams.set("date_from", from.slice(0, 10));
  url.searchParams.set("date_to", to.slice(0, 10));

  const res = await fetchClinicorp(url.toString(), { headers: authHeaders(config) });
  if (!res.ok) return [];

  const json = (await res.json()) as {
    appointments?: {
      id?: number | string;
      start_datetime?: string;
      patient_name?: string;
      patient_phone?: string;
      status?: string;
    }[];
  };

  return (json.appointments ?? []).map((a) => ({
    id: a.id ?? "",
    start: a.start_datetime ?? "",
    patientName: a.patient_name ?? "",
    phone: a.patient_phone ?? "",
    status: a.status ?? "",
  }));
}
