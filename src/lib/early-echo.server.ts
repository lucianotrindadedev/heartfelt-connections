// Marca como eco o que a Helena reentregou ANTES de a nossa mensagem ser
// gravada — ver earlyEchoIds em helena-echo.server.ts.
import type { getSelfhost } from "@/integrations/selfhost/client.server";
import { earlyEchoIds, type EarlyEchoCandidate } from "@/lib/helena-echo.server";

/** Folga para relógio do banco x relógio do servidor. */
const CLOCK_SKEW_MS = 2_000;

/**
 * Chamar logo depois de gravar uma mensagem NOSSA (agente, follow-up, warm-up).
 *
 * @param ownTexts a mensagem gravada e as bolhas exatamente como saíram.
 * @param sentSince instante ANTES do primeiro envio — só o que chegou depois
 *   disso pode ser eco (a fala que estamos respondendo veio antes).
 *
 * Nunca lança: falhar aqui só deixa o eco sem marca (o histórico do LLM ainda
 * o separa por isHumanStaffMessage).
 */
export async function markEchoesReceivedBeforeSend(
  sb: ReturnType<typeof getSelfhost>,
  conversationId: string,
  ownTexts: string[],
  sentSince: Date,
): Promise<number> {
  try {
    const { data, error } = await sb
      .from("messages")
      .select("id, role, content, meta")
      .eq("conversation_id", conversationId)
      .gte("criado_em", new Date(sentSince.getTime() - CLOCK_SKEW_MS).toISOString());
    if (error || !data) return 0;
    const rows = data as EarlyEchoCandidate[];
    const ids = earlyEchoIds(ownTexts, rows);
    for (const id of ids) {
      const row = rows.find((r) => r.id === id)!;
      await sb
        .from("messages")
        .update({ meta: { ...(row.meta ?? {}), is_echo: true, echo_marked_after_send: true } })
        .eq("id", id);
    }
    if (ids.length > 0) {
      console.log(
        `[echo] ${ids.length} eco(s) recebido(s) antes de gravar o envio — marcado(s) (conv ${conversationId})`,
      );
    }
    return ids.length;
  } catch (e) {
    console.warn(`[echo] falha ao marcar ecos antecipados (conv ${conversationId}):`, e);
    return 0;
  }
}
