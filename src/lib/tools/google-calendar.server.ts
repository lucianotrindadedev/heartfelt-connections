// Google Calendar integration: OAuth tokens, listagem de calendários, geração de
// janelas disponíveis (réplica do fluxo n8n "08. Buscar janelas disponíveis"),
// criação / atualização / cancelamento de eventos.
//
// O fluxo de "janelas disponíveis" segue a mesma lógica do workflow n8n:
//   1. Gera janelas candidatas (período / granularidade / tamanho).
//   2. Filtra pelo expediente da clínica (business_hours_json por dia da semana).
//   3. Consulta eventos do período no Google Calendar.
//   4. Remove janelas que conflitam com eventos existentes.
//   5. Embaralha + corta `amostras` para diversidade.

import { getSelfhost } from "@/integrations/selfhost/client.server";
import { decryptValue, encryptValue } from "@/lib/crypto.server";

const GCAL_BASE = "https://www.googleapis.com/calendar/v3";
const TOKEN_URL = "https://oauth2.googleapis.com/token";

interface GCalToken {
  accessToken: string;
  refreshToken: string;
  calendarId: string;
  email: string | null;
  expiresAt: Date | null;
}

async function loadTokens(accountId: string): Promise<GCalToken | null> {
  const sb = getSelfhost();
  const { data } = await sb
    .from("google_calendar_tokens")
    .select("access_token_enc, refresh_token_enc, calendar_id, email, expires_at, ativo")
    .eq("account_id", accountId)
    .single();

  if (!data || !data.ativo) return null;

  const accessToken = await decryptValue(data.access_token_enc as unknown as string);
  const refreshToken = await decryptValue(data.refresh_token_enc as unknown as string);
  if (!accessToken || !refreshToken) return null;

  return {
    accessToken,
    refreshToken,
    calendarId: (data.calendar_id as string) || "primary",
    email: (data.email as string | null) ?? null,
    expiresAt: data.expires_at ? new Date(data.expires_at as string) : null,
  };
}

async function refreshTokenIfNeeded(accountId: string, token: GCalToken): Promise<string> {
  const needsRefresh =
    !token.expiresAt || token.expiresAt.getTime() - Date.now() < 5 * 60 * 1000;

  if (!needsRefresh) return token.accessToken;

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID ?? "",
      client_secret: process.env.GOOGLE_CLIENT_SECRET ?? "",
      refresh_token: token.refreshToken,
      grant_type: "refresh_token",
    }),
  });

  if (!res.ok) throw new Error(`Token refresh failed: ${res.status}`);

  const json = (await res.json()) as {
    access_token?: string;
    expires_in?: number;
  };

  const newAccessToken = json.access_token;
  if (!newAccessToken) throw new Error("Refresh token response missing access_token");

  const expiresAt = new Date(Date.now() + (json.expires_in ?? 3600) * 1000);
  const sb = getSelfhost();
  await sb
    .from("google_calendar_tokens")
    .update({
      access_token_enc: await encryptValue(newAccessToken),
      expires_at: expiresAt.toISOString(),
      atualizado_em: new Date().toISOString(),
    })
    .eq("account_id", accountId);

  return newAccessToken;
}

// ── Helpers de fuso & datas (espelha o code-node n8n) ─────────────────────

const TZ = "America/Sao_Paulo";

function removeAcento(str: string): string {
  return (str || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();
}

/** Retorna a chave de dia da semana sem acento ("segunda", "terca", "quarta", ...). */
function diaSemanaChave(dateObj: Date): string {
  const diaPt = new Intl.DateTimeFormat("pt-BR", {
    weekday: "long",
    timeZone: TZ,
  }).format(dateObj); // "quarta-feira"
  const base = removeAcento(diaPt.replace("-feira", "")).trim();
  if (base === "terca") return "terca";
  if (base === "sabado") return "sabado";
  return base; // domingo, segunda, quarta, quinta, sexta
}

function minutosNoDia(dateObj: Date): number {
  const hm = new Intl.DateTimeFormat("pt-BR", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: TZ,
  }).format(dateObj);
  const [h, m] = hm.split(":").map(Number);
  return h * 60 + m;
}

function tempoParaMinutos(tempo: string): number {
  const [h, m] = tempo.split(":").map(Number);
  return h * 60 + m;
}

function mesmaDataNoFuso(inicio: Date, fim: Date): boolean {
  const fmt = (d: Date) =>
    new Intl.DateTimeFormat("pt-BR", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      timeZone: TZ,
    }).format(d);
  return fmt(inicio) === fmt(fim);
}

interface DisponibilidadeBloco {
  inicio: string; // "09:00"
  fim: string;    // "19:00"
}
type Disponibilidade = Record<string, DisponibilidadeBloco[]>;

/** Mapeia chave abreviada da UI ('seg', 'ter'...) para chave longa ('segunda', 'terca'...). */
const SHORT_DAY_MAP: Record<string, string> = {
  dom: "domingo",
  seg: "segunda",
  ter: "terca",
  qua: "quarta",
  qui: "quinta",
  sex: "sexta",
  sab: "sabado",
};

/** Lê business_hours_json do agente e devolve no formato {segunda: [...], terca: [...], ...}. */
function parseDisponibilidadeFromSettings(
  raw: string | undefined | null,
): Disponibilidade {
  if (!raw) return {};
  try {
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (!parsed || typeof parsed !== "object") return {};

    // Aceita três formatos:
    //   1) { segunda: [{inicio, fim}], ... }                            ← formato n8n
    //   2) { segunda: { enabled, start, end, intervalo? }, ... }        ← variante
    //   3) { seg: { active, start, lunch_start, lunch_end, end }, ... } ← BusinessHoursEditor UI (atual)
    const out: Disponibilidade = {};
    for (const [k, v] of Object.entries(parsed)) {
      const lower = removeAcento(k);
      // Resolve chave: se for "seg" mapeia para "segunda"
      const key = SHORT_DAY_MAP[lower] ?? lower;

      if (Array.isArray(v)) {
        out[key] = (v as DisponibilidadeBloco[]).filter(
          (b) => b && typeof b.inicio === "string" && typeof b.fim === "string",
        );
      } else if (v && typeof v === "object") {
        const obj = v as Record<string, unknown>;
        // Aceita 'enabled' (legado) ou 'active' (UI atual)
        const isActive =
          obj.active !== false && obj.enabled !== false;
        if (!isActive) {
          out[key] = [];
          continue;
        }
        const start = (obj.start as string) || (obj.inicio as string) || "";
        const end = (obj.end as string) || (obj.fim as string) || "";
        const lunchStart = (obj.lunch_start as string) || "";
        const lunchEnd = (obj.lunch_end as string) || "";

        if (!start || !end) {
          out[key] = [];
          continue;
        }

        // Se há intervalo de almoço (e ele faz sentido), divide em 2 blocos:
        // [start..lunchStart] + [lunchEnd..end]. Senão, bloco único.
        if (lunchStart && lunchEnd && lunchStart < lunchEnd && lunchStart > start && lunchEnd < end) {
          out[key] = [
            { inicio: start, fim: lunchStart },
            { inicio: lunchEnd, fim: end },
          ];
        } else {
          out[key] = [{ inicio: start, fim: end }];
        }
      }
    }
    return out;
  } catch (e) {
    console.warn("[gcal] parse business_hours_json falhou:", e);
    return {};
  }
}

function formatarDataIso(d: Date): string {
  const local = formatGcalLocalDateTime(d);
  return `${local}-03:00`;
}

/** Horário local em America/Sao_Paulo para a API do Google Calendar (campo dateTime + timeZone). */
function formatGcalLocalDateTime(d: Date): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: TZ,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    })
      .formatToParts(d)
      .map((p) => [p.type, p.value]),
  ) as Record<string, string>;
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}`;
}

// ── Lista calendários do usuário (após OAuth) ────────────────────────────

export interface GCalCalendarOption {
  id: string;
  summary: string;
  primary?: boolean;
  accessRole: string;
  backgroundColor?: string;
}

export async function listAvailableCalendars(
  accountId: string,
): Promise<GCalCalendarOption[]> {
  const token = await loadTokens(accountId);
  if (!token) throw new Error("Google Calendar não conectado");

  const accessToken = await refreshTokenIfNeeded(accountId, token);

  const res = await fetch(`${GCAL_BASE}/users/me/calendarList?minAccessRole=writer`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`Falha listando calendários: ${res.status}`);

  const json = (await res.json()) as {
    items?: {
      id: string;
      summary: string;
      primary?: boolean;
      accessRole: string;
      backgroundColor?: string;
    }[];
  };

  return (json.items ?? []).map((c) => ({
    id: c.id,
    summary: c.summary,
    primary: c.primary,
    accessRole: c.accessRole,
    backgroundColor: c.backgroundColor,
  }));
}

export async function selectGoogleCalendar(
  accountId: string,
  calendarId: string,
  calendarName?: string,
): Promise<void> {
  const sb = getSelfhost();
  await sb
    .from("google_calendar_tokens")
    .update({
      calendar_id: calendarId,
      calendar_name: calendarName ?? null,
      atualizado_em: new Date().toISOString(),
    })
    .eq("account_id", accountId);
}

// ── Busca de janelas disponíveis (réplica do n8n) ────────────────────────

export interface GCalSlot {
  inicio: string;       // ISO 8601 BRT
  fim: string;
  date_label: string;   // "quarta, 21/05"
  time_label: string;   // "14:30"
}

interface ListSlotsParams {
  periodoInicio: string;        // ISO 8601
  periodoFim: string;           // ISO 8601
  tamanhoJanelaMinutos?: number; // default 40
  granularidade?: number;        // default 30
  amostras?: number;             // se omitido, retorna tudo
  /** JSON do business_hours_json do agente. Se vazio → sem restrição de expediente. */
  businessHoursJson?: string | null;
}

const TAMANHOS_VALIDOS = [10, 15, 20, 30, 40, 45, 60, 90, 120];

export async function listGoogleCalendarSlots(
  accountId: string,
  params: ListSlotsParams,
): Promise<GCalSlot[]> {
  const token = await loadTokens(accountId);
  if (!token) throw new Error("Google Calendar não conectado para esta conta");

  const tamanho = params.tamanhoJanelaMinutos ?? 40;
  const gran = params.granularidade ?? 30;

  if (!TAMANHOS_VALIDOS.includes(tamanho) || !TAMANHOS_VALIDOS.includes(gran)) {
    throw new Error(
      `Tamanho/granularidade inválidos. Use um destes: ${TAMANHOS_VALIDOS.join(", ")}`,
    );
  }

  const inicio = new Date(params.periodoInicio);
  const fim = new Date(params.periodoFim);
  if (!(inicio instanceof Date) || isNaN(inicio.getTime())) {
    throw new Error("periodo_inicio inválido");
  }
  if (!(fim instanceof Date) || isNaN(fim.getTime())) {
    throw new Error("periodo_fim inválido");
  }
  if (inicio.getTime() < Date.now() - 60 * 1000) {
    throw new Error("Período já passou.");
  }

  // 1. Gera janelas candidatas
  // Snap o inicio para o proximo limite de granularidade NO FUSO BR.
  // Sem isso, se inicio=11:29:16 com gran=30 gera slots em :29:16, :59:16, ...
  // Com snap, vira 11:30:00, 12:00:00... — horarios "redondos" pro paciente.
  const inicioMin = minutosNoDia(inicio);
  const snappedMin = Math.ceil(inicioMin / gran) * gran;
  const ajusteMin = snappedMin - inicioMin;
  // Zera segundos+ms para slots ficarem em HH:MM:00 exato.
  const segundosMs = inicio.getSeconds() * 1000 + inicio.getMilliseconds();
  const inicioSnapped = new Date(
    inicio.getTime() + ajusteMin * 60_000 - segundosMs,
  );

  const totalMin = (fim.getTime() - inicioSnapped.getTime()) / 60_000;
  const quantidadeJanelas = Math.floor(totalMin / gran);
  const candidates: { inicio: Date; fim: Date }[] = [];
  for (let i = 0; i < quantidadeJanelas; i++) {
    const start = new Date(inicioSnapped.getTime() + i * gran * 60_000);
    const end = new Date(start.getTime() + tamanho * 60_000);
    if (end.getTime() > fim.getTime()) break;
    candidates.push({ inicio: start, fim: end });
  }

  // 2. Filtra pela disponibilidade (business_hours_json)
  const disponibilidade = parseDisponibilidadeFromSettings(params.businessHoursJson);
  const temExpediente = Object.values(disponibilidade).some((arr) => arr.length > 0);

  const janelasNoExpediente = candidates.filter(({ inicio: s, fim: e }) => {
    if (!mesmaDataNoFuso(s, e)) return false;
    if (!temExpediente) return true; // sem expediente cadastrado → permite tudo

    const dia = diaSemanaChave(s);
    const blocos =
      disponibilidade[dia] ??
      disponibilidade[removeAcento(dia)] ??
      disponibilidade[
        Object.keys(disponibilidade).find((k) => removeAcento(k) === dia) ?? ""
      ];
    if (!blocos || blocos.length === 0) return false;

    const startMin = minutosNoDia(s);
    const endMin = minutosNoDia(e);
    return blocos.some(
      (b) =>
        startMin >= tempoParaMinutos(b.inicio) &&
        endMin <= tempoParaMinutos(b.fim),
    );
  });

  console.log(
    `[gcal] janelas: ${candidates.length} candidatas → ${janelasNoExpediente.length} dentro do expediente (calendar=${token.calendarId}, temExpediente=${temExpediente}, dias=${Object.keys(disponibilidade).filter((k) => (disponibilidade[k]?.length ?? 0) > 0).join(",")})`,
  );

  if (janelasNoExpediente.length === 0) return [];

  // 3. Consulta eventos existentes no período
  const accessToken = await refreshTokenIfNeeded(accountId, token);
  const calId = encodeURIComponent(token.calendarId);
  const eventsUrl = new URL(`${GCAL_BASE}/calendars/${calId}/events`);
  eventsUrl.searchParams.set("timeMin", inicio.toISOString());
  eventsUrl.searchParams.set("timeMax", fim.toISOString());
  eventsUrl.searchParams.set("singleEvents", "true");
  eventsUrl.searchParams.set("showDeleted", "false");

  const evRes = await fetch(eventsUrl.toString(), {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!evRes.ok) {
    const errBody = await evRes.text();
    console.error(`[gcal] events fetch falhou ${evRes.status}: ${errBody.slice(0, 300)}`);
    throw new Error(`Falha consultando eventos: ${evRes.status}`);
  }

  const evJson = (await evRes.json()) as {
    items?: { start?: { dateTime?: string }; end?: { dateTime?: string } }[];
  };
  const eventos = (evJson.items ?? [])
    .filter((e) => e.start?.dateTime && e.end?.dateTime)
    .map((e) => ({
      inicio: new Date(e.start!.dateTime!),
      fim: new Date(e.end!.dateTime!),
    }));

  // 4. Remove janelas que conflitam
  const semConflito = janelasNoExpediente.filter(({ inicio: s, fim: e }) => {
    for (const ev of eventos) {
      if (s < ev.fim && e > ev.inicio) return false;
    }
    return true;
  });

  console.log(
    `[gcal] após eventos: ${janelasNoExpediente.length} → ${semConflito.length} sem conflito (${eventos.length} eventos no período)`,
  );

  // 5. Embaralha + corta amostras
  let resultado = [...semConflito];
  if (typeof params.amostras === "number" && params.amostras > 0) {
    // Fisher-Yates
    for (let i = resultado.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [resultado[i], resultado[j]] = [resultado[j], resultado[i]];
    }
    resultado = resultado.slice(0, params.amostras);
    // Ordena de volta cronologicamente
    resultado.sort((a, b) => a.inicio.getTime() - b.inicio.getTime());
  }

  // 6. Formata para output
  return resultado.map((slot) => ({
    inicio: formatarDataIso(slot.inicio),
    fim: formatarDataIso(slot.fim),
    date_label: new Intl.DateTimeFormat("pt-BR", {
      timeZone: TZ,
      weekday: "long",
      day: "2-digit",
      month: "2-digit",
    }).format(slot.inicio),
    time_label: new Intl.DateTimeFormat("pt-BR", {
      timeZone: TZ,
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(slot.inicio),
  }));
}

// ── Criar evento ─────────────────────────────────────────────────────────

export interface CreateGCalEventResult {
  id: string;
  htmlLink: string;
  start: string;
  end: string;
}

export async function createGoogleCalendarEvent(
  accountId: string,
  params: {
    eventoInicio: string;          // ISO 8601
    duracaoMinutos: number;
    titulo: string;
    descricao?: string;
    telefone?: string;             // injetado na descrição
  },
): Promise<CreateGCalEventResult> {
  const token = await loadTokens(accountId);
  if (!token) throw new Error("Google Calendar não conectado para esta conta");

  const start = new Date(params.eventoInicio);
  const end = new Date(start.getTime() + params.duracaoMinutos * 60_000);
  if (isNaN(start.getTime()) || isNaN(end.getTime())) {
    throw new Error("eventoInicio inválido");
  }

  const accessToken = await refreshTokenIfNeeded(accountId, token);

  // Conflito direto na agenda (mais confiável que re-gerar janelas).
  const calIdEnc = encodeURIComponent(token.calendarId);
  const conflictUrl = new URL(`${GCAL_BASE}/calendars/${calIdEnc}/events`);
  conflictUrl.searchParams.set(
    "timeMin",
    new Date(start.getTime() - 60_000).toISOString(),
  );
  conflictUrl.searchParams.set(
    "timeMax",
    new Date(end.getTime() + 60_000).toISOString(),
  );
  conflictUrl.searchParams.set("singleEvents", "true");
  conflictUrl.searchParams.set("showDeleted", "false");

  const conflictRes = await fetch(conflictUrl.toString(), {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!conflictRes.ok) {
    const errBody = await conflictRes.text();
    throw new Error(`Falha ao validar disponibilidade: ${conflictRes.status} ${errBody.slice(0, 200)}`);
  }
  const conflictJson = (await conflictRes.json()) as {
    items?: { start?: { dateTime?: string }; end?: { dateTime?: string } }[];
  };
  const hasConflict = (conflictJson.items ?? []).some((ev) => {
    if (!ev.start?.dateTime || !ev.end?.dateTime) return false;
    const evStart = new Date(ev.start.dateTime);
    const evEnd = new Date(ev.end.dateTime);
    return start < evEnd && end > evStart;
  });
  if (hasConflict) {
    console.warn(
      `[gcal] conflito ao criar evento start=${start.toISOString()} calendar=${token.calendarId} eventos=${conflictJson.items?.length ?? 0}`,
    );
    throw new Error("HORÁRIO INDISPONÍVEL");
  }
  const calId = calIdEnc;

  const descricaoFinal = [
    params.descricao ?? "",
    params.telefone ? `\n\nTelefone: ${params.telefone}` : "",
  ].join("");

  const res = await fetch(`${GCAL_BASE}/calendars/${calId}/events?conferenceDataVersion=1`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      summary: params.titulo,
      description: descricaoFinal.trim(),
      start: { dateTime: formatGcalLocalDateTime(start), timeZone: TZ },
      end: { dateTime: formatGcalLocalDateTime(end), timeZone: TZ },
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Falha ao criar evento: ${res.status} ${err.slice(0, 200)}`);
  }

  const json = (await res.json()) as {
    id?: string;
    htmlLink?: string;
    start?: { dateTime?: string };
    end?: { dateTime?: string };
  };
  const result = {
    id: json.id ?? "",
    htmlLink: json.htmlLink ?? "",
    start: json.start?.dateTime ?? start.toISOString(),
    end: json.end?.dateTime ?? end.toISOString(),
  };
  console.log(
    `[gcal] evento criado id=${result.id} calendar=${token.calendarId} start=${result.start}`,
  );
  return result;
}

// ── Buscar agendamentos do contato (busca por telefone na descrição) ─────

export interface GCalAppointment {
  id: string;
  titulo: string;
  descricao: string;
  inicio: string;
  fim: string;
  htmlLink: string;
}

export async function findGoogleCalendarEventsByPhone(
  accountId: string,
  phone: string,
): Promise<GCalAppointment[]> {
  const token = await loadTokens(accountId);
  if (!token) throw new Error("Google Calendar não conectado");

  const accessToken = await refreshTokenIfNeeded(accountId, token);
  const calId = encodeURIComponent(token.calendarId);

  // Busca eventos futuros (até 1 ano) com `q=phone` (procura na descrição)
  const now = new Date().toISOString();
  const oneYear = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();

  const url = new URL(`${GCAL_BASE}/calendars/${calId}/events`);
  url.searchParams.set("timeMin", now);
  url.searchParams.set("timeMax", oneYear);
  url.searchParams.set("singleEvents", "true");
  url.searchParams.set("q", phone);
  url.searchParams.set("showDeleted", "false");

  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) return [];

  const json = (await res.json()) as {
    items?: {
      id?: string;
      summary?: string;
      description?: string;
      start?: { dateTime?: string };
      end?: { dateTime?: string };
      htmlLink?: string;
    }[];
  };

  return (json.items ?? [])
    .filter((e) => e.start?.dateTime)
    .map((e) => ({
      id: e.id ?? "",
      titulo: e.summary ?? "",
      descricao: e.description ?? "",
      inicio: e.start!.dateTime!,
      fim: e.end?.dateTime ?? "",
      htmlLink: e.htmlLink ?? "",
    }));
}

// ── Atualizar evento (título / descrição) ────────────────────────────────

export async function updateGoogleCalendarEvent(
  accountId: string,
  params: { eventId: string; titulo?: string; descricao?: string },
): Promise<{ ok: boolean }> {
  const token = await loadTokens(accountId);
  if (!token) throw new Error("Google Calendar não conectado");

  const accessToken = await refreshTokenIfNeeded(accountId, token);
  const calId = encodeURIComponent(token.calendarId);
  const eventId = encodeURIComponent(params.eventId);

  const patch: Record<string, unknown> = {};
  if (params.titulo !== undefined) patch.summary = params.titulo;
  if (params.descricao !== undefined) patch.description = params.descricao;

  const res = await fetch(`${GCAL_BASE}/calendars/${calId}/events/${eventId}`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(patch),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Falha ao atualizar evento: ${res.status} ${err.slice(0, 200)}`);
  }
  return { ok: true };
}

// ── Cancelar (delete) evento ─────────────────────────────────────────────

export async function cancelGoogleCalendarEvent(
  accountId: string,
  eventId: string,
): Promise<{ ok: boolean }> {
  const token = await loadTokens(accountId);
  if (!token) throw new Error("Google Calendar não conectado");

  const accessToken = await refreshTokenIfNeeded(accountId, token);
  const calId = encodeURIComponent(token.calendarId);
  const eId = encodeURIComponent(eventId);

  const res = await fetch(`${GCAL_BASE}/calendars/${calId}/events/${eId}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok && res.status !== 410) {
    const err = await res.text();
    throw new Error(`Falha ao cancelar evento: ${res.status} ${err.slice(0, 200)}`);
  }
  return { ok: true };
}

// ── Status (UI) ──────────────────────────────────────────────────────────

export async function getGoogleCalendarStatus(accountId: string): Promise<{
  connected: boolean;
  email: string | null;
  calendarId: string | null;
  calendarName: string | null;
}> {
  const sb = getSelfhost();
  const { data } = await sb
    .from("google_calendar_tokens")
    .select("email, calendar_id, calendar_name, ativo")
    .eq("account_id", accountId)
    .single();

  if (!data || !data.ativo) {
    return { connected: false, email: null, calendarId: null, calendarName: null };
  }

  return {
    connected: true,
    email: (data.email as string | null) ?? null,
    calendarId: (data.calendar_id as string | null) ?? null,
    calendarName: (data.calendar_name as string | null) ?? null,
  };
}
