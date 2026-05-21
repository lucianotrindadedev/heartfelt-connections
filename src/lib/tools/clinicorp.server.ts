// Clinicorp API integration: agendamentos e pacientes
import { getSelfhost } from "@/integrations/selfhost/client.server";
import { decryptValue } from "@/lib/crypto.server";

interface ClinicorpConfig {
  apiToken: string;       // Basic auth base64
  subscriberId: string;
  businessId: number;
  codeLink: string | null;      // agenda_id: Code Link da agenda online (listing de slots)
  profissionalId: number | null; // dentist_person_id: Person_Id do profissional (opcional)
  baseUrl: string;
}

const DEFAULT_BASE = "https://api.clinicorp.com";

async function loadConfig(accountId: string): Promise<ClinicorpConfig> {
  const sb = getSelfhost();
  const { data, error } = await sb
    .from("clinicorp_config")
    .select("api_token_enc, subscriber_id, business_id, agenda_id, dentist_person_id, ativo")
    .eq("account_id", accountId)
    .single();

  if (error || !data) throw new Error("Clinicorp não configurado para esta conta");
  if (!data.ativo) throw new Error("Clinicorp não está ativo para esta conta");

  const apiToken = await decryptValue(data.api_token_enc as unknown as string);
  if (!apiToken) throw new Error("Token Clinicorp inválido");

  return {
    apiToken,
    subscriberId: data.subscriber_id as string,
    businessId: data.business_id as number,
    codeLink: (data.agenda_id as string | number | null)
      ? String(data.agenda_id)
      : null,
    profissionalId: (data.dentist_person_id as number | null) ?? null,
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

  const res = await fetch(
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

export async function listClinicorpSlots(
  accountId: string,
  from: string,
  to: string,
): Promise<ClinicorpSlot[]> {
  const config = await loadConfig(accountId);

  const url = new URL(`${config.baseUrl}/rest/v1/appointment/list`);
  url.searchParams.set("subscriber_id", config.subscriberId);
  url.searchParams.set("business_id", String(config.businessId));
  // Code Link da agenda online (libera horários para agendamento por API)
  if (config.codeLink) {
    url.searchParams.set("code_link", config.codeLink);
  }
  // Filtra por profissional se configurado
  if (config.profissionalId) {
    url.searchParams.set("dentist_person_id", String(config.profissionalId));
  }
  url.searchParams.set("date_from", from.slice(0, 10));
  url.searchParams.set("date_to", to.slice(0, 10));
  url.searchParams.set("available_only", "true");

  const res = await fetch(url.toString(), { headers: authHeaders(config) });
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

  const res = await fetch(url.toString(), { headers: authHeaders(config) });
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

  const res = await fetch(`${config.baseUrl}/rest/v1/patient/create`, {
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

export async function createClinicorpAppointment(
  accountId: string,
  params: {
    phone: string;
    name: string;
    datetime: string;   // ISO 8601 — usado para extrair date, fromTime
    endDatetime?: string; // ISO 8601 — usado para toTime (fallback +30 min)
    dentistPersonId?: number; // sobrescreve o profissional da config
  },
): Promise<AppointmentResult> {
  const config = await loadConfig(accountId);

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

  // 2. Extrai fromTime / toTime / date do ISO 8601
  const startDate = new Date(params.datetime);
  const endDate = params.endDatetime
    ? new Date(params.endDatetime)
    : new Date(startDate.getTime() + 30 * 60 * 1000);

  const pad = (n: number) => String(n).padStart(2, "0");
  const fromTime = `${pad(startDate.getUTCHours())}:${pad(startDate.getUTCMinutes())}`;
  const toTime   = `${pad(endDate.getUTCHours())}:${pad(endDate.getUTCMinutes())}`;
  // Meia-noite UTC do dia (formato que a API espera)
  const dateStr = startDate.toISOString().split("T")[0] + "T03:00:00.000Z";

  // 3. Dentist_PersonId: parâmetro passado > config > omite
  const dentistPersonId = params.dentistPersonId ?? config.profissionalId ?? undefined;

  const body: Record<string, unknown> = {
    Patient_PersonId: patientId,
    fromTime,
    toTime,
    date: dateStr,
    Clinic_BusinessId: config.businessId,
  };
  if (dentistPersonId) {
    body.Dentist_PersonId = dentistPersonId;
  }

  const res = await fetch(
    `${config.baseUrl}/rest/v1/appointment/create_appointment_by_api`,
    {
      method: "POST",
      headers: authHeaders(config),
      body: JSON.stringify(body),
    },
  );

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Clinicorp create appointment failed: ${res.status} ${err.slice(0, 200)}`);
  }

  const json = (await res.json()) as {
    appointment?: { id?: number | string; start_datetime?: string };
    Appointment?: { Id?: number | string; StartDateTime?: string };
  };

  const appt = json.appointment ?? json.Appointment;

  return {
    id: appt?.id ?? appt?.Id ?? "",
    datetime: appt?.start_datetime ?? appt?.StartDateTime ?? params.datetime,
    patientName: patient?.name ?? params.name,
  };
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
  if (config.profissionalId) url.searchParams.set("dentist_person_id", String(config.profissionalId));
  url.searchParams.set("date_from", from.slice(0, 10));
  url.searchParams.set("date_to", to.slice(0, 10));

  const res = await fetch(url.toString(), { headers: authHeaders(config) });
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
