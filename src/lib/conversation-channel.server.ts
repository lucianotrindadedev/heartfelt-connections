// Utilitários multicanal: canal, chave de conversa, telefone para Clinicorp.
// Server-only.

export type ConversationChannel = "whatsapp" | "instagram" | "messenger" | "unknown";

/** Remove não-dígitos; retorna null se não parecer telefone BR (10–13 dígitos). */
export function normalizeBrazilPhone(raw: string | null | undefined): string | null {
  if (!raw?.trim()) return null;
  const digits = raw.replace(/\D/g, "");
  if (digits.length < 10 || digits.length > 13) return null;
  if (digits.length > 11 && !digits.startsWith("55")) return null;
  let n = digits;
  if (n.startsWith("55") && n.length >= 12) n = n.slice(2);
  if (n.length === 10 || n.length === 11) return n;
  return null;
}

export function formatPhoneE164(brPhone: string): string {
  const d = brPhone.replace(/\D/g, "");
  if (d.startsWith("55")) return `+${d}`;
  return `+55${d}`;
}

export function isLikelyWhatsAppIdentifier(from: string): boolean {
  return normalizeBrazilPhone(from) !== null;
}

export function detectChannelFromSession(channelId: string | null | undefined): ConversationChannel {
  if (!channelId) return "unknown";
  const c = channelId.toLowerCase();
  if (c.includes("instagram") || c.includes("ig")) return "instagram";
  if (c.includes("messenger") || c.includes("facebook") || c.includes("fb")) return "messenger";
  if (c.includes("whatsapp") || c.includes("wa")) return "whatsapp";
  return "unknown";
}

export function detectChannelFromContact(contact: {
  instagram?: string | null;
  messengerId?: string | null;
  phoneNumber?: string | null;
}): ConversationChannel {
  if (contact.instagram?.trim()) return "instagram";
  if (contact.messengerId?.trim()) return "messenger";
  if (normalizeBrazilPhone(contact.phoneNumber)) return "whatsapp";
  return "unknown";
}

/** Chave interna em conversations.phone (nem sempre é telefone real). */
export function buildConversationKey(params: {
  channel: ConversationChannel;
  fromDetails?: string | null;
  instagram?: string | null;
  messengerId?: string | null;
  sessionId?: string | null;
  leadPhone?: string | null;
  contactPhone?: string | null;
}): string {
  const wa =
    normalizeBrazilPhone(params.leadPhone) ??
    normalizeBrazilPhone(params.contactPhone) ??
    normalizeBrazilPhone(params.fromDetails);

  if (wa) return wa;

  if (params.channel === "instagram" && params.instagram?.trim()) {
    return `ig:${params.instagram.trim()}`;
  }
  if (params.channel === "messenger" && params.messengerId?.trim()) {
    return `fb:${params.messengerId.trim()}`;
  }
  if (params.instagram?.trim()) return `ig:${params.instagram.trim()}`;
  if (params.messengerId?.trim()) return `fb:${params.messengerId.trim()}`;

  const from = params.fromDetails?.trim();
  if (from && !isLikelyWhatsAppIdentifier(from)) {
    if (params.channel === "instagram") return `ig:${from}`;
    if (params.channel === "messenger") return `fb:${from}`;
    return `ch:${from}`;
  }

  if (params.sessionId?.trim()) return `sess:${params.sessionId.trim()}`;

  return from || "unknown";
}

export interface EffectivePhoneResult {
  phone: string | null;
  source: "lead_phone" | "crm" | "conversation_key" | null;
}

export function resolveEffectivePhone(params: {
  leadPhone?: string | null;
  contactPhone?: string | null;
  conversationPhone?: string | null;
}): EffectivePhoneResult {
  const fromLead = normalizeBrazilPhone(params.leadPhone);
  if (fromLead) return { phone: fromLead, source: "lead_phone" };

  const fromCrm = normalizeBrazilPhone(params.contactPhone);
  if (fromCrm) return { phone: fromCrm, source: "crm" };

  const fromConv = normalizeBrazilPhone(params.conversationPhone);
  if (fromConv) return { phone: fromConv, source: "conversation_key" };

  return { phone: null, source: null };
}
