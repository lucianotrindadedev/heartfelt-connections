// Clinicorp API integration: agendamentos e pacientes
import { getSelfhost } from "@/integrations/selfhost/client.server";
import { decryptValue } from "@/lib/crypto.server";

interface ClinicorpConfig {
  apiToken: string; // Basic auth base64
  subscriberId: string;
  businessId: number;
  profissionalId: number | null; // dentist_person_id — opcional
  baseUrl: string;
}

const DEFAULT_BASE = "https://api.clinicorp.com";

async function loadConfig(accountId: string): Promise<ClinicorpConfig> {
  const sb = getSelfhost();
  const { data, error } = await sb
    .from("clinicorp_config")
    .select("api_token_enc, subscriber_id, business_id, agenda_id, ativo")
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
    profissionalId: (data.agenda_id as number | null) ?? null,
    baseUrl: DEFAULT_BASE,
  };
}

function authHeaders(config: ClinicorpConfig) {
  return {
    Authorization: `Basic ${config.apiToken}`,
    "Content-Type": "application/json",
  };
}

export interface ClinicorpSlot {
  start: string; // ISO 8601
  end: string;
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
  // só filtra por profissional se estiver configurado
  if (config.profissionalId) {
    url.searchParams.set("dentist_person_id", String(config.profissionalId));
  }
  url.searchParams.set("date_from", from.slice(0, 10));
  url.searchParams.set("date_to", to.slice(0, 10));
  url.searchParams.set("available_only", "true");

  const res = await fetch(url.toString(), { headers: authHeaders(config) });
  if (!res.ok) throw new Error(`Clinicorp list failed: ${res.status}`);

  const json = (await res.json()) as {
    appointments?: { start_datetime?: string; end_datetime?: string }[];
  };

  return (json.appointments ?? []).map((a) => ({
    start: a.start_datetime ?? "",
    end: a.end_datetime ?? "",
  }));
}

export interface ClinicorpProfessional {
  id: number;
  name: string;
}

export async function listClinicorpProfessionals(
  accountId: string,
): Promise<ClinicorpProfessional[]> {
  const config = await loadConfig(accountId);

  const url = new URL(`${config.baseUrl}/rest/v1/dentist/list`);
  url.searchParams.set("subscriber_id", config.subscriberId);
  url.searchParams.set("business_id", String(config.businessId));

  const res = await fetch(url.toString(), { headers: authHeaders(config) });
  if (!res.ok) throw new Error(`Clinicorp professionals failed: ${res.status}`);

  const json = (await res.json()) as {
    dentists?: { person_id?: number; name?: string }[];
    data?: { person_id?: number; name?: string }[];
  };

  const list = json.dentists ?? json.data ?? [];
  return list
    .filter((d) => d.person_id)
    .map((d) => ({ id: d.person_id as number, name: d.name ?? "" }));
}

export interface ClinicorpPatient {
  id: number | null;
  name: string;
  phone: string;
  email: string | null;
}

export async function findClinicorpPatient(
  accountId: string,
  phone: string,
): Promise<ClinicorpPatient | null> {
  const config = await loadConfig(accountId);

  const url = new URL(`${config.baseUrl}/rest/v1/patient/get`);
  url.searchParams.set("subscriber_id", config.subscriberId);
  url.searchParams.set("business_id", String(config.businessId));
  url.searchParams.set("phone", phone.replace(/\D/g, ""));

  const res = await fetch(url.toString(), { headers: authHeaders(config) });
  if (!res.ok) return null;

  const json = (await res.json()) as {
    patient?: { id?: number; name?: string; phone?: string; email?: string };
  };
  if (!json.patient) return null;

  return {
    id: json.patient.id ?? null,
    name: json.patient.name ?? "",
    phone: json.patient.phone ?? phone,
    email: json.patient.email ?? null,
  };
}

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
    email?: string;
    datetime: string; // ISO 8601 (start)
    endDatetime?: string; // ISO 8601 (end) — opcional, padrão +30 min
  },
): Promise<AppointmentResult> {
  const config = await loadConfig(accountId);

  let patient = await findClinicorpPatient(accountId, params.phone);

  if (!patient) {
    // Cria paciente
    const createRes = await fetch(`${config.baseUrl}/rest/v1/patient/create`, {
      method: "POST",
      headers: authHeaders(config),
      body: JSON.stringify({
        subscriber_id: config.subscriberId,
        business_id: config.businessId,
        name: params.name,
        phone: params.phone.replace(/\D/g, ""),
        email: params.email ?? null,
      }),
    });
    if (!createRes.ok) throw new Error(`Clinicorp create patient failed: ${createRes.status}`);
    const created = (await createRes.json()) as { patient?: { id?: number } };
    patient = {
      id: created.patient?.id ?? null,
      name: params.name,
      phone: params.phone,
      email: params.email ?? null,
    };
  }

  // Usa end fornecido pelo agente, ou fallback de 30 min
  const endDatetime =
    params.endDatetime ??
    new Date(new Date(params.datetime).getTime() + 30 * 60 * 1000).toISOString();

  const body: Record<string, unknown> = {
    subscriber_id: config.subscriberId,
    business_id: config.businessId,
    patient_id: patient.id,
    start_datetime: params.datetime,
    end_datetime: endDatetime,
  };

  // Só passa dentist_person_id se profissional estiver configurado
  if (config.profissionalId) {
    body.dentist_person_id = config.profissionalId;
  }

  const res = await fetch(`${config.baseUrl}/rest/v1/appointment/create`, {
    method: "POST",
    headers: authHeaders(config),
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Clinicorp create appointment failed: ${res.status} ${err.slice(0, 200)}`);
  }

  const json = (await res.json()) as {
    appointment?: { id?: number | string; start_datetime?: string };
  };

  return {
    id: json.appointment?.id ?? "",
    datetime: json.appointment?.start_datetime ?? params.datetime,
    patientName: patient.name,
  };
}

// Busca agendamentos próximos para warm-up
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
  }[]
> {
  const config = await loadConfig(accountId);

  const url = new URL(`${config.baseUrl}/rest/v1/appointment/list`);
  url.searchParams.set("subscriber_id", config.subscriberId);
  url.searchParams.set("business_id", String(config.businessId));
  if (config.profissionalId) {
    url.searchParams.set("dentist_person_id", String(config.profissionalId));
  }
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
