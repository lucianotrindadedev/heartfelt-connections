// Travas de conversa que não dependem de LLM: quem está falando (é mesmo o dono
// desta conversa?), o que foi citado (reply do WhatsApp) e se a mensagem é só
// cortesia (não é resposta de agendamento).
//
// Caso real que motivou o módulo (Odonto Sorrisos, Rodrigo (38) 99881-0514,
// 16/09/2026): a clínica mandou "Feliz aniversário, RODRIGO!" às 07:39, ele
// respondeu "Bom dia" + "Muito obgd" (citando o parabéns) e a IA emendou "Para
// finalizar seu agendamento, me confirma qual dos dois horários…". Ele nunca
// tinha falado de agendamento. A resposta dele caiu numa conversa que juntava
// 161 remetentes desde junho, com o lead_data e o estágio SLOT_OFFER de OUTRA
// pessoa; a citação do parabéns não chegou ao modelo; e nada impedia a IA de
// empurrar horário em cima de um "obrigado".

import {
  looksLikeGratitudeOrClosing,
  requestedDateFromText,
  requestedPeriodoFromText,
  requestedWeekdayFromText,
} from "./booking-template";

// ── Citação (reply do WhatsApp) ─────────────────────────────────────────────

const QUOTE_PREFIX_START = '[Em resposta à mensagem: "';
const QUOTE_PREFIX_END = '"]\n';

/**
 * Prefixo que o webhook injeta quando o lead responde CITANDO uma mensagem. Fica
 * num lugar só para quem grava e quem lê (ver stripQuotePrefix) concordarem.
 */
export function withQuotePrefix(quotedText: string, message: string): string {
  return `${QUOTE_PREFIX_START}${quotedText.slice(0, 200)}${QUOTE_PREFIX_END}${message}`;
}

/** A mensagem sem o prefixo de citação — o que o lead de fato escreveu. */
export function stripQuotePrefix(text: string | null | undefined): string {
  const t = text ?? "";
  if (!t.startsWith(QUOTE_PREFIX_START)) return t;
  const end = t.indexOf(QUOTE_PREFIX_END, QUOTE_PREFIX_START.length);
  return end < 0 ? t : t.slice(end + QUOTE_PREFIX_END.length);
}

// ── Remetente estranho à conversa ───────────────────────────────────────────

export interface InboundSender {
  /** Telefone de quem enviou (meta.channel_from), cru. */
  from: string | null | undefined;
}

export interface ForeignSenderVerdict {
  /** Telefone normalizado de quem está falando AGORA (última rajada). */
  current: string | null;
  /** Telefones normalizados que já falaram antes nesta conversa. */
  previous: string[];
  /** Quem fala agora nunca falou nesta conversa — que já tem outro dono. */
  foreign: boolean;
}

/**
 * Quem está falando agora é o mesmo contato que já falava nesta conversa?
 *
 * Recebe os remetentes das mensagens do LEAD em ordem cronológica, com a rajada
 * atual no fim. Só acusa estranho quando os dois lados são telefones válidos:
 * sem telefone (Instagram, remetente ausente) não há como comparar, e acusar
 * nesse caso calaria conversas legítimas.
 *
 * Conversa nova (ninguém falou antes) nunca é estranha.
 */
export function detectForeignSender(
  inboundInOrder: readonly InboundSender[],
  normalize: (raw: string | null | undefined) => string | null,
): ForeignSenderVerdict {
  const phones = inboundInOrder.map((m) => normalize(m.from));
  const current = phones[phones.length - 1] ?? null;
  if (!current) return { current: null, previous: [], foreign: false };

  // A rajada atual = as últimas mensagens seguidas do mesmo remetente.
  let i = phones.length - 1;
  while (i >= 0 && phones[i] === current) i--;
  const previous = [...new Set(phones.slice(0, i + 1).filter((p): p is string => !!p))];
  return { current, previous, foreign: previous.length > 0 && !previous.includes(current) };
}

// ── Mensagem de pura cortesia ───────────────────────────────────────────────

// Emoji no fim ("Bom dia 😊") é aceito por propriedade Unicode, com a flag `u`:
// dentro de uma classe [...] sem `u`, emoji vira metade de par substituto e
// "☺️"/"❤️" (caractere + seletor de variação) quebram em pedaços.
const SAUDACAO_RE =
  /^(oi+|ol[aá]+|opa|e a[ií]|bom dia|boa tarde|boa noite|tudo bem|td bem|tudo bom|blz|beleza)(?:[\s!.,]|\p{Extended_Pictographic}|\u{FE0F})*$/iu;

function isGreeting(text: string): boolean {
  return SAUDACAO_RE.test(text.trim());
}

/**
 * A mensagem é SÓ cortesia (saudação ou agradecimento), sem nenhum pedido?
 *
 * Conservador de propósito: agradecer não pode esconder uma escolha. Por isso
 * "Obrigada, pode ser às 10h", "obrigado, quinta serve?" ou "valeu, de tarde"
 * NÃO contam — qualquer número, pergunta, data, dia da semana ou turno tira a
 * mensagem daqui. Mensagem longa também sai: cortesia é curta.
 */
export function isCourtesyMessage(text: string | null | undefined): boolean {
  const t = stripQuotePrefix(text).trim();
  if (!t) return false;
  if (/\d/.test(t) || t.includes("?")) return false;
  if (t.split(/\s+/).length > 8) return false;
  if (requestedDateFromText(t) || requestedWeekdayFromText(t) || requestedPeriodoFromText(t)) {
    return false;
  }
  return looksLikeGratitudeOrClosing(t) || isGreeting(t);
}

/**
 * A rajada inteira do lead é cortesia E contém um agradecimento/encerramento?
 *
 * Só saudação ("Bom dia") não basta — o lead pode estar voltando para escolher
 * o horário. É o agradecimento que sinaliza fechamento da conversa.
 */
export function isCourtesyOnlyBurst(burst: readonly string[]): boolean {
  const msgs = burst.map((m) => stripQuotePrefix(m).trim()).filter(Boolean);
  if (msgs.length === 0) return false;
  if (!msgs.every((m) => isCourtesyMessage(m))) return false;
  return msgs.some((m) => looksLikeGratitudeOrClosing(m));
}

// ── Follow-up ───────────────────────────────────────────────────────────────

/**
 * O follow-up automático deve ficar calado por causa de uma destas travas?
 *
 *  - foreign_sender_blocked_at: a conversa mistura contatos (ver
 *    detectForeignSender). Cobrar horário ali é mandar o agendamento de uma
 *    pessoa para outra — no caso real o follow-up das 11:07 repetiu "Qual dos
 *    dois horários funciona melhor pra você?" para o Rodrigo.
 *  - courtesy_hold_at: o lead só agradeceu. O orquestrador remove a marca
 *    assim que o lead volta a conversar e o agente responde normalmente.
 */
export function followupHeldByConversationGuards(
  meta: Record<string, unknown> | null | undefined,
): boolean {
  if (!meta) return false;
  return !!meta.foreign_sender_blocked_at || !!meta.courtesy_hold_at;
}
