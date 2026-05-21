// Fila de mensagens com debounce para agrupamento antes de rodar o agente.
import { getSelfhost } from "@/integrations/selfhost/client.server";
import { runAgentTurn, ConversationLockedError } from "@/lib/agent-turn.server";

export async function enqueueMessage(
  conversationId: string,
  delaySeconds: number,
): Promise<void> {
  const sb = getSelfhost();
  const executeAt = new Date(Date.now() + delaySeconds * 1000).toISOString();
  await sb.from("message_queue").insert({
    conversation_id: conversationId,
    execute_at: executeAt,
    processed: false,
  });
}

export async function processQueue(): Promise<{ processed: number; skipped: number }> {
  const sb = getSelfhost();
  const now = new Date().toISOString();

  // Busca itens prontos para processar
  const { data: items, error } = await sb
    .from("message_queue")
    .select("id, conversation_id, execute_at")
    .eq("processed", false)
    .lte("execute_at", now)
    .order("execute_at", { ascending: true });

  if (error || !items?.length) return { processed: 0, skipped: 0 };

  let processed = 0;
  let skipped = 0;

  // Deduplica por conversation_id: processa apenas o item mais recente por conversa
  const latestByConv = new Map<string, { id: string; execute_at: string }>();
  for (const item of items) {
    const existing = latestByConv.get(item.conversation_id as string);
    if (!existing || item.execute_at > existing.execute_at) {
      latestByConv.set(item.conversation_id as string, {
        id: item.id as string,
        execute_at: item.execute_at as string,
      });
    }
  }

  const allIds = items.map((i: { id: unknown }) => i.id as string);
  const processIds = Array.from(latestByConv.values()).map((v) => v.id);
  const skipIds = allIds.filter((id: string) => !processIds.includes(id));

  // Marca todos como processed (skip os duplicados)
  if (skipIds.length > 0) {
    await sb.from("message_queue").update({ processed: true }).in("id", skipIds);
    skipped += skipIds.length;
  }

  // Processa os únicos por conversa
  for (const { id, execute_at: _eat } of latestByConv.values()) {
    const item = items.find((i: { id: unknown }) => i.id === id)!;
    const convId = item.conversation_id as string;

    // Verifica se tem mensagem mais nova que ainda não está na fila processada
    // (nova mensagem chegou depois deste item ser enfileirado)
    const { data: newer } = await sb
      .from("message_queue")
      .select("id")
      .eq("conversation_id", convId)
      .eq("processed", false)
      .gt("execute_at", item.execute_at as string)
      .limit(1);

    if (newer && newer.length > 0) {
      // Tem item mais recente pendente → pula este
      await sb.from("message_queue").update({ processed: true }).eq("id", id);
      skipped++;
      continue;
    }

    try {
      await runAgentTurn(convId);
      await sb.from("message_queue").update({ processed: true }).eq("id", id);
      processed++;
    } catch (e) {
      if (e instanceof ConversationLockedError) {
        console.log(`[queue] ${convId} ainda bloqueada — item mantido na fila`);
        continue;
      }
      console.error(`[queue] agent-turn falhou para ${convId}:`, e);
      // Não marca processed — próximo tick da fila tenta de novo
    }
  }

  return { processed, skipped };
}
