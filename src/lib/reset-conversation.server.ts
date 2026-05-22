// Limpa histórico LLM de uma conversa (comando /reset ou painel admin).
import { getSelfhost } from "@/integrations/selfhost/client.server";
import { clearConversationQueue } from "@/lib/message-queue.server";

export function isResetCommand(text: string): boolean {
  const t = text.trim().toLowerCase().replace(/\s+/g, "");
  return t === "/reset" || t === "reset" || t === "/resetar" || t === "resetar";
}

export const RESET_CONFIRMATION_MESSAGE = "Memória resetada";

/**
 * Apaga mensagens, fila de debounce, estado E zera o stage da máquina multi-agente.
 * Após reset, próxima mensagem do lead inicia em RECEPTION com lead_data vazio.
 * Não dispara o agente.
 */
export async function resetConversationHistory(conversationId: string): Promise<void> {
  const sb = getSelfhost();

  await sb.from("messages").delete().eq("conversation_id", conversationId);

  await clearConversationQueue(conversationId);

  await sb.from("conversation_state").upsert(
    {
      conversation_id: conversationId,
      lock_conversa: false,
      aguardando_followup: false,
      numero_followup: 0,
      last_user_message_at: null,
    },
    { onConflict: "conversation_id" },
  );

  // Zera stage e lead_data preservando outros campos de conversations.meta.
  const { data: conv } = await sb
    .from("conversations")
    .select("meta")
    .eq("id", conversationId)
    .maybeSingle();
  const existingMeta = (conv?.meta as Record<string, unknown> | null) ?? {};
  const cleanedMeta = { ...existingMeta, stage: "RECEPTION", lead_data: {}, current_agent: null };
  await sb.from("conversations").update({ meta: cleanedMeta }).eq("id", conversationId);
}
