// Detecção de CONFIRMAÇÃO FALSA de agendamento e a resposta que a substitui.
//
// O guard existe para impedir o pior erro possível: dizer ao lead que a visita
// está marcada quando nada foi criado na agenda. Ele continua valendo — o que
// muda aqui é (a) não disparar quando não há agendamento nenhum em jogo e (b)
// não inventar uma falha técnica que nunca aconteceu.
//
// Caso real (Odonto Sorrisos, 87 99625-9078, 03/08): na 2ª mensagem da conversa
// o lead disse "o doutor disse que com 3 meses eu ia voltar pra fazer os
// implantes". Nenhum horário havia sido ofertado ainda. A resposta do agente
// disparou o guard e virou "Desculpe, tive um problema ao registrar sua visita
// na agenda agora. Pode me confirmar o horário que você prefere?" — uma falha
// que não houve, pedindo um horário que o lead nunca deu.
//
// PURO: sem I/O.

/** Verbo de agendamento em 1ª PESSOA — só nós podemos ter feito. */
const PRIMEIRA_PESSOA_RE = /\b(agendei|marquei|reservei)\b/i;

/**
 * Particípio + "pra/para" + um marcador REAL de dia/horário.
 *
 * O "para" sozinho não bastava: "seu retorno já está agendado para daqui 3
 * meses" (falando do que o DENTISTA combinou) casava igual a "está agendado
 * para quarta-feira, 15/07" (confirmação falsa de verdade). Exigindo dia da
 * semana, data, hora ou "hoje/amanhã" logo depois, sobra só o segundo caso.
 */
const DIA_OU_HORA = String.raw`(?:segunda|ter[çc]a|quarta|quinta|sexta|s[áa]bado|domingo|hoje|amanh[ãa]|\d{1,2}\s*[/h:]|\d{1,2}\s*(?:horas?|hrs?)\b|\d{1,2}\s+de\s+\w+)`;
const PARTICIPIO_COM_DATA_RE = new RegExp(
  String.raw`\b(?:reservad[oa]|marcad[oa]|agendad[oa]|confirmad[oa])\s+(?:pra|para)\s+(?:[aàoás]s?\s+)?` +
    DIA_OU_HORA,
  "i",
);

/** "visita guiada para <dia>" — formato próprio de alguns agentes. */
const VISITA_GUIADA_RE = new RegExp(
  String.raw`visita guiada para\s+(?:[aàoás]s?\s+)?` + DIA_OU_HORA,
  "i",
);

/**
 * Alegação INEQUÍVOCA de que NÓS agendamos: verbo em 1ª pessoa, ou particípio
 * ancorado num dia/horário concreto.
 */
const ALEGACAO_FORTE_RE = {
  test: (s: string) =>
    PRIMEIRA_PESSOA_RE.test(s) || PARTICIPIO_COM_DATA_RE.test(s) || VISITA_GUIADA_RE.test(s),
};

/**
 * Particípios SOLTOS. Sozinhos são ambíguos — costumam falar do retorno que o
 * dentista marcou, de uma consulta antiga ou do plano de tratamento. Só contam
 * quando já existe horário em jogo nesta conversa.
 */
const ALEGACAO_FRACA_RE = /\b(agendad[oa]|confirmad[oa])\b/i;

export interface FalseClaimInput {
  /** Texto que o LLM produziu neste turno. */
  reply: string;
  /** Já existe horário ofertado ou escolhido nesta conversa? */
  horarioEmJogo: boolean;
}

/**
 * O texto afirma um agendamento que não existe?
 * (quem chama já garantiu que não há appointment_id).
 */
export function claimsBookingWithoutAppointment(input: FalseClaimInput): boolean {
  const r = input.reply ?? "";
  if (!r.trim()) return false;
  if (ALEGACAO_FORTE_RE.test(r)) return true;
  return input.horarioEmJogo && ALEGACAO_FRACA_RE.test(r);
}

/**
 * Resposta honesta para quando o guard bloqueia e NÃO há horário escolhido.
 *
 * Nunca menciona falha técnica: nada chegou a ser tentado. Diz o que é verdade
 * (não reservamos nada) e devolve o próximo passo concreto.
 */
export function noBookingYetReply(
  offeredSlots: { date_label?: string | null; time_label?: string | null }[],
): string {
  const ofertados = offeredSlots ?? [];
  if (ofertados.length > 0) {
    const opcoes = ofertados
      .slice(0, 2)
      .map((s) => `${s.date_label ?? ""} às ${s.time_label ?? ""}`.trim())
      .join(" ou ");
    return `Só pra deixar claro: ainda não reservei nada, tá? 😊 Qual desses fica melhor pra você — ${opcoes}?`;
  }
  return "Ainda não reservei nada, viu? 😊 Me diz o melhor dia e horário pra você que eu já verifico a agenda.";
}
