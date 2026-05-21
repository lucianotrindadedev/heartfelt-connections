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
    Authorization: `Bearer ${account.token}`,
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
      headers: { Authorization: `Bearer ${account.token}`, accept: "application/json" },
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
      Authorization: `Bearer ${account.token}`,
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
        { headers: { Authorization: `Bearer ${account.token}`, accept: "application/json" } },
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
      Authorization: `Bearer ${account.token}`,
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
  params: { phone?: string; text: string; sessionId?: string },
): Promise<{ ok: boolean; status: number; body: string }> {
  const base = account.baseUrl.replace(/\/$/, "");

  if (params.sessionId) {
    const url = `${base}/chat/v1/session/${params.sessionId}/message/sync`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${account.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ text: params.text }),
    });
    const body = await res.text();
    if (res.ok) return { ok: true, status: res.status, body };
    console.warn(`[helena] sessão ${params.sessionId} falhou (${res.status}), tentando send-sync`);
  }

  const toPhone = normalizeBrazilPhone(params.phone);
  if (!toPhone) {
    return {
      ok: false,
      status: 400,
      body: "Telefone ausente e envio por sessão falhou ou sessionId não informado",
    };
  }

  const url = `${base}/v1/message/send-sync`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${account.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      to: formatPhoneE164(toPhone),
      from: null,
      body: { text: params.text },
      options: params.sessionId ? { sessionId: params.sessionId } : undefined,
    }),
  });
  const body = await res.text();
  return { ok: res.ok, status: res.status, body };
}

export async function sendHelenaAudio(
  account: HelenaAccount,
  params: { phone?: string; audioUrl: string; sessionId?: string },
): Promise<{ ok: boolean; status: number; body: string }> {
  const base = account.baseUrl.replace(/\/$/, "");

  if (params.sessionId) {
    const url = `${base}/chat/v1/session/${params.sessionId}/message/sync`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${account.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ fileUrl: params.audioUrl }),
    });
    const body = await res.text();
    if (res.ok) return { ok: true, status: res.status, body };
  }

  const toPhone = normalizeBrazilPhone(params.phone);
  if (!toPhone) {
    return { ok: false, status: 400, body: "Telefone ausente para envio de áudio" };
  }

  const url = `${base}/v1/message/send-sync`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${account.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      to: formatPhoneE164(toPhone),
      from: null,
      body: { fileUrl: params.audioUrl },
    }),
  });
  const body = await res.text();
  return { ok: res.ok, status: res.status, body };
}
