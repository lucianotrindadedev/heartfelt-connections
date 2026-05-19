// Google Calendar integration: Free/Busy, Events, token refresh
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

export interface CalendarSlot {
  start: string; // ISO 8601
  end: string;
}

// Retorna slots livres em intervalos de `durationMin` minutos
export async function listGoogleCalendarSlots(
  accountId: string,
  from: string,
  to: string,
  durationMin = 40,
): Promise<CalendarSlot[]> {
  const token = await loadTokens(accountId);
  if (!token) throw new Error("Google Calendar não conectado para esta conta");

  const accessToken = await refreshTokenIfNeeded(accountId, token);

  // Free/Busy query para saber os horários ocupados
  const fbRes = await fetch(`${GCAL_BASE}/freeBusy`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      timeMin: from,
      timeMax: to,
      items: [{ id: token.calendarId }],
    }),
  });

  if (!fbRes.ok) throw new Error(`FreeBusy failed: ${fbRes.status}`);

  const fbJson = (await fbRes.json()) as {
    calendars?: Record<string, { busy?: { start: string; end: string }[] }>;
  };

  const busy = fbJson.calendars?.[token.calendarId]?.busy ?? [];

  // Gera slots de `durationMin` no intervalo, pulando os ocupados
  const slots: CalendarSlot[] = [];
  const stepMs = durationMin * 60 * 1000;
  let cursor = new Date(from).getTime();
  const end = new Date(to).getTime();

  while (cursor + stepMs <= end) {
    const slotStart = cursor;
    const slotEnd = cursor + stepMs;

    const conflicts = busy.some((b) => {
      const bs = new Date(b.start).getTime();
      const be = new Date(b.end).getTime();
      return slotStart < be && slotEnd > bs;
    });

    if (!conflicts) {
      slots.push({
        start: new Date(slotStart).toISOString(),
        end: new Date(slotEnd).toISOString(),
      });
    }

    cursor += stepMs;
  }

  return slots;
}

export async function createGoogleCalendarEvent(
  accountId: string,
  params: {
    summary: string;
    description?: string;
    phone: string;
    start: string;
    end: string;
  },
): Promise<{ id: string; htmlLink: string }> {
  const token = await loadTokens(accountId);
  if (!token) throw new Error("Google Calendar não conectado para esta conta");

  const accessToken = await refreshTokenIfNeeded(accountId, token);

  const calId = encodeURIComponent(token.calendarId);
  const res = await fetch(`${GCAL_BASE}/calendars/${calId}/events`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      summary: params.summary,
      description: params.description ?? `Telefone: ${params.phone}`,
      start: { dateTime: params.start },
      end: { dateTime: params.end },
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Falha ao criar evento: ${res.status} ${err.slice(0, 200)}`);
  }

  const json = (await res.json()) as { id?: string; htmlLink?: string };
  return { id: json.id ?? "", htmlLink: json.htmlLink ?? "" };
}

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
