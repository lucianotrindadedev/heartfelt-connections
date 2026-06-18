// Integração de SAÍDA com o Leads360 (Central360).
// Envia eventos do agente para o app de gestão de leads via os webhooks
// documentados (/leads, /interesses, /agendado, /transferencia).
//
// Princípios:
// - Best-effort: qualquer falha é logada e engolida — NUNCA quebra o atendimento.
// - Config por agente: settings.leads360_token. Sem token → integração desligada.
// - Base URL fixa no padrão do Leads360 (editável via settings.leads360_base_url).

const DEFAULT_BASE_URL =
  "https://supabasekong-csk8yej3n54gt9344cf1i5e5.72.62.104.184.sslip.io/functions/v1";

export interface Leads360Config {
  enabled: boolean;
  baseUrl: string;
  token: string;
}

export interface Leads360Utm {
  source?: string | null;
  medium?: string | null;
  campaign?: string | null;
  content?: string | null;
  term?: string | null;
}

/** Lê a config do Leads360 dos settings do agente. enabled = tem token. */
export function resolveLeads360Config(settings: Record<string, string>): Leads360Config {
  const token = (settings.leads360_token ?? "").trim();
  const baseUrl = ((settings.leads360_base_url ?? "").trim() || DEFAULT_BASE_URL).replace(/\/$/, "");
  return { enabled: !!token, baseUrl, token };
}

async function postLeads360(
  cfg: Leads360Config,
  path: string,
  body: Record<string, unknown>,
): Promise<void> {
  if (!cfg.enabled) return;
  try {
    const res = await fetch(`${cfg.baseUrl}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${cfg.token}`,
        "X-Webhook-Token": cfg.token,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      const t = await res.text();
      console.warn(`[leads360] ${path} → HTTP ${res.status}: ${t.slice(0, 200)}`);
    } else {
      console.log(`[leads360] ${path} ok`);
    }
  } catch (e) {
    console.warn(`[leads360] ${path} falhou:`, e instanceof Error ? e.message : e);
  }
}

function formatBrDateTime(iso: string): string {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    const tz = "America/Sao_Paulo";
    const data = new Intl.DateTimeFormat("pt-BR", {
      timeZone: tz,
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
    }).format(d);
    const hora = new Intl.DateTimeFormat("pt-BR", {
      timeZone: tz,
      hour: "2-digit",
      minute: "2-digit",
    }).format(d);
    return `${data} às ${hora}`;
  } catch {
    return iso;
  }
}

/** POST /leads — contato inicial (cria/atualiza o lead com UTM/anúncio). */
export async function sendLeads360Lead(
  cfg: Leads360Config,
  p: { name: string; phone: string; utm?: Leads360Utm | null; createdAt?: string | null },
): Promise<void> {
  await postLeads360(cfg, "/leads", {
    name: p.name,
    phone: p.phone,
    ...(p.createdAt ? { createdAt: p.createdAt } : {}),
    utm: {
      source: p.utm?.source ?? "",
      medium: p.utm?.medium ?? "",
      campaign: p.utm?.campaign ?? "",
      content: p.utm?.content ?? "",
      term: p.utm?.term ?? "",
    },
  });
}

/** POST /interesses — interesse identificado na qualificação. */
export async function sendLeads360Interest(
  cfg: Leads360Config,
  p: { name: string; phone: string; interest: string },
): Promise<void> {
  await postLeads360(cfg, "/interesses", {
    name: p.name,
    phone: p.phone,
    interest: p.interest,
  });
}

/** POST /agendado — agendamento criado. A data/hora vai em notes (o endpoint
 *  não tem campo de data próprio). */
export async function sendLeads360Scheduled(
  cfg: Leads360Config,
  p: { name: string; phone: string; datetimeIso?: string | null; extraNotes?: string },
): Promise<void> {
  const quando = p.datetimeIso ? `Agendado para ${formatBrDateTime(p.datetimeIso)}` : "Agendado pela IA";
  const notes = p.extraNotes ? `${quando} — ${p.extraNotes}` : quando;
  await postLeads360(cfg, "/agendado", {
    name: p.name,
    phone: p.phone,
    notes,
  });
}

/** POST /transferencia — escalada para humano. */
export async function sendLeads360Transfer(
  cfg: Leads360Config,
  p: { name: string; phone: string; destination?: string },
): Promise<void> {
  await postLeads360(cfg, "/transferencia", {
    destination: p.destination || "Atendimento Humano",
    name: p.name,
    phone: p.phone,
    transferred_at: new Date().toISOString(),
  });
}
