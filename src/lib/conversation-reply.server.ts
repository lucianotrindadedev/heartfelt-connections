// Verifica se a última mensagem da conversa ainda é do lead (sem resposta do agente).
import { getSelfhost } from "@/integrations/selfhost/client.server";

export async function conversationNeedsAgentReply(
  conversationId: string,
): Promise<boolean> {
  const sb = getSelfhost();
  // Busca as últimas mensagens e ignora ecos/fallbacks: um eco da própria
  // plataforma (is_echo) não pode "esconder" uma mensagem do lead ainda sem
  // resposta. Desempate por id mantém a ordem estável em rajadas.
  const { data } = await sb
    .from("messages")
    .select("role, meta")
    .eq("conversation_id", conversationId)
    .order("criado_em", { ascending: false })
    .order("id", { ascending: false })
    .limit(10);

  for (const m of data ?? []) {
    const meta = (m.meta as Record<string, unknown> | null) ?? null;
    if (meta?.is_echo === true || meta?.fallback === true) continue;
    // Eventos TRACK (status/rastreamento) não são mensagens reais — não podem
    // "esconder" uma mensagem do lead ainda sem resposta nem contar como resposta.
    if (meta?.tipo === "TRACK") continue;
    return m.role === "user";
  }
  return false;
}
