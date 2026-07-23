// Gatilho de RETOMADA de conversas paradas em SLOT_OFFER.
//
// Problema estrutural: o agente só age quando CHEGA mensagem do lead. Se ele
// termina um turno prometendo algo ("deixa eu verificar e já te mostro") sem
// chamar a tool, ninguém o re-aciona e a conversa morre em silêncio — o lead
// fica esperando horários que nunca chegam. Caso real (Odonto Carioca Campo
// Grande, 21 98817-7687, 23/07): a lead perguntou por sábado, o agente prometeu
// verificar, não chamou listar_horarios e a conversa parou ali.
//
// Os guards in-turn (looksLikeStallReply) pegam a maior parte dessas promessas,
// mas dependem de casar TEXTO — a lista nunca fica completa. Este gatilho é a
// rede de segurança ESTRUTURAL, independente de frase: se estamos em SLOT_OFFER,
// o agente falou por último, não fez pergunta de verdade e o lead não escolheu
// nada, então a bola está com o AGENTE — e ele parou. Retoma o turno.
//
// PURO: sem I/O. O cron faz a query e chama runAgentTurn.
import { hasRealQuestion } from "./stage-signals";

export interface RetomadaInput {
  /** Stage persistido em conversations.meta. */
  stage: string;
  /** lead_data.appointment_id — se já agendou, nada a retomar. */
  appointmentId?: string | number | null;
  /** lead_data.selected_slot_iso — se já escolheu, o fluxo avançou. */
  selectedSlotIso?: string | null;
  /** Papel da ÚLTIMA mensagem da conversa. */
  lastMessageRole: "user" | "assistant";
  /** Texto da última mensagem do assistente. */
  lastAssistantText: string;
  /** Minutos desde a última mensagem. */
  minutesSinceLastMessage: number;
  /** Quantas vezes esta conversa já foi retomada. */
  retomadas: number;
  /** A conversa está travada (turno em andamento)? */
  locked?: boolean;
}

export interface RetomadaConfig {
  /** Só retoma depois de N minutos de silêncio (dá tempo do lead responder). */
  minMinutes: number;
  /** Não ressuscita conversa antiga demais. */
  maxAgeMinutes: number;
  /** Teto de retomadas por conversa (anti-loop). */
  maxRetomadas: number;
}

export const RETOMADA_DEFAULTS: RetomadaConfig = {
  minMinutes: 15,
  maxAgeMinutes: 24 * 60,
  maxRetomadas: 1,
};

export type RetomadaMotivo =
  | "retomar"
  | "stage_nao_e_slot_offer"
  | "ja_agendado"
  | "slot_ja_escolhido"
  | "vez_do_lead"
  | "aguardando_resposta_do_lead"
  | "cedo_demais"
  | "antiga_demais"
  | "teto_de_retomadas"
  | "conversa_travada";

export interface RetomadaDecisao {
  retomar: boolean;
  motivo: RetomadaMotivo;
}

/**
 * Decide se uma conversa parada em SLOT_OFFER deve ter o turno do agente
 * re-executado. A ordem das checagens é do mais barato/definitivo para o mais
 * sutil, para o motivo devolvido ser o mais informativo possível.
 */
export function shouldResumeSlotOffer(
  input: RetomadaInput,
  cfg: RetomadaConfig = RETOMADA_DEFAULTS,
): RetomadaDecisao {
  if (input.stage !== "SLOT_OFFER") return { retomar: false, motivo: "stage_nao_e_slot_offer" };
  if (input.locked) return { retomar: false, motivo: "conversa_travada" };
  if (input.appointmentId != null && String(input.appointmentId).trim() !== "") {
    return { retomar: false, motivo: "ja_agendado" };
  }
  if ((input.selectedSlotIso ?? "").trim()) {
    return { retomar: false, motivo: "slot_ja_escolhido" };
  }
  // O lead falou por último → a bola é do agente, mas o fluxo normal (webhook)
  // já vai processar essa mensagem. Retomar aqui só duplicaria resposta.
  if (input.lastMessageRole !== "assistant") {
    return { retomar: false, motivo: "vez_do_lead" };
  }
  if (input.retomadas >= cfg.maxRetomadas) {
    return { retomar: false, motivo: "teto_de_retomadas" };
  }
  if (input.minutesSinceLastMessage < cfg.minMinutes) {
    return { retomar: false, motivo: "cedo_demais" };
  }
  if (input.minutesSinceLastMessage > cfg.maxAgeMinutes) {
    return { retomar: false, motivo: "antiga_demais" };
  }
  // O agente fez uma pergunta REAL ("prefere manhã ou tarde?") → quem deve
  // responder é o lead; retomar seria spam. Fecho retórico ("tá bem?") NÃO
  // conta como pergunta — foi exatamente o que deixou a conversa morta.
  if (hasRealQuestion(input.lastAssistantText)) {
    return { retomar: false, motivo: "aguardando_resposta_do_lead" };
  }
  return { retomar: true, motivo: "retomar" };
}
