// Classificação e tratamento de falhas do criar_agendamento.
//
// Contexto (caso real 07/07, Clinicorp "costalima", lead 21 99620-0364):
// a agenda ofertou 10:00 (disponível de verdade — validado no endpoint), a lead
// aceitou e criar_agendamento falhou. A "trava de confirmação falsa" do scheduler
// então dizia SEMPRE "esse horário acabou de ficar indisponível" e re-ofertava os
// `offered_slots` em cache — que ainda continham as 10:00 que acabaram de falhar.
// Resultado: mensagem mentirosa ("indisponível" quando a falha foi técnica) e
// auto-contraditória (re-ofertar o mesmo horário).
//
// Este módulo distingue os dois casos e nunca re-oferta o slot que falhou:
//  - "conflict"  → o horário está mesmo ocupado: poda o slot e reoferta OUTROS.
//  - "technical" → falha ao registrar (slot segue livre): não mente, tenta de novo
//    e, se persistir, escala para um humano concluir.

export type BookingFailureKind = "conflict" | "technical";

/** Textos que indicam INDISPONIBILIDADE real (slot tomado), não falha técnica. */
const CONFLICT_RE =
  /INDISPON|indispon|conflit|ocupad|tomad|reservad|j[áa]\s*agendad|not\s*available|unavailable|already\s*booked|slot\s*taken/i;

/** Classifica a mensagem de erro do booking em conflito (slot ocupado) x técnica. */
export function classifyBookingError(msg: string): BookingFailureKind {
  return CONFLICT_RE.test(msg) ? "conflict" : "technical";
}

/**
 * Erros de VALIDAÇÃO (não são falha de create nem conflito de horário): campos
 * obrigatórios pendentes, nome inválido, slot/nome/telefone ausente. O agente
 * trata pedindo o dado — não devem virar "indisponível" nem "problema técnico".
 */
const VALIDATION_MARKERS =
  /"missing"\s*:|"need_valid_name"|NOME_INVALIDO|Campos obrigatórios|selected_slot_iso ausente|name ausente|telefone ausente/i;

/**
 * Extrai a classificação de falha REAL de create de um `result` (JSON string) de
 * criar_agendamento. Retorna null quando não é falha (ok:true/ausente) ou quando
 * é apenas erro de validação (campo pendente etc.).
 * Prioriza o campo explícito `error_kind` (que só as falhas de create carregam);
 * se ausente, infere do texto — exceto para erros de validação.
 */
export function parseBookingFailure(
  result: string | undefined | null,
): { kind: BookingFailureKind } | null {
  if (!result) return null;
  const m = result.match(/"error_kind"\s*:\s*"(conflict|technical)"/);
  if (m) return { kind: m[1] as BookingFailureKind };
  if (!/"ok"\s*:\s*false/.test(result)) return null;
  if (VALIDATION_MARKERS.test(result)) return null;
  return { kind: classifyBookingError(result) };
}

export interface OfferedSlotLike {
  iso: string;
  date_label: string;
  time_label: string;
}

/** Remove de `slots` o horário que falhou (`failedIso`). Nunca re-oferta o slot ruim. */
export function pruneOfferedSlot<T extends OfferedSlotLike>(
  slots: T[] | undefined,
  failedIso: string | undefined,
): T[] {
  const list = slots ?? [];
  if (!failedIso) return [...list];
  return list.filter((s) => s.iso !== failedIso);
}

/** Mensagem para CONFLITO real: reoferta até 2 horários REMANESCENTES (nunca o que falhou). */
export function buildConflictReply(remaining: OfferedSlotLike[]): string {
  const opcoes = remaining
    .slice(0, 2)
    .map((s) => `${s.date_label} às ${s.time_label}`)
    .join(" ou ");
  return opcoes
    ? `Ihh, esse horário acabou de ficar indisponível 😕 Mas consigo te encaixar em ${opcoes}. Qual fica melhor pra você?`
    : "Ihh, esse horário acabou de ficar indisponível 😕 Me dá só um instante que já te trago outras opções de horário, tá?";
}

/** Falha TÉCNICA (slot segue livre): não mente, avisa que vai tentar de novo. */
export const TECH_RETRY_REPLY =
  "Puxa, tive um probleminha técnico aqui pra registrar sua reserva agora. 😕 Me dá só um instantinho que já vou tentar de novo e te confirmo, tá?";

/** Falha TÉCNICA persistente: escala para um humano concluir (não fica em loop). */
export const TECH_ESCALATE_REPLY =
  "Puxa, tive uma dificuldade técnica aqui pra concluir sua reserva. 😕 Já vou pedir pra uma pessoa do nosso time finalizar seu agendamento e te confirmar rapidinho, tá bom?";

/** Motivo de escalada registrado em lead_data.escalation_reason. */
export const TECH_ESCALATION_REASON = "falha_tecnica_agendamento";

/** Após esta quantidade de falhas técnicas consecutivas, escala para humano. */
export const MAX_BOOKING_TECH_RETRIES = 2;
