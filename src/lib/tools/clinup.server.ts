// Clinup API integration: https://app.sistemaclinup.com.br/api/open
// Auth: Authorization header com o token direto (sem "Bearer")
// Phone format: remove não-dígitos e prefixo 55
import { getSelfhost } from "@/integrations/selfhost/client.server";
import { decryptValue } from "@/lib/crypto.server";

const CLINUP_BASE = "https://app.sistemaclinup.com.br/api/open";

interface ClinupConfig {
  apiToken: string;
  profissionalId: string; // agenda_id usado como profissionalId
  duracaoConsulta: number;
}

async function loadConfig(accountId: string): Promise<ClinupConfig> {
  const sb = getSelfhost();
  const { data, error } = await sb
    .from("clinup_config")
    .select("api_token_enc, agenda_id, duracao_consulta, ativo")
    .eq("account_id", accountId)
    .single();

  if (error || !data) throw new Error("Clinup não configurado para esta conta");
  if (!data.ativo) throw new Error("Clinup não está ativo para esta conta");

  const apiToken = await decryptValue(data.api_token_enc as unknown as string);
  if (!apiToken) throw new Error("Token Clinup inválido");

  return {
    apiToken,
    profissionalId: data.agenda_id as string,
    duracaoConsulta: (data.duracao_consulta as number) || 40,
  };
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

// ============================================================
// PACIENTES
// ============================================================

export interface ClinupPatient {
  id: string | null;
  name: string;
  phone: string;
  email: string | null;
}

export async function findClinupPatient(
  accountId: string,
  phone: string,
): Promise<ClinupPatient | null> {
  const config = await loadConfig(accountId);
  const celular = sanitizePhone(phone);

  const url = `${CLINUP_BASE}/paciente?celular=${encodeURIComponent(celular)}`;
  const res = await fetch(url, { headers: authHeaders(config) });
  if (!res.ok) return null;

  const json = (await res.json()) as
    | { id?: string | number; nome?: string; celular?: string; email?: string }
    | { id?: string | number; nome?: string; celular?: string; email?: string }[]
    | null;

  if (!json) return null;

  // Pode retornar objeto ou array
  const p = Array.isArray(json) ? json[0] : json;
  if (!p?.id) return null;

  return {
    id: String(p.id),
    name: p.nome ?? "",
    phone: p.celular ?? phone,
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

  const json = (await res.json()) as { id?: string | number; nome?: string; celular?: string };
  return {
    id: json.id ? String(json.id) : null,
    name: json.nome ?? params.name,
    phone: json.celular ?? params.phone,
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
}

export async function listClinupAvailableDates(
  accountId: string,
  fromDate: string,
): Promise<string[]> {
  const config = await loadConfig(accountId);

  const url = `${CLINUP_BASE}/datas?profissionalId=${config.profissionalId}&data=${fromDate}`;
  const res = await fetch(url, { headers: authHeaders(config) });
  if (!res.ok) throw new Error(`Clinup buscar datas failed: ${res.status}`);

  const json = (await res.json()) as string[] | { datas?: string[] } | null;
  if (Array.isArray(json)) return json;
  return (json as { datas?: string[] })?.datas ?? [];
}

export async function listClinupSlots(
  accountId: string,
  date: string,
): Promise<ClinupSlot[]> {
  const config = await loadConfig(accountId);

  const url = `${CLINUP_BASE}/horas?profissionalId=${config.profissionalId}&data=${date}`;
  const res = await fetch(url, { headers: authHeaders(config) });
  if (!res.ok) throw new Error(`Clinup buscar horarios failed: ${res.status}`);

  const json = (await res.json()) as string[] | { horarios?: string[] } | null;
  const times: string[] = Array.isArray(json) ? json : ((json as { horarios?: string[] })?.horarios ?? []);

  return times.map((t) => ({
    date,
    time: t,
    profissionalId: config.profissionalId,
  }));
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

  const json = (await res.json()) as
    | { id?: string | number; data?: string; hora?: string; status?: string; paciente?: { nome?: string } }[]
    | null;

  return (json ?? []).map((c) => ({
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
  },
): Promise<{ id: string | null; datetime: string; patientName: string }> {
  const config = await loadConfig(accountId);

  // Resolve/cria paciente
  let patient = await findClinupPatient(accountId, params.phone);
  if (!patient) {
    patient = await createClinupPatient(accountId, { name: params.name, phone: params.phone });
  }

  if (!patient.id) throw new Error("Não foi possível obter ID do paciente Clinup");

  // Formata data e hora
  const dt = new Date(params.datetime);
  const data = dt.toISOString().slice(0, 10); // YYYY-MM-DD
  const hora = dt.toTimeString().slice(0, 8);  // HH:MM:SS

  const body: Record<string, unknown> = {
    profissionalId: Number(config.profissionalId),
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

  const json = (await res.json()) as { id?: string | number; data?: string; hora?: string };

  return {
    id: json.id ? String(json.id) : null,
    datetime: `${json.data ?? data} ${json.hora ?? hora}`,
    patientName: patient.name,
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
  const config = await loadConfig(accountId);
  const results: { start: string; end: string }[] = [];

  // Busca datas disponíveis a partir de `from`
  let dates: string[] = [];
  try {
    dates = await listClinupAvailableDates(accountId, from);
  } catch {
    return [];
  }

  // Filtra datas dentro do range
  const toDate = new Date(to);
  const validDates = dates.filter((d) => new Date(d) <= toDate).slice(0, 5);

  for (const date of validDates) {
    try {
      const slots = await listClinupSlots(accountId, date);
      for (const s of slots) {
        const start = `${s.date}T${s.time}`;
        const end = new Date(
          new Date(start).getTime() + config.duracaoConsulta * 60 * 1000,
        ).toISOString();
        results.push({ start, end });
      }
    } catch {
      continue;
    }
  }

  return results;
}
