// Verifica se a última mensagem da conversa ainda é do lead (sem resposta do agente).
import { getSelfhost } from "@/integrations/selfhost/client.server";
import { isPlatformNotice } from "@/lib/platform-notice";

export async function conversationNeedsAgentReply(
  conversationId: string,
): Promise<boolean> {
  const sb = getSelfhost();
  // Busca as últimas mensagens e ignora ecos/fallbacks: um eco da própria
  // plataforma (is_echo) não pode "esconder" uma mensagem do lead ainda sem
  // resposta. Desempate por id mantém a ordem estável em rajadas.
  const { data } = await sb
    .from("messages")
    .select("role, content, meta")
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
    // Texto vazio (reação, mensagem apagada) e aviso da plataforma ("*Atenção:*
    // … não suportada") não são fala do lead: não pedem resposta, mas também
    // não escondem uma fala real anterior sem resposta. Mesmo filtro do
    // histórico do LLM. Cada um disparava um turno e a IA "respondia" ao nada
    // (Sorriso Saúde, Domisalia 02/09 e Luiz Mário 07/09).
    if (m.role === "user") {
      const content = (m.content as string | null) ?? "";
      if (!content.trim() || meta?.platform_notice === true || isPlatformNotice(content)) continue;
    }
    return m.role === "user";
  }
  return false;
}
