// Cliente HTTP do CRM Helena, autenticado por conta.
// Server-only — não importar do client.
import { getSelfhost } from "@/integrations/selfhost/client.server";
import { decryptValue } from "@/lib/crypto.server";
import {
  detectChannelFromContact,
  detectChannelFromSession,
  formatPhoneE164,
  normalizeBrazilPhone,
  type ConversationChannel,
} from "@/lib/conversation-channel.server";

export interface HelenaAccount {
  id: string;
  baseUrl: string;
  token: string;
}

export async function loadHelenaAccount(accountId: string): Promise<HelenaAccount> {
  const sb = getSelfhost();
  const { data, error } = await sb
    .from("accounts")
    .select("id, helena_base_url, helena_token_enc")
    .eq("id", accountId)
    .single();
  if (error) throw new Error(`Conta ${accountId} não encontrada: ${error.message}`);
  const token = await decryptValue(data.helena_token_enc as unknown as string);
  if (!token) throw new Error(`Token Helena não configurado para ${accountId}`);
  return {
    id: data.id as string,
    baseUrl: (data.helena_base_url as string) ?? "https://api.crmmentoriae7.com.br",
    token,
  };
}

export interface HelenaSessionInfo {
  contactId: string;
  channelId: string | null;
}

export async function loadHelenaSession(
  account: HelenaAccount,
  sessionId: string,
): Promise<HelenaSessionInfo | null> {
  const base = account.baseUrl.replace(/\/$/, "");
  const headers = {
    Authorization: account.token,
    accept: "application/json",
  };
  try {
    const sessionRes = await fetch(`${base}/chat/v2/session/${sessionId}`, { headers });
    if (!sessionRes.ok) return null;
    const session = (await sessionRes.json()) as {
      contactId?: string | number;
      channelId?: string | null;
    };
    if (!session.contactId) return null;
    return {
      contactId: String(session.contactId),
      channelId: session.channelId ?? null,
    };
  } catch {
    return null;
  }
}

function parseHelenaContactRaw(raw: Record<string, unknown>, contactId: string): HelenaContact {
  const rawTags = raw.tagNames as unknown;
  let tagNames: string[] = [];
  if (Array.isArray(rawTags)) {
    tagNames = rawTags.map((t) => {
      if (typeof t === "string") return t;
      if (t && typeof t === "object") {
        const o = t as Record<string, unknown>;
        return String(o.name ?? o.tagName ?? o.label ?? t);
      }
      return String(t);
    });
  }

  const rawUtm = (raw.utm as Record<string, unknown> | null) ?? {};
  const instagram = String(raw.instagram ?? raw.instagramId ?? "").trim() || null;
  const messengerId = String(raw.messengerId ?? raw.messenger_id ?? "").trim() || null;
  const phoneNumber = String(raw.phoneNumber ?? raw.phone ?? "").trim();

  return {
    id: String(raw.id ?? contactId),
    name: String(raw.name ?? ""),
    phoneNumber,
    phoneNumberFormatted: String(raw.phoneNumberFormatted ?? raw.phoneFormatted ?? "").trim() || null,
    instagram,
    messengerId,
    channelId: (raw.channelId as string | null) ?? null,
    tagNames,
    utm: {
      content: (rawUtm.content as string | null) ?? null,
      source: (rawUtm.source as string | null) ?? null,
      medium: (rawUtm.medium as string | null) ?? null,
      campaign: (rawUtm.campaign as string | null) ?? null,
      term: (rawUtm.term as string | null) ?? null,
    },
    customFields: (raw.customFields as Record<string, unknown> | undefined) ?? undefined,
  };
}

export interface HelenaContact {
  id: string;
  name: string;
  phoneNumber: string;
  phoneNumberFormatted: string | null;
  instagram: string | null;
  messengerId: string | null;
  channelId: string | null;
  tagNames: string[];
  utm: {
    content?: string | null;
    source?: string | null;
    medium?: string | null;
    campaign?: string | null;
    term?: string | null;
  };
  customFields?: Record<string, unknown>;
}

export function getContactChannel(
  contact: HelenaContact,
  sessionChannelId?: string | null,
): ConversationChannel {
  const fromContact = detectChannelFromContact(contact);
  if (fromContact !== "unknown") return fromContact;
  return detectChannelFromSession(sessionChannelId ?? contact.channelId);
}

export async function loadHelenaContactById(
  account: HelenaAccount,
  contactId: string,
): Promise<HelenaContact | null> {
  const base = account.baseUrl.replace(/\/$/, "");
  try {
    const contactRes = await fetch(`${base}/core/v1/contact/${contactId}`, {
      headers: { Authorization: account.token, accept: "application/json" },
    });
    if (!contactRes.ok) return null;
    const raw = (await contactRes.json()) as Record<string, unknown>;
    return parseHelenaContactRaw(raw, contactId);
  } catch (e) {
    console.error("[helena] erro ao carregar contato:", e);
    return null;
  }
}

export async function loadHelenaContactFromSession(
  account: HelenaAccount,
  sessionId: string,
): Promise<HelenaContact | null> {
  const session = await loadHelenaSession(account, sessionId);
  if (!session) return null;
  const contact = await loadHelenaContactById(account, session.contactId);
  if (contact && session.channelId) {
    contact.channelId = contact.channelId ?? session.channelId;
  }
  return contact;
}

/**
 * Lista as tags disponíveis no CRM Helena.
 * Endpoint: GET /core/v1/tag
 * Usado para o agente conhecer os nomes EXATOS das tags antes de aplicar.
 */
export interface HelenaTag {
  id: string;
  name: string;
}

export async function listHelenaTags(
  account: HelenaAccount,
): Promise<HelenaTag[]> {
  const base = account.baseUrl.replace(/\/$/, "");
  const res = await fetch(`${base}/core/v1/tag`, {
    headers: {
      Authorization: account.token,
      accept: "application/json",
    },
  });
  if (!res.ok) {
    const body = await res.text();
    console.error(
      `[helena] listHelenaTags falhou ${res.status} body=${body.slice(0, 300)}`,
    );
    return [];
  }
  const json = (await res.json()) as unknown;
  // Aceita formatos: array direto, { items: [...] }, { tags: [...] }
  let rows: Record<string, unknown>[] = [];
  if (Array.isArray(json)) rows = json as Record<string, unknown>[];
  else if (json && typeof json === "object") {
    const obj = json as Record<string, unknown>;
    const arr = obj.items ?? obj.tags ?? obj.data ?? [];
    if (Array.isArray(arr)) rows = arr as Record<string, unknown>[];
  }
  return rows
    .map((r) => ({
      id: String(r.id ?? r.Id ?? r._id ?? ""),
      name: String(r.name ?? r.Name ?? r.tagName ?? ""),
    }))
    .filter((t) => t.name);
}

/**
 * Adiciona ou remove tags do contato Helena.
 * Endpoint: POST /core/v1/contact/{contactId}/tags
 * Body: { tagNames: string[], operation: "InsertIfNotExists" | "DeleteIfExists" | "ReplaceAll" }
 * (mesma rota do node "Add Tag IA Desligada" no workflow N8N)
 */
async function postHelenaContactTags(
  account: HelenaAccount,
  contactId: string,
  body: Record<string, unknown>,
): Promise<{ ok: boolean; status: number; body: string }> {
  const base = account.baseUrl.replace(/\/$/, "");
  const res = await fetch(`${base}/core/v1/contact/${contactId}/tags`, {
    method: "POST",
    headers: {
      Authorization: account.token,
      "Content-Type": "application/*+json",
      accept: "application/json",
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { ok: res.ok, status: res.status, body: text };
}

export async function setHelenaContactTags(
  account: HelenaAccount,
  contactId: string,
  tagNames: string[],
  operation: "InsertIfNotExists" | "DeleteIfExists" | "ReplaceAll" = "InsertIfNotExists",
): Promise<{ ok: boolean; status: number; body: string }> {
  const withOp = await postHelenaContactTags(account, contactId, { tagNames, operation });
  if (withOp.ok) return withOp;

  // n8n "Add Tag IA Desligada" envia só { tagNames } — retry no insert
  if (operation === "InsertIfNotExists") {
    const minimal = await postHelenaContactTags(account, contactId, { tagNames });
    if (minimal.ok) return minimal;
    return minimal;
  }

  return withOp;
}

/** Resolve contactId para tags: sessão, contato já carregado ou telefone. */
export async function resolveHelenaContactId(
  account: HelenaAccount,
  opts: {
    sessionId?: string;
    contact?: HelenaContact | null;
    phone?: string;
  },
): Promise<string | null> {
  if (opts.contact?.id) return opts.contact.id;

  if (opts.sessionId) {
    const fromSession = await loadHelenaContactFromSession(account, opts.sessionId);
    if (fromSession?.id) return fromSession.id;
    const sess = await loadHelenaSession(account, opts.sessionId);
    if (sess?.contactId) return sess.contactId;
  }

  const phone = opts.phone ? normalizeBrazilPhone(opts.phone) : null;
  if (!phone) return null;

  const base = account.baseUrl.replace(/\/$/, "");
  const variants = [phone, phone.replace(/^\+55/, ""), `+55${phone.replace(/\D/g, "").replace(/^55/, "")}`];
  for (const p of [...new Set(variants.filter(Boolean))]) {
    try {
      const res = await fetch(
        `${base}/core/v1/contact?phone=${encodeURIComponent(p)}`,
        { headers: { Authorization: account.token, accept: "application/json" } },
      );
      if (!res.ok) continue;
      const json = (await res.json()) as
        | { id?: string | number }
        | { data?: { id?: string | number }[] }
        | null;
      const id =
        (json as { id?: string | number })?.id ??
        (json as { data?: { id?: string | number }[] })?.data?.[0]?.id;
      if (id) return String(id);
    } catch {
      /* tenta próxima variante */
    }
  }

  return null;
}

/** Atualiza telefone do contato no CRM Helena (equivalente Criar_contato do n8n). */
export async function updateHelenaContactPhone(
  account: HelenaAccount,
  contactId: string,
  phoneBr: string,
  name?: string,
): Promise<{ ok: boolean; status: number; body: string }> {
  const base = account.baseUrl.replace(/\/$/, "");
  const phone = formatPhoneE164(phoneBr);
  const body: Record<string, unknown> = { phone };
  if (name?.trim()) body.name = name.trim();

  const res = await fetch(`${base}/core/v1/contact/${contactId}`, {
    method: "PATCH",
    headers: {
      Authorization: account.token,
      "Content-Type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { ok: res.ok, status: res.status, body: text };
}

export async function sendHelenaText(
  account: HelenaAccount,
  params: {
    phone?: string;
    text: string;
    sessionId?: string;
    /** Multi-parte (bolhas separadas no WhatsApp): usa o endpoint /message (não-sync)
     *  que é o mesmo usado pelos workflows n8n e respeita a quebra em bolhas. */
    viaWhatsApp?: boolean;
  },
): Promise<{ ok: boolean; status: number; body: string }> {
  const base = account.baseUrl.replace(/\/$/, "");

  if (!params.sessionId) {
    return {
      ok: false,
      status: 400,
      body: "sessionId obrigatório para envio Helena (endpoint /chat/v1/session/<id>/message)",
    };
  }

  // Workflows n8n usam SEMPRE /chat/v1/session/{sessionId}/message — apenas
  // o /sync é variante para envio multi-parte (mantém bolhas separadas).
  // O endpoint global /v1/message/send-sync NÃO existe e foi a causa do
  // erro "400 badrequest" (Helena devolve isso para path desconhecido).
  const path = params.viaWhatsApp ? "/message/sync" : "/message";
  const url = `${base}/chat/v1/session/${params.sessionId}${path}`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: account.token,
      "Content-Type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify({ text: params.text }),
  });
  const body = await res.text();
  if (!res.ok) {
    console.error(
      `[helena] send falhou ${res.status} — endpoint=${url} sessionId=${params.sessionId} body=${body}`,
    );
  }
  return { ok: res.ok, status: res.status, body };
}

/**
 * Envia arquivo via URL pública (imagem, vídeo, áudio, PDF). Mesmo endpoint
 * do n8n workflow '03. Baixar e enviar arquivo do Google Drive'.
 */
export async function sendHelenaMediaUrl(
  account: HelenaAccount,
  params: { sessionId: string; fileUrl: string; text?: string },
): Promise<{ ok: boolean; status: number; body: string }> {
  const base = account.baseUrl.replace(/\/$/, "");
  const url = `${base}/chat/v1/session/${params.sessionId}/message`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: account.token,
      "Content-Type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify({
      fileUrl: params.fileUrl,
      ...(params.text ? { text: params.text } : {}),
    }),
  });
  const body = await res.text();
  if (!res.ok) {
    console.error(
      `[helena] media falhou ${res.status} — endpoint=${url} fileUrl=${params.fileUrl} body=${body}`,
    );
  }
  return { ok: res.ok, status: res.status, body };
}

// ============================================================
// Helena Templates (API Oficial WhatsApp Business)
// ============================================================

export interface HelenaTemplate {
  id: string;
  name: string;
  channelId: string;
  type?: string;
  content?: string;
  parameters?: string[];
  status?: string;
}

/**
 * Lista templates ATTENDANCE de um channel (canal WhatsApp Oficial).
 * O channelId vem da sessão Helena (loadHelenaSession).
 */
/**
 * Normaliza uma row do Helena. O CRM ora devolve `content`, ora `text`/`body`,
 * dependendo do tipo do template. Aqui consolidamos pra `content`.
 */
function normalizeHelenaTemplate(raw: Record<string, unknown>): HelenaTemplate {
  const r = raw as Record<string, unknown>;
  const content =
    (r.content as string | undefined) ??
    (r.text as string | undefined) ??
    (r.body as string | undefined) ??
    (r.message as string | undefined) ??
    "";
  return {
    id: String(r.id ?? ""),
    name: String(r.name ?? r.Name ?? ""),
    channelId: String(r.channelId ?? r.ChannelId ?? ""),
    type: r.type as string | undefined,
    status: r.status as string | undefined,
    content,
    parameters: r.parameters as string[] | undefined,
  };
}

/**
 * Tenta os dois paths conhecidos do Helena (os docs novos usam /v1/template,
 * mas instâncias mais antigas — e o N8N workflows — usam /chat/v1/template).
 * Para no primeiro que devolver itens.
 */
async function fetchHelenaTemplatesEndpoint(
  account: HelenaAccount,
  channelId: string,
  type: string,
  name?: string,
): Promise<{ items: Record<string, unknown>[]; pathTried: string; status: number; rawBody: string }> {
  const base = account.baseUrl.replace(/\/$/, "");
  const paths = ["/chat/v1/template", "/v1/template"];
  let last: { items: Record<string, unknown>[]; pathTried: string; status: number; rawBody: string } = {
    items: [], pathTried: "", status: 0, rawBody: "",
  };
  for (const path of paths) {
    const url = new URL(`${base}${path}`);
    url.searchParams.set("ChannelId", channelId);
    url.searchParams.set("Type", type);
    if (name) url.searchParams.set("Name", name);
    let res: Response;
    try {
      res = await fetch(url.toString(), {
        headers: { Authorization: account.token, accept: "application/json" },
      });
    } catch (e) {
      last = { items: [], pathTried: path, status: 0, rawBody: String(e) };
      continue;
    }
    const text = await res.text();
    if (!res.ok) {
      last = { items: [], pathTried: path, status: res.status, rawBody: text.slice(0, 400) };
      continue;
    }
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch { parsed = null; }
    const items: Record<string, unknown>[] = Array.isArray(parsed)
      ? (parsed as Record<string, unknown>[])
      : ((parsed as { items?: Record<string, unknown>[] })?.items ?? []);
    last = { items, pathTried: path, status: res.status, rawBody: text.slice(0, 400) };
    if (items.length > 0) {
      console.log(`[helena] templates path=${path} status=${res.status} count=${items.length}`);
      return last;
    }
    console.warn(`[helena] templates path=${path} status=${res.status} retornou 0 itens`);
  }
  return last;
}

export async function listHelenaTemplates(
  account: HelenaAccount,
  channelId: string,
  options: { type?: string } = {},
): Promise<HelenaTemplate[]> {
  const r = await fetchHelenaTemplatesEndpoint(
    account, channelId, options.type ?? "ATTENDANCE",
  );
  return r.items.map(normalizeHelenaTemplate);
}

/**
 * Busca template pelo Name (ex.: "WU1", "lembrete-24h").
 * Retorna null se não encontrar.
 */
export async function findHelenaTemplateByName(
  account: HelenaAccount,
  channelId: string,
  name: string,
): Promise<HelenaTemplate | null> {
  const r = await fetchHelenaTemplatesEndpoint(account, channelId, "ATTENDANCE", name);
  return r.items.length > 0 ? normalizeHelenaTemplate(r.items[0]) : null;
}

/**
 * Envia um template (mensagem oficial WhatsApp) numa sessão.
 * O Helena substitui os {{variáveis}} pelo conteúdo de `parameters`.
 */
export async function sendHelenaTemplate(
  account: HelenaAccount,
  params: {
    sessionId: string;
    templateId: string;
    parameters?: Record<string, string>;
  },
): Promise<{ ok: boolean; status: number; body: string }> {
  const base = account.baseUrl.replace(/\/$/, "");
  const url = `${base}/chat/v1/session/${params.sessionId}/message/sync`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: account.token,
      accept: "application/json",
      "Content-Type": "application/*+json",
    },
    body: JSON.stringify({
      templateId: params.templateId,
      parameters: params.parameters ?? {},
    }),
  });
  const body = await res.text();
  if (!res.ok) {
    console.error(
      `[helena] template send falhou ${res.status} — sessionId=${params.sessionId} templateId=${params.templateId} body=${body}`,
    );
  }
  return { ok: res.ok, status: res.status, body };
}

export async function sendHelenaAudio(
  account: HelenaAccount,
  params: { phone?: string; audioUrl: string; sessionId?: string },
): Promise<{ ok: boolean; status: number; body: string }> {
  const base = account.baseUrl.replace(/\/$/, "");

  if (!params.sessionId) {
    return {
      ok: false,
      status: 400,
      body: "sessionId obrigatório para envio de áudio Helena",
    };
  }

  const url = `${base}/chat/v1/session/${params.sessionId}/message/sync`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: account.token,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ fileUrl: params.audioUrl }),
  });
  const body = await res.text();
  if (!res.ok) {
    console.error(
      `[helena] audio falhou ${res.status} — endpoint=${url} sessionId=${params.sessionId} body=${body}`,
    );
  }
  return { ok: res.ok, status: res.status, body };
}
