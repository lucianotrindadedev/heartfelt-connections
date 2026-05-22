// Verifica se a última mensagem da conversa ainda é do lead (sem resposta do agente).
import { getSelfhost } from "@/integrations/selfhost/client.server";

export async function conversationNeedsAgentReply(
  conversationId: string,
): Promise<boolean> {
  const sb = getSelfhost();
  const { data } = await sb
    .from("messages")
    .select("role")
    .eq("conversation_id", conversationId)
    .order("criado_em", { ascending: false })
    .limit(1)
    .maybeSingle();

  return data?.role === "user";
}
