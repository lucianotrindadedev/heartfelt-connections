// Fila de debounce do agente — Redis (BullMQ) quando REDIS_URL; senão Postgres message_queue.
import { getSelfhost } from "@/integrations/selfhost/client.server";
import { runAgentTurn, ConversationLockedError } from "@/lib/agent-turn.server";
import { conversationNeedsAgentReply } from "@/lib/conversation-reply.server";
import {
  cancelAgentTurnJobs,
  enqueueAgentTurn,
} from "@/lib/agent-queue-redis.server";
import { isRedisAgentQueueActive, isRedisConfigured } from "@/lib/redis.server";

export async function enqueueMessage(
  conversationId: string,
  delaySeconds: number,
): Promise<void> {
  if (isRedisAgentQueueActive()) {
    await enqueueAgentTurn(conversationId, delaySeconds);
    return;
  }

  const sb = getSelfhost();
  const executeAt = new Date(Date.now() + delaySeconds * 1000).toISOString();
  await sb.from("message_queue").insert({
    conversation_id: conversationId,
    execute_at: executeAt,
    processed: false,
  });
}

/** Limpa fila pendente (reset, pause IA). */
export async function clearConversationQueue(conversationId: string): Promise<void> {
  await cancelAgentTurnJobs(conversationId);

  const sb = getSelfhost();
  await sb
    .from("message_queue")
    .update({ processed: true })
    .eq("conversation_id", conversationId)
    .eq("processed", false);
}

export async function processQueue(): Promise<{ processed: number; skipped: number }> {
  if (isRedisAgentQueueActive()) {
    return { processed: 0, skipped: 0 };
  }

  const sb = getSelfhost();
  const now = new Date().toISOString();

  const { data: items, error } = await sb
    .from("message_queue")
    .select("id, conversation_id, execute_at")
    .eq("processed", false)
    .lte("execute_at", now)
    .order("execute_at", { ascending: true });

  if (error || !items?.length) return { processed: 0, skipped: 0 };

  let processed = 0;
  let skipped = 0;

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

  if (skipIds.length > 0) {
    await sb.from("message_queue").update({ processed: true }).in("id", skipIds);
    skipped += skipIds.length;
  }

  for (const { id, execute_at: _eat } of latestByConv.values()) {
    const item = items.find((i: { id: unknown }) => i.id === id)!;
    const convId = item.conversation_id as string;

    const { data: newer } = await sb
      .from("message_queue")
      .select("id")
      .eq("conversation_id", convId)
      .eq("processed", false)
      .gt("execute_at", item.execute_at as string)
      .limit(1);

    if (newer && newer.length > 0) {
      await sb.from("message_queue").update({ processed: true }).eq("id", id);
      skipped++;
      continue;
    }

    if (!(await conversationNeedsAgentReply(convId))) {
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
    }
  }

  return { processed, skipped };
}
