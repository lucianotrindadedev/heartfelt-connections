// Helper centralizado para aplicar tags no Helena CRM seguindo o padrão:
// 1. Lista tags existentes via GET /core/v1/tag
// 2. Faz match fuzzy (case-insensitive + sem acento) com o nome solicitado
// 3. Se encontrar, aplica o nome EXATO (não cria nova)
// 4. Se não encontrar, NÃO aplica e retorna erro (evita poluir o CRM)
//
// Regras de fluxo do agente (qualifier + scheduler):
//   • Início do atendimento:    aplicar "N/A Não Agendado" (ou compatível)
//   • Durante a qualificação:   aplicar UMA tag de interesse principal
//   • Ao confirmar agendamento: remover "N/A Não Agendado" + adicionar
//                                "Agendado" (ou compatível). MANTÉM a tag
//                                de interesse.

import {
  listHelenaTags,
  setHelenaContactTags,
  type HelenaAccount,
  type HelenaTag,
} from "@/lib/helena.server";

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
 * Operação "swap": remove uma tag e adiciona outra na mesma chamada lógica.
 * Útil ao confirmar agendamento (remove "N/A Não Agendado", adiciona "Agendado").
 */
export async function swapTag(
  account: HelenaAccount,
  contactId: string,
  removeName: string,
  addName: string,
): Promise<{ ok: boolean; removed?: string; added?: string; reason?: string }> {
  // Resolve ambos antes — se nenhum existir, evita parcial
  const [removeExact, addExact] = await Promise.all([
    resolveTagName(account, removeName),
    resolveTagName(account, addName),
  ]);

  if (!addExact) return { ok: false, reason: "add_tag_not_found" };

  // Remove a tag de status anterior (se existir no CRM)
  if (removeExact) {
    await setHelenaContactTags(account, contactId, [removeExact], "DeleteIfExists");
  }
  // Adiciona a nova
  const res = await setHelenaContactTags(account, contactId, [addExact], "InsertIfNotExists");
  if (!res.ok) {
    return { ok: false, reason: "helena_error" };
  }
  return { ok: true, removed: removeExact ?? undefined, added: addExact };
}

/**
 * Retorna lista de tags disponíveis para mostrar ao LLM (apenas nomes).
 * Cacheado por 1 min para evitar requisições repetidas.
 */
export async function getAvailableTagNames(account: HelenaAccount): Promise<string[]> {
  const tags = await getTags(account);
  return tags.map((t) => t.name);
}
