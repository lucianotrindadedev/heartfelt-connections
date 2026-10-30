// Mídia de abertura: uma mídia da biblioteca do agente (ex.: arte de campanha)
// enviada UMA vez, logo antes da primeira resposta da conversa.
//
// Não dá para deixar isso só no prompt: no 1º ciclo com mensagem vaga ("oi") o
// qualifier não pode chamar tool nenhuma, então `enviar_midia` nunca rodaria
// justamente na abertura. Aqui o envio é do código, não do modelo.
//
// Cadastro: agents.settings.midia_inicio_slug = slug da mídia (vazio = desligado).

import type { LeadData } from "./stage";

export const MIDIA_INICIO_SETTING = "midia_inicio_slug";

/**
 * Slug da mídia de abertura a enviar neste turno, ou null. Só vale para a
 * PRIMEIRA resposta: nenhuma fala de assistente no histórico (nem da IA nem da
 * equipe) e a mídia ainda não marcada como enviada.
 */
export function midiaInicioPendente(
  settings: Record<string, string | undefined>,
  leadData: Pick<LeadData, "midia_inicio_enviada">,
  history: { role: "user" | "assistant" }[],
): string | null {
  const slug = (settings[MIDIA_INICIO_SETTING] ?? "").trim();
  if (!slug) return null;
  if (leadData.midia_inicio_enviada) return null;
  if (history.some((m) => m.role === "assistant")) return null;
  return slug;
}
