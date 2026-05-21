// Limpa histórico LLM de uma conversa (comando /reset ou painel admin).
import { getSelfhost } from "@/integrations/selfhost/client.server";

export function isResetCommand(text: string): boolean {
  const t = text.trim().toLowerCase().replace(/\s+/g, "");
  return t === "/reset" || t === "reset" || t === "/resetar" || t === "resetar";
}

export const RESET_CONFIRMATION_MESSAGE = "Memória resetada";

/** Apaga mensagens, fila de debounce e estado — não dispara o agente. */
export async function resetConversationHistory(conversationId: string): Promise<void> {
  const sb = getSelfhost();

  await sb.from("messages").delete().eq("conversation_id", conversationId);

  await sb.from("message_queue").delete().eq("conversation_id", conversationId);

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
}
