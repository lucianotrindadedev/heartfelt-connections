// Bloqueio da IA por etiqueta no CRM Helena.
//
// Regra única usada por TODOS os caminhos que mandam mensagem automática
// (webhook de entrada, follow-up, warm-up): se o contato tem a etiqueta fixa
// "IA Desligada" (escalada humana) ou qualquer etiqueta configurada em
// settings.blocked_tags, a IA NÃO deve falar com esse contato.
//
// Antes, só o webhook de entrada checava isso — follow-up e warm-up enviavam
// mesmo com "IA Desligada", e o webhook falhava "aberto" (respondia) quando o
// contato não carregava do CRM. Este módulo centraliza a regra.
import {
  loadHelenaAccount,
  loadHelenaContactFromSession,
  type HelenaAccount,
  type HelenaContact,
} from "@/lib/helena.server";

export const AI_DISABLED_TAG = "IA Desligada";

/** Normaliza p/ comparação: sem acento, sem espaços nas pontas, maiúsculo. */
export function normalizeBlockTag(s: string): string {
  return (s ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .trim()
    .toUpperCase();
}

/** "IA Desligada" (sempre) + as etiquetas de settings.blocked_tags (vírgula/;/quebra). */
export function parseBlockedTags(raw: string | null | undefined): string[] {
  const tags = [AI_DISABLED_TAG];
  if (raw?.trim()) {
    for (const t of raw.split(/[,;\n]/)) {
      const v = t.trim();
      if (v) tags.push(v);
    }
  }
  return tags;
}

/** Retorna a etiqueta bloqueadora que o contato possui (nome real), ou null. */
export function findBlockingTag(
  tagNames: string[],
  blockedTags: string[],
): string | null {
  const set = new Set(blockedTags.map(normalizeBlockTag));
  for (const t of tagNames ?? []) {
    if (set.has(normalizeBlockTag(t))) return t;
  }
  return null;
}

export interface BlockCheck {
  /** true = contato tem etiqueta que pausa a IA. */
  blocked: boolean;
  /** Nome da etiqueta bloqueadora (quando blocked). */
  tag: string | null;
  /** false = não foi possível carregar o contato do CRM (tags desconhecidas). */
  resolved: boolean;
}

/**
 * Verifica, a partir de um contato JÁ carregado, se a IA está pausada.
 */
export function checkContactBlocked(
  contact: HelenaContact | null,
  blockedTagsRaw: string | null | undefined,
): BlockCheck {
  const blockedTags = parseBlockedTags(blockedTagsRaw);
  if (!contact) return { blocked: false, tag: null, resolved: false };
  const tag = findBlockingTag(contact.tagNames, blockedTags);
  return { blocked: !!tag, tag, resolved: true };
}

/**
 * Carrega o contato pela sessão Helena e verifica o bloqueio. Usado pelos crons
 * (follow-up/warm-up) e como recheck fail-safe no webhook.
 *
 * `resolved=false` significa que o contato não pôde ser lido (sessão ausente ou
 * falha no CRM) — quem chama decide o que fazer (crons: prosseguir; webhook
 * inbound: não responder, fail-safe).
 */
export async function checkContactBlockedBySession(params: {
  accountId: string;
  sessionId?: string | null;
  blockedTagsRaw?: string | null;
  helena?: HelenaAccount | null;
}): Promise<BlockCheck> {
  if (!params.sessionId) return { blocked: false, tag: null, resolved: false };
  try {
    const helena = params.helena ?? (await loadHelenaAccount(params.accountId));
    const contact = await loadHelenaContactFromSession(helena, params.sessionId);
    return checkContactBlocked(contact, params.blockedTagsRaw);
  } catch {
    return { blocked: false, tag: null, resolved: false };
  }
}
