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
export function diaSemanaChave(dateObj: Date): string {
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

/** Minutos do FIM de um bloco: "00:00" e "24:00" significam meia-noite (1440),
 *  não o minuto 0 — senão um expediente "12:00–00:00" vira bloco impossível. */
function fimParaMinutos(tempo: string): number {
  const min = tempoParaMinutos(tempo);
  return min === 0 ? 1440 : min;
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

/** Dias da semana com ao menos um bloco ativo no business_hours_json (ex: ["segunda","terca"]). */
export function activeWeekdayKeys(businessHoursJson: string | undefined | null): string[] {
  const disp = parseDisponibilidadeFromSettings(businessHoursJson);
  return Object.keys(disp).filter((k) => (disp[k]?.length ?? 0) > 0);
}

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
        // Comparação NUMÉRICA (não string) — end "00:00" significa meia-noite
        // (fim do dia = 1440), e como string "00:00" < qualquer hora quebra tudo.
        const sM = tempoParaMinutos(start);
        const eM = fimParaMinutos(end);
        const lsM = lunchStart ? tempoParaMinutos(lunchStart) : -1;
        const leM = lunchEnd ? tempoParaMinutos(lunchEnd) : -1;
        if (lunchStart && lunchEnd && lsM < leM && lsM > sM && leM < eM) {
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

// ── Múltiplas agendas (label → calendar_id) ──────────────────────────────
// Uma conta pode selecionar várias agendas Google. Cada uma tem um `label`
// (o "nome da variável" que o agente usa) e uma `descricao` (quando usar).
// Quando há 2+, o scheduler injeta o parâmetro `agenda` (enum dos labels) e o
// agente escolhe conforme as regras do prompt.

export interface GCalAgenda {
  label: string;
  calendarId: string;
  descricao?: string;
  /** Duração/granularidade dos slots desta agenda (min). Fallback: duracao_consulta_minutos. */
  duracaoMinutos?: number;
  /** Horários liberados específicos desta agenda (business_hours_json). Fallback: o do agente. */
  businessHoursJson?: string;
  /** Modo "uma por dia" (ex: festas): oferece no máx. 1 horário por dia livre,
   *  e considera o dia ocupado se já houver QUALQUER evento naquele dia. */
  umaPorDia?: boolean;
  /** Título do evento desta agenda (template). Vazio = usa o global do agente. */
  tituloTemplate?: string;
  /** Descrição do evento desta agenda (template). Vazio = usa o global do agente. */
  descricaoTemplate?: string;
}

function parseAgendas(raw: unknown): GCalAgenda[] {
  if (!Array.isArray(raw)) return [];
  const out: GCalAgenda[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const label = typeof o.label === "string" ? o.label.trim() : "";
    const calendarId =
      typeof o.calendar_id === "string"
        ? o.calendar_id.trim()
        : typeof o.calendarId === "string"
          ? (o.calendarId as string).trim()
          : "";
    if (!label || !calendarId) continue;
    const descricao = typeof o.descricao === "string" ? o.descricao.trim() : undefined;
    const duracaoRaw = o.duracao_minutos ?? o.duracaoMinutos;
    const duracaoMinutos =
      typeof duracaoRaw === "number" && Number.isFinite(duracaoRaw) && duracaoRaw > 0
        ? Math.round(duracaoRaw)
        : undefined;
    const bhRaw = o.business_hours_json ?? o.businessHoursJson;
    const businessHoursJson =
      typeof bhRaw === "string" && bhRaw.trim() ? bhRaw.trim() : undefined;
    const umaPorDia = o.uma_por_dia === true || o.umaPorDia === true;
    const titRaw = o.gcal_event_title_template ?? o.tituloTemplate;
    const tituloTemplate =
      typeof titRaw === "string" && titRaw.trim() ? titRaw.trim() : undefined;
    const descRaw = o.gcal_event_description_template ?? o.descricaoTemplate;
    const descricaoTemplate =
      typeof descRaw === "string" && descRaw.trim() ? descRaw : undefined;
    out.push({
      label,
      calendarId,
      descricao: descricao || undefined,
      duracaoMinutos,
      businessHoursJson,
      ...(umaPorDia ? { umaPorDia: true } : {}),
      tituloTemplate,
      descricaoTemplate,
    });
  }
  return out;
}

/**
 * Lista as agendas configuradas para a conta. Query própria + try/catch para
 * que a ausência da coluna `agendas` (migration não aplicada) NÃO quebre o
 * fluxo de agenda única — nesse caso retorna [] e o caller usa o calendar_id.
 */
export async function listAccountAgendas(accountId: string): Promise<GCalAgenda[]> {
  const sb = getSelfhost();
  try {
    const { data, error } = await sb
      .from("google_calendar_tokens")
      .select("agendas")
      .eq("account_id", accountId)
      .maybeSingle();
    if (error) return [];
    return parseAgendas(data?.agendas);
  } catch {
    return [];
  }
}

/**
 * Resolve o `calendar_id` real a partir do label escolhido pelo agente.
 * - label informado e existente → seu calendar_id.
 * - label informado mas inexistente → null (caller decide tratar como erro).
 * - sem label → undefined (usa o calendar_id padrão do token).
 */
export async function resolveAgendaCalendarId(
  accountId: string,
  label?: string | null,
): Promise<string | null | undefined> {
  if (!label || !label.trim()) return undefined;
  const agendas = await listAccountAgendas(accountId);
  const wanted = label.trim().toLowerCase();
  const match = agendas.find((a) => a.label.toLowerCase() === wanted);
  return match ? match.calendarId : null;
}

/**
 * Persiste a lista de agendas da conta (coluna jsonb `agendas`). Normaliza
 * para o formato canônico {label, calendar_id, descricao} e remove labels
 * duplicados (case-insensitive, mantendo o primeiro).
 */
export async function saveAccountAgendas(
  accountId: string,
  agendas: {
    label: string;
    calendarId: string;
    descricao?: string;
    duracaoMinutos?: number;
    businessHoursJson?: string;
    umaPorDia?: boolean;
    tituloTemplate?: string;
    descricaoTemplate?: string;
  }[],
): Promise<void> {
  const seen = new Set<string>();
  const normalized: {
    label: string;
    calendar_id: string;
    descricao?: string;
    duracao_minutos?: number;
    business_hours_json?: string;
    uma_por_dia?: boolean;
    gcal_event_title_template?: string;
    gcal_event_description_template?: string;
  }[] = [];
  for (const a of agendas) {
    const label = (a.label ?? "").trim();
    const calendarId = (a.calendarId ?? "").trim();
    if (!label || !calendarId) continue;
    const key = label.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const descricao = (a.descricao ?? "").trim();
    const duracao =
      typeof a.duracaoMinutos === "number" && a.duracaoMinutos > 0
        ? Math.round(a.duracaoMinutos)
        : undefined;
    const bh = (a.businessHoursJson ?? "").trim();
    const tit = (a.tituloTemplate ?? "").trim();
    const desc = (a.descricaoTemplate ?? "").replace(/\s+$/, "");
    normalized.push({
      label,
      calendar_id: calendarId,
      ...(descricao ? { descricao } : {}),
      ...(duracao ? { duracao_minutos: duracao } : {}),
      ...(bh ? { business_hours_json: bh } : {}),
      ...(a.umaPorDia ? { uma_por_dia: true } : {}),
      ...(tit ? { gcal_event_title_template: tit } : {}),
      ...(desc ? { gcal_event_description_template: desc } : {}),
    });
  }

  const sb = getSelfhost();
  await sb
    .from("google_calendar_tokens")
    .update({ agendas: normalized, atualizado_em: new Date().toISOString() })
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
  /** Modo "uma por dia" (ex: festas): no máx. 1 janela por dia e o dia é
   *  considerado ocupado se houver QUALQUER evento nele. */
  umaPorDia?: boolean;
}

// Granularidades válidas (passo da grade de horários).
const GRAN_VALIDOS = [10, 15, 20, 30, 40, 45, 60, 90, 120];
// Duração do compromisso: pode ser bem maior (ex: festa de 4h = 240).
const DURACAO_MIN = 5;
const DURACAO_MAX = 720; // 12h

export async function listGoogleCalendarSlots(
  accountId: string,
  params: ListSlotsParams,
  calendarIdOverride?: string,
): Promise<GCalSlot[]> {
  const token = await loadTokens(accountId);
  if (!token) throw new Error("Google Calendar não conectado para esta conta");
  const calendarId = calendarIdOverride || token.calendarId;

  const tamanho = params.tamanhoJanelaMinutos ?? 40;
  // Em "uma por dia" (festas) a janela é grande (4h+) e serve só para marcar o
  // horário de início; a grade de candidatos usa um passo fino para alinhar o
  // horário ao início do expediente liberado.
  let gran = params.umaPorDia ? 60 : (params.granularidade ?? 30);

  if (tamanho < DURACAO_MIN || tamanho > DURACAO_MAX) {
    throw new Error(`Duração inválida (${tamanho}). Use entre ${DURACAO_MIN} e ${DURACAO_MAX} minutos.`);
  }
  if (!GRAN_VALIDOS.includes(gran)) {
    // Duração longa sem "uma por dia" (ex: 240) chega aqui via granularidade=
    // duração. Cai para 60 em vez de quebrar a tool — slots de hora em hora.
    console.warn(`[gcal] granularidade ${gran} inválida — usando 60`);
    gran = 60;
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
    // Em "uma por dia" (festa reserva o dia), basta o INÍCIO estar no horário
    // liberado — a duração (ex: 4h) pode passar do fim do bloco/expediente.
    // Janela terminando EXATAMENTE à meia-noite conta como mesmo dia (e-1ms).
    if (!params.umaPorDia && !mesmaDataNoFuso(s, new Date(e.getTime() - 1))) return false;
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
    const endMinRaw = minutosNoDia(e);
    // Fim à meia-noite = 1440 (fim do dia), não minuto 0.
    const endMin = endMinRaw === 0 ? 1440 : endMinRaw;
    return blocos.some((b) => {
      const bIni = tempoParaMinutos(b.inicio);
      const bFim = fimParaMinutos(b.fim);
      if (params.umaPorDia) return startMin >= bIni && startMin < bFim;
      return startMin >= bIni && endMin <= bFim;
    });
  });

  console.log(
    `[gcal] janelas: ${candidates.length} candidatas → ${janelasNoExpediente.length} dentro do expediente (calendar=${calendarId}, temExpediente=${temExpediente}, dias=${Object.keys(disponibilidade).filter((k) => (disponibilidade[k]?.length ?? 0) > 0).join(",")})`,
  );

  if (janelasNoExpediente.length === 0) return [];

  // 3. Consulta eventos existentes no período
  const accessToken = await refreshTokenIfNeeded(accountId, token);
  const calId = encodeURIComponent(calendarId);
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
  // Chave de dia no fuso BR (YYYY-MM-DD) para agrupar/comparar por dia.
  const dateKeyBr = (d: Date) =>
    new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(d);

  let semConflito: { inicio: Date; fim: Date }[];
  if (params.umaPorDia) {
    // Modo "uma por dia" (festas): o dia inteiro fica ocupado se houver QUALQUER
    // evento nele. Oferece no máximo 1 janela (a primeira) por dia livre.
    const diasOcupados = new Set(eventos.map((ev) => dateKeyBr(ev.inicio)));
    const usados = new Set<string>();
    semConflito = [];
    for (const janela of janelasNoExpediente) {
      const dia = dateKeyBr(janela.inicio);
      if (diasOcupados.has(dia) || usados.has(dia)) continue;
      usados.add(dia);
      semConflito.push(janela);
    }
  } else {
    semConflito = janelasNoExpediente.filter(({ inicio: s, fim: e }) => {
      for (const ev of eventos) {
        if (s < ev.fim && e > ev.inicio) return false;
      }
      return true;
    });
  }

  console.log(
    `[gcal] após eventos: ${janelasNoExpediente.length} → ${semConflito.length} sem conflito (${eventos.length} eventos no período${params.umaPorDia ? ", modo=uma_por_dia" : ""})`,
  );

  // 5. Corta amostras. No modo "uma por dia" (festas), preserva a ordem
  // cronológica (os próximos dias livres). Caso contrário, embaralha para
  // variar os horários ofertados dentro do período.
  let resultado = [...semConflito];
  if (typeof params.amostras === "number" && params.amostras > 0) {
    if (!params.umaPorDia) {
      // Fisher-Yates
      for (let i = resultado.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [resultado[i], resultado[j]] = [resultado[j], resultado[i]];
      }
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
  calendarIdOverride?: string,
): Promise<CreateGCalEventResult> {
  const token = await loadTokens(accountId);
  if (!token) throw new Error("Google Calendar não conectado para esta conta");
  const targetCalendarId = calendarIdOverride || token.calendarId;

  const start = new Date(params.eventoInicio);
  const end = new Date(start.getTime() + params.duracaoMinutos * 60_000);
  if (isNaN(start.getTime()) || isNaN(end.getTime())) {
    throw new Error("eventoInicio inválido");
  }

  const accessToken = await refreshTokenIfNeeded(accountId, token);

  // Conflito direto na agenda (mais confiável que re-gerar janelas).
  const calIdEnc = encodeURIComponent(targetCalendarId);
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
      `[gcal] conflito ao criar evento start=${start.toISOString()} calendar=${targetCalendarId} eventos=${conflictJson.items?.length ?? 0}`,
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
    `[gcal] evento criado id=${result.id} calendar=${targetCalendarId} start=${result.start}`,
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
  /** ID do calendário onde o evento está (relevante quando há múltiplas agendas). */
  calendarId: string;
  /** Label da agenda correspondente (quando o calendarId casa com uma agenda configurada). */
  agendaLabel?: string;
}

/**
 * Busca agendamentos futuros do contato (por telefone na descrição). Quando a
 * conta tem múltiplas agendas, procura em TODAS e marca cada evento com o
 * calendarId/label onde foi encontrado — assim cancelamento/remarcação sabem
 * em qual agenda agir sem o agente precisar rastrear isso.
 */
export async function findGoogleCalendarEventsByPhone(
  accountId: string,
  phone: string,
): Promise<GCalAppointment[]> {
  const token = await loadTokens(accountId);
  if (!token) throw new Error("Google Calendar não conectado");

  const accessToken = await refreshTokenIfNeeded(accountId, token);

  // Agendas a consultar: as configuradas (multi) ou o calendar_id padrão.
  const agendas = await listAccountAgendas(accountId);
  const targets: { calendarId: string; label?: string }[] =
    agendas.length > 0
      ? agendas.map((a) => ({ calendarId: a.calendarId, label: a.label }))
      : [{ calendarId: token.calendarId }];

  // Busca eventos futuros (até 1 ano) com `q=phone` (procura na descrição)
  const now = new Date().toISOString();
  const oneYear = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();

  const perCalendar = await Promise.all(
    targets.map(async (t) => {
      const calId = encodeURIComponent(t.calendarId);
      const url = new URL(`${GCAL_BASE}/calendars/${calId}/events`);
      url.searchParams.set("timeMin", now);
      url.searchParams.set("timeMax", oneYear);
      url.searchParams.set("singleEvents", "true");
      url.searchParams.set("q", phone);
      url.searchParams.set("showDeleted", "false");

      const res = await fetch(url.toString(), {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!res.ok) return [] as GCalAppointment[];

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
          calendarId: t.calendarId,
          agendaLabel: t.label,
        })) as GCalAppointment[];
    }),
  );

  return perCalendar.flat();
}

// ── Atualizar evento (título / descrição) ────────────────────────────────

export async function updateGoogleCalendarEvent(
  accountId: string,
  params: { eventId: string; titulo?: string; descricao?: string },
  calendarIdOverride?: string,
): Promise<{ ok: boolean }> {
  const token = await loadTokens(accountId);
  if (!token) throw new Error("Google Calendar não conectado");

  const accessToken = await refreshTokenIfNeeded(accountId, token);
  const calId = encodeURIComponent(calendarIdOverride || token.calendarId);
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
  calendarIdOverride?: string,
): Promise<{ ok: boolean }> {
  const token = await loadTokens(accountId);
  if (!token) throw new Error("Google Calendar não conectado");

  const accessToken = await refreshTokenIfNeeded(accountId, token);
  const eId = encodeURIComponent(eventId);

  // Lista de calendários a tentar: o override (se houver), senão todas as
  // agendas configuradas, senão o calendar_id padrão. Sem o calendar certo
  // o DELETE retorna 404 — por isso, em multi-agenda, tentamos cada uma.
  const candidates: string[] = [];
  if (calendarIdOverride) {
    candidates.push(calendarIdOverride);
  } else {
    const agendas = await listAccountAgendas(accountId);
    if (agendas.length > 0) candidates.push(...agendas.map((a) => a.calendarId));
    else candidates.push(token.calendarId);
  }

  let lastErr = "";
  for (const cal of candidates) {
    const calId = encodeURIComponent(cal);
    const res = await fetch(`${GCAL_BASE}/calendars/${calId}/events/${eId}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    // 410 = já cancelado; 200/204 = ok. 404 = evento não está NESTE calendário → tenta o próximo.
    if (res.ok || res.status === 410) return { ok: true };
    if (res.status === 404) {
      lastErr = "404 (evento não encontrado neste calendário)";
      continue;
    }
    const err = await res.text();
    throw new Error(`Falha ao cancelar evento: ${res.status} ${err.slice(0, 200)}`);
  }
  throw new Error(`Falha ao cancelar evento: ${lastErr || "evento não encontrado em nenhuma agenda"}`);
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
