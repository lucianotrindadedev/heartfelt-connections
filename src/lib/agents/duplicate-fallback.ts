// Textos que a trava anti-repetição do orquestrador usa no lugar da resposta
// repetida. Antes eram frases fixas que mudavam de assunto — em setembro/2026,
// na Sorriso Saúde, "Desculpa, acho que me confundi aqui! 😅 Me diz como posso
// te ajudar…" saiu em 8 conversas e "Me confirma só por favor: você quer seguir
// com o agendamento agora?" em 12, inclusive para quem tinha acabado de dizer
// "só posso a partir das 15h".

/** Última pergunta REAL do texto ("…Você perdeu um dente ou mais de um?"). */
function lastQuestionSentence(text: string): string | null {
  const sentences = (text ?? "")
    .split(/\n+|(?<=[.!?…])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
  for (let i = sentences.length - 1; i >= 0; i--) {
    // Emoji/pontuação que sobram do corte ("Oi! 😊 Como…" → "😊 Como…").
    const s = sentences[i]!.replace(/^[^\p{L}\p{N}]+/u, "");
    if (!s.endsWith("?")) continue;
    // Fecho retórico ("Fico por aqui, tudo bem?") não é pergunta pendente.
    const semFecho = s.replace(
      /[,;\s]*\b(?:t[áa]\s*bem|tudo\s+(?:bem|certo)|ok|certo|combinado|pode\s+ser|n[ée])\s*\?+$/i,
      "",
    );
    if (semFecho !== s && !semFecho.includes("?")) continue;
    return s.replace(/^(?:oi|ol[áa]|entendi|perfeito|certo|[óo]timo)[!.,]*\s*/i, "").trim() || null;
  }
  return null;
}

/**
 * A IA repetiu uma pergunta que o lead não respondeu ("Sim perdi" para "um
 * dente ou mais de um?", "Oi" para "como prefere que eu te chame?"). Refazer a
 * pergunta é o certo — só não com as mesmas palavras. Null quando a resposta
 * bloqueada não tinha pergunta.
 */
export function rephraseRepeatedQuestion(blockedReply: string): string | null {
  const q = lastQuestionSentence(blockedReply);
  if (!q) return null;
  const corpo = q.charAt(0).toLowerCase() + q.slice(1);
  return `${REPHRASE_PREFIX} ${corpo}`;
}

/** Abertura da pergunta reformulada — o orquestrador usa para não reformular 2x. */
export const REPHRASE_PREFIX = "Só pra eu te ajudar direitinho:";

/** Resposta repetida SEM pergunta (despedida, aviso): encerra sem mudar de assunto. */
export const NEUTRAL_REPEAT_ACK = "Combinado! Qualquer coisa, é só me chamar por aqui. 😊";

/**
 * Oferta de horário repetida. O lead já viu aqueles horários e não escolheu —
 * perguntar "quer seguir com o agendamento?" ignora o que ele disse. Pede a
 * restrição dele para a próxima busca.
 */
export const SLOT_OFFER_REPEAT_FALLBACK =
  "Entendi! Pra eu não te oferecer de novo um horário que não dá: me diz qual dia da semana e qual horário ficam bons pra você que eu procuro na agenda. 😊";

/**
 * A repetição bloqueada é do CADASTRO — então a trava pede o campo que falta (ou
 * a confirmação), nunca "me diz qual dia da semana". Vale em NAME_COLLECT e
 * também em BOOKING com horário JÁ escolhido: o preflight que barra um campo
 * deixa o estágio em BOOKING, e o texto de oferta de horário fazia o lead achar
 * que o horário que ele escolheu tinha caído.
 *
 * Caso real (Maple Bear Guarujá, 13 98200-8544, 07/10): o pai escolheu sábado
 * 10/10 às 10:00, mandou os responsáveis e a trava respondeu 5x "Pra eu não te
 * oferecer de novo um horário que não dá: me diz qual dia da semana…".
 *
 * Em BOOKING, recusa/reclamação do lead fica de fora: insistir no cadastro de
 * quem disse "não quero mais" queima o lead (o chamador responde neutro).
 */
export function repeticaoEhDoCadastro(o: {
  stage: string;
  effectiveStage: string;
  selectedSlotIso?: string | null;
  leadRecusouOuReclamou?: boolean;
}): boolean {
  if (o.stage === "NAME_COLLECT" || o.effectiveStage === "NAME_COLLECT") return true;
  if (o.leadRecusouOuReclamou) return false;
  return !!o.selectedSlotIso && (o.stage === "BOOKING" || o.effectiveStage === "BOOKING");
}
