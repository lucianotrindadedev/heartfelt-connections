// Detecta quando o lead NÃO respondeu uma pergunta de múltipla escolha.
//
// A trava anti-loop (`duplicate_reply_blocked`) existe para impedir que o agente
// dispare a mesma frase repetidamente. Mas ela não distinguia loop de
// REPERGUNTA LEGÍTIMA: se o agente pergunta "superior, inferior ou nas duas?" e
// o lead responde "Sim", reperguntar é a única reação correta — e era
// exatamente isso que a trava bloqueava.
//
// Caso real (Escudero, 12 99189-4420, 13/08, 15:55): o LLM gerou "Perfeito! Só
// pra eu entender melhor: seria protocolo na arcada superior, inferior ou nas
// duas?" e a trava trocou por "Desculpa, acho que me confundi aqui! 😅 Me diz
// como posso te ajudar: você quer agendar um horário ou tirar alguma dúvida
// antes?". O agente pareceu quebrado para o lead, descartou a pergunta pendente
// e fez a MESMA pergunta um turno depois de qualquer jeito.

/**
 * Respostas que reconhecem/concordam sem escolher nada. Nenhuma delas
 * desambigua uma pergunta com 2+ opções — daí a repergunta ser legítima.
 */
const BARE_AFFIRMATIONS = new Set(
  // prettier-ignore
  [
    "sim", "s", "sim sim", "simm", "claro", "isso", "isso mesmo", "exato",
    "exatamente", "certo", "correto", "positivo", "ok", "okay", "okey", "ok ok",
    "blz", "beleza", "ta", "ta bom", "ta bem", "tudo bem", "uhum", "aham", "hum",
    "pode", "pode ser", "pode sim", "quero", "sim quero", "quero sim", "gostaria",
    "por favor", "pf", "afirmativo", "com certeza", "perfeito", "otimo", "bom",
  ],
);

/** minúsculo, sem acento, sem pontuação/emoji, espaços colapsados. */
function normalizeAnswer(text: string | null | undefined): string {
  return (text ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** A mensagem é só uma concordância, sem escolher nenhuma opção. */
export function isBareAffirmation(text: string | null | undefined): boolean {
  const n = normalizeAnswer(text);
  if (!n || n.length > 20) return false;
  return BARE_AFFIRMATIONS.has(n);
}

/**
 * Devolve a última pergunta do agente quando ela oferece 2+ opções
 * ("superior, inferior ou nas duas?"), ou null.
 *
 * Recorta só a oração final para não confundir com um "ou" de um trecho
 * anterior da mesma mensagem.
 */
export function extractOptionsQuestion(agentReply: string | null | undefined): string | null {
  const text = (agentReply ?? "").trim();
  if (!text.includes("?")) return null;

  const perguntas = text
    .split(/(?<=\?)/)
    .map((s) => s.trim())
    .filter((s) => s.endsWith("?"));
  const ultima = perguntas[perguntas.length - 1];
  if (!ultima) return null;

  const partes = ultima.split(/[.!\n]/);
  const oracao = partes[partes.length - 1]?.trim() || ultima;
  return /\bou\b/i.test(oracao) ? oracao : null;
}

/**
 * O agente fez uma pergunta com opções e o lead respondeu só "sim"/"ok" — a
 * pergunta segue em aberto, então repetir NÃO é loop.
 */
export function leadSkippedOptionsQuestion(
  lastUserMsg: string | null | undefined,
  lastAgentReply: string | null | undefined,
): boolean {
  if (!extractOptionsQuestion(lastAgentReply)) return false;
  return isBareAffirmation(lastUserMsg);
}
