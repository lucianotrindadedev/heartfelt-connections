// Lock atômico por conversa — evita dois turnos do agente em paralelo.
import { getSelfhost } from "@/integrations/selfhost/client.server";

const STALE_LOCK_MS = 4 * 60 * 1000;

export async function clearStaleConversationLock(conversationId: string): Promise<void> {
  const sb = getSelfhost();
  const { data } = await sb
    .from("conversation_state")
    .select("lock_conversa, atualizado_em")
    .eq("conversation_id", conversationId)
    .maybeSingle();

  if (!data?.lock_conversa) return;

  const updatedAt = data.atualizado_em
    ? new Date(data.atualizado_em as string).getTime()
    : 0;
  if (Date.now() - updatedAt < STALE_LOCK_MS) return;

  console.warn(
    `[lock] obsoleto em ${conversationId} (>${STALE_LOCK_MS / 1000}s) — liberando`,
  );
  await sb
    .from("conversation_state")
    .update({ lock_conversa: false })
    .eq("conversation_id", conversationId);
}

/** Garante linha em conversation_state sem alterar lock existente. */
async function ensureConversationStateRow(conversationId: string): Promise<void> {
  const sb = getSelfhost();
  const { data } = await sb
    .from("conversation_state")
    .select("conversation_id")
    .eq("conversation_id", conversationId)
    .maybeSingle();
  if (data) return;
  await sb.from("conversation_state").insert({
    conversation_id: conversationId,
    lock_conversa: false,
  });
}

/**
 * Tenta adquirir lock (compare-and-set). Retorna false se outro turno já tem o lock.
 */
export async function tryAcquireConversationLock(conversationId: string): Promise<boolean> {
  const sb = getSelfhost();
  await ensureConversationStateRow(conversationId);
  const { data, error } = await sb
    .from("conversation_state")
    .update({
      lock_conversa: true,
      atualizado_em: new Date().toISOString(),
    })
    .eq("conversation_id", conversationId)
    .eq("lock_conversa", false)
    .select("conversation_id");

  if (error) {
    console.error(`[lock] falha ao adquirir ${conversationId}:`, error.message);
    return false;
  }
  return (data?.length ?? 0) > 0;
}

export async function releaseConversationLock(conversationId: string): Promise<void> {
  const sb = getSelfhost();
  await sb
    .from("conversation_state")
    .update({ lock_conversa: false, atualizado_em: new Date().toISOString() })
    .eq("conversation_id", conversationId);
}
