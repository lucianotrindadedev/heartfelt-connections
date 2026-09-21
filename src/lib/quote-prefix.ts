// O prefixo de CITAÇÃO do WhatsApp (reply), num módulo só para quem grava
// (webhook), quem lê o texto do lead (booking-template) e as travas de conversa
// concordarem sobre o formato — sem import circular entre eles.

const QUOTE_PREFIX_START = '[Em resposta à mensagem: "';
const QUOTE_PREFIX_END = '"]\n';

/**
 * Prefixo que o webhook injeta quando o lead responde CITANDO uma mensagem.
 *
 * O texto citado É útil para o LLM — o prompt do qualifier usa a citação para
 * saber, por exemplo, a qual criança pertence a data de nascimento informada.
 * Por isso ele continua no histórico que vai ao modelo, e só sai na leitura
 * DETERMINÍSTICA (ver stripQuotePrefix).
 */
export function withQuotePrefix(quotedText: string, message: string): string {
  return `${QUOTE_PREFIX_START}${quotedText.slice(0, 200)}${QUOTE_PREFIX_END}${message}`;
}

/**
 * A mensagem sem o prefixo de citação — o que o lead de fato escreveu.
 *
 * Caso real (Clínica Bomfim, Milene 21 99004-9579, 21/09/2026): ela respondeu
 * citando uma pergunta DO AGENTE — "o que mais te incomoda **hoje** com o
 * aparelho?" — e o "hoje" da citação virou a âncora da busca de horários.
 *
 * Pior, no mesmo levantamento (120 dias, 890 mensagens com citação, 148 com a
 * leitura alterada = 17%): um lead escreveu "Pode ser sexta feira" respondendo
 * a "conseguem vir amanhã (quinta-feira, 17/09)?" — a citação venceu o pedido
 * dele e a busca foi para quinta.
 *
 * A regra é simples: o que o AGENTE disse não é pedido do lead.
 */
export function stripQuotePrefix(text: string | null | undefined): string {
  const t = text ?? "";
  if (!t.startsWith(QUOTE_PREFIX_START)) return t;
  const end = t.indexOf(QUOTE_PREFIX_END, QUOTE_PREFIX_START.length);
  return end < 0 ? t : t.slice(end + QUOTE_PREFIX_END.length);
}
