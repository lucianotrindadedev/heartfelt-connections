// Helper centralizado para aplicar tags no Helena CRM seguindo o padrão:
// 1. Lista tags existentes via GET /core/v1/tag
// 2. Faz match fuzzy (case-insensitive + sem acento) com o nome solicitado
// 3. Se encontrar, aplica o nome EXATO (não cria nova)
// 4. Se não encontrar, NÃO aplica e retorna erro (evita poluir o CRM)
//
// AGNÓSTICO DE NEGÓCIO: os agentes atendem clínicas, escolas, e qualquer
// outro nicho. As ÚNICAS tags com nome fixo são as 2 de status do funil:
//   • "Não Agendado" (sinônimos: N/A, NA, "Lead", "Aguardando")
//   • "Agendado" (sinônimos: Confirmado, Matriculado, Compatível)
// Tags de interesse são totalmente abertas — dependem do CRM da clínica/escola.
//
// Regras de fluxo:
//   • Início do atendimento:    aplicar tag "não agendado" (sinônimo do CRM)
//   • Durante a qualificação:   aplicar UMA tag de interesse principal
//   • Ao confirmar agendamento: remover "não agendado" + adicionar "agendado"
//                                MANTÉM a tag de interesse.

import {
  listHelenaTags,
  setHelenaContactTags,
  type HelenaAccount,
  type HelenaTag,
} from "@/lib/helena.server";

/**
 * Sinônimos prováveis para a tag de "lead recebido / ainda não agendado".
 * O resolver procura no CRM da conta qual desses está cadastrado.
 */
export const NOT_SCHEDULED_SYNONYMS = [
  "N/A Não Agendado",
  "N/A",
  "NA",
  "Não Agendado",
  "Nao Agendado",
  "Não Compareceu",
  "Lead",
  "Aguardando",
] as const;

/**
 * Sinônimos prováveis para a tag de "agendamento confirmado".
 */
export const SCHEDULED_SYNONYMS = [
  "Agendado",
  "AGENDADO",
  "Confirmado",
  "Matriculado",
  "Compatível",
  "Compativel",
  "IA Agendou",
] as const;

/**
 * Tags de "controle do sistema" — gerenciadas automaticamente pelo orquestrador.
 * Excluídas da lista mostrada ao LLM (que escolhe só tags de INTERESSE).
 */
const SYSTEM_TAG_KEYWORDS = [
  ...NOT_SCHEDULED_SYNONYMS,
  ...SCHEDULED_SYNONYMS,
  "IA Desligada",
  "IA Off",
  "Bot Off",
  "FALTOSOS",
  "FUF FINANCEIRO",
];

function normalize(s: string): string {
  return (s ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .trim()
    .toLowerCase();
}

/** Cache curto (memo no processo) das tags por conta, para evitar GET a cada turn. */
const tagsCache = new Map<string, { tags: HelenaTag[]; at: number }>();
const CACHE_TTL_MS = 60_000; // 1 min — o suficiente para acoplar várias chamadas no mesmo turn

async function getTags(account: HelenaAccount): Promise<HelenaTag[]> {
  const cached = tagsCache.get(account.id);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.tags;
  const tags = await listHelenaTags(account);
  tagsCache.set(account.id, { tags, at: Date.now() });
  return tags;
}

/**
 * Resolve um nome aproximado para o nome exato registrado no CRM.
 * Retorna `null` se não houver match.
 */
export async function resolveTagName(
  account: HelenaAccount,
  approximateName: string,
): Promise<string | null> {
  const tags = await getTags(account);
  const target = normalize(approximateName);
  if (!target) return null;

  // 1. Match exato (case-insensitive + sem acento)
  const exact = tags.find((t) => normalize(t.name) === target);
  if (exact) return exact.name;

  // 2. Match por contém (mais permissivo) — pega o mais curto, evita ambiguidade
  const partial = tags
    .filter((t) => {
      const n = normalize(t.name);
      return n.includes(target) || target.includes(n);
    })
    .sort((a, b) => a.name.length - b.name.length);

  return partial[0]?.name ?? null;
}

/**
 * Tenta resolver um conjunto de sinônimos contra o CRM, retornando o primeiro
 * que existe. Útil para encontrar o nome EXATO da tag de status:
 *   resolveOneOf(account, ["N/A", "Não Agendado", "Lead"])
 *   → "N/A Não Agendado" (se for esse o nome cadastrado nessa conta)
 */
export async function resolveOneOf(
  account: HelenaAccount,
  synonyms: readonly string[],
): Promise<string | null> {
  for (const syn of synonyms) {
    const found = await resolveTagName(account, syn);
    if (found) return found;
  }
  return null;
}

/**
 * Aplica UMA tag (resolvida pelo nome aproximado) ao contato.
 * Se a tag não existe no CRM, NÃO cria — retorna { ok: false, reason: "not_found" }.
 */
export async function applyTagByApproxName(
  account: HelenaAccount,
  contactId: string,
  approximateName: string,
  operation: "InsertIfNotExists" | "DeleteIfExists" | "ReplaceAll" = "InsertIfNotExists",
): Promise<{ ok: boolean; tag?: string; reason?: string; status?: number; body?: string }> {
  const exact = await resolveTagName(account, approximateName);
  if (!exact) {
    return { ok: false, reason: "not_found" };
  }
  const res = await setHelenaContactTags(account, contactId, [exact], operation);
  if (!res.ok) {
    return { ok: false, reason: "helena_error", status: res.status, body: res.body };
  }
  return { ok: true, tag: exact };
}

/**
 * Operação "swap" usando listas de sinônimos: remove a primeira tag do CRM
 * que casar com `removeSynonyms` e adiciona a primeira que casar com
 * `addSynonyms`. Atomicidade lógica via 2 chamadas REST.
 */
export async function swapTagBySynonyms(
  account: HelenaAccount,
  contactId: string,
  removeSynonyms: readonly string[],
  addSynonyms: readonly string[],
): Promise<{ ok: boolean; removed?: string; added?: string; reason?: string }> {
  const [removeExact, addExact] = await Promise.all([
    resolveOneOf(account, removeSynonyms),
    resolveOneOf(account, addSynonyms),
  ]);

  if (!addExact) return { ok: false, reason: "add_tag_not_found" };

  if (removeExact) {
    await setHelenaContactTags(account, contactId, [removeExact], "DeleteIfExists");
  }
  const res = await setHelenaContactTags(account, contactId, [addExact], "InsertIfNotExists");
  if (!res.ok) {
    return { ok: false, reason: "helena_error" };
  }
  return { ok: true, removed: removeExact ?? undefined, added: addExact };
}

/**
 * Aplica a primeira tag dos sinônimos que estiver cadastrada no CRM.
 * Útil para a tag de "ainda não agendado" no início do funil — cada cliente
 * pode ter um nome diferente ("N/A", "Lead", "Aguardando"...).
 */
export async function applyOneOfTags(
  account: HelenaAccount,
  contactId: string,
  synonyms: readonly string[],
  operation: "InsertIfNotExists" | "DeleteIfExists" | "ReplaceAll" = "InsertIfNotExists",
): Promise<{ ok: boolean; tag?: string; reason?: string }> {
  const exact = await resolveOneOf(account, synonyms);
  if (!exact) return { ok: false, reason: "no_synonym_found" };

  const res = await setHelenaContactTags(account, contactId, [exact], operation);
  if (!res.ok) return { ok: false, reason: "helena_error" };
  return { ok: true, tag: exact };
}

/** Verifica se uma tag é "tag de sistema" (status, controle) e deve ser
 *  ESCONDIDA do prompt — o LLM só escolhe entre tags de interesse. */
function isSystemTag(name: string): boolean {
  const n = normalize(name);
  return SYSTEM_TAG_KEYWORDS.some((kw) => n === normalize(kw) || n.includes(normalize(kw)));
}

/**
 * Retorna lista de tags disponíveis para o LLM escolher como TAG DE INTERESSE.
 * Exclui tags conhecidas do funil/sistema (N/A, AGENDADO, IA Desligada,
 * FALTOSOS, etc.) — o LLM só deve aplicar tags de interesse do negócio.
 * Cacheado por 1 min.
 */
export async function getInterestCandidateTagNames(
  account: HelenaAccount,
): Promise<string[]> {
  const tags = await getTags(account);
  return tags.map((t) => t.name).filter((name) => !isSystemTag(name));
}

/** Lista TODAS as tags do CRM — sem filtro. Para diagnóstico ou logs. */
export async function getAllTagNames(account: HelenaAccount): Promise<string[]> {
  const tags = await getTags(account);
  return tags.map((t) => t.name);
}
