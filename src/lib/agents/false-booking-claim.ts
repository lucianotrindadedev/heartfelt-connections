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
// "remarquei"/"reagendei": caso real (Sorriso Saude, 29/10) — "Remarquei pra
// você. Sexta-feira, 30/10 às 08:30 fica confirmado agora." sem reserva nenhuma.
const PRIMEIRA_PESSOA_RE = /\b(agendei|marquei|reservei|remarquei|reagendei)\b/i;

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
  String.raw`\b(?:reservad[oa]|marcad[oa]|agendad[oa]|confirmad[oa]|remarcad[oa]|reagendad[oa])\s+(?:pra|para)\s+(?:[aàoás]s?\s+)?` +
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
const ALEGACAO_FRACA_RE = /\b(agendad[oa]|confirmad[oa]|remarcad[oa]|reagendad[oa])\b/i;

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
  return input.horarioEmJogo && ALEGACAO_FRACA_RE.test(r) && !pedeEscolhaDeHorario(r);
}

/**
 * A resposta PEDE ao lead que escolha um horário ("Qual desses fica melhor?",
 * "…às 15:00 ou às 16:00?"). Uma confirmação de reserva nunca faz isso — aí o
 * "confirmado" solto fala do DIA combinado, não de uma reserva.
 *
 * Caso real (Odonto Sorrisos, 87 99243-0695, 15/10): "Perfeito! Então
 * segunda-feira à tarde é confirmado. 😊 Tenho horários disponíveis:
 * segunda-feira, 19/10 às 15:00 ou às 16:00. Qual desses dois fica melhor para
 * você?" virou "Só pra deixar claro: ainda não reservei nada, tá?" — para um
 * lead que só tinha dito o dia. As alegações fortes ("agendei", "marcado para
 * segunda às 15h") continuam barradas sempre.
 */
const PEDE_ESCOLHA_RE =
  /\b(?:qual|quais)\b[^?]{0,60}\b(?:desses|deles|destes|hor[áa]rios?|op[çc](?:[ãa]o|[õo]es)|fica|prefere)\b[^?]*\?|\d{1,2}(?::\d{2}|h\d{0,2})\s+ou\s+(?:[àa]s\s+)?\d{1,2}(?::\d{2}|h)/i;

export function pedeEscolhaDeHorario(reply: string): boolean {
  return PEDE_ESCOLHA_RE.test(reply ?? "");
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

/** "8.30hs", "8:30", "08h30", "9h" → "08:30"/"09:00"; null sem horário. */
function horaPedida(texto: string): string | null {
  for (const m of (texto ?? "").matchAll(/(?<![\d/])(\d{1,2})\s*(?:([:h.])\s*([0-5]\d))?\s*(hs?|hrs?|horas?)?(?![\d/])/gi)) {
    const h = Number(m[1]);
    // Número solto sem minutos nem "h" não é horário ("dia 30").
    if (h > 23 || (!m[3] && !m[4] && m[2] !== "h")) continue;
    return `${String(h).padStart(2, "0")}:${m[3] ?? "00"}`;
  }
  return null;
}

/**
 * Remarcação bloqueada pelo guard: o novo horário ainda não existe. O antigo
 * continua reservado (remarcar_agendamento só o cancela quando o novo é
 * criado). Diz isso com clareza e traz primeiro o horário que o lead pediu, se
 * estiver entre os livres — a escolha dele no turno seguinte fecha a troca.
 */
export function remarcacaoSemReservaReply(
  offeredSlots: { date_label?: string | null; time_label?: string | null }[],
  ultimaDoLead: string,
): string {
  const ofertados = [...(offeredSlots ?? [])];
  const label = (s: { date_label?: string | null; time_label?: string | null }) =>
    `${s.date_label ?? ""} às ${s.time_label ?? ""}`.trim();
  if (ofertados.length === 0) {
    return "Seu horário atual continua reservado e o novo ainda não está marcado. Me diz o melhor dia e horário pra você que eu já verifico a agenda 😊";
  }
  // Sempre como ESCOLHA ("X ou Y?"): a resposta do lead ("8:30") é o que a
  // auto-seleção reconhece; um "posso reservar?" + "sim" ficaria ambíguo.
  const pedida = horaPedida(ultimaDoLead);
  const idx = pedida ? ofertados.findIndex((s) => (s.time_label ?? "").trim() === pedida) : -1;
  if (idx > 0) ofertados.unshift(...ofertados.splice(idx, 1));
  const opcoes = ofertados.slice(0, 2).map(label).join(" ou ");
  return `Seu horário atual continua reservado até a gente confirmar o novo. Pra trocar, tenho ${opcoes} — qual fica melhor pra você? 😊`;
}
