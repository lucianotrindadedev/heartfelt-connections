// Camada deterministica de stage signals.
//
// Filosofia: o LLM continua propondo `next_stage` no JSON, mas a maquina
// deterministica tem PRIORIDADE quando detecta sinais inequivocos no historico
// ou no lead_data. Isso isola o fluxo critico (agendamento) das oscilacoes
// do modelo (especialmente Gemini Flash Lite, que e barato mas fragil em
// instructions-following).
//
// Cada funcao aqui e PURA — sem I/O, sem side-effects — para facilitar testes
// e raciocinio. Spread sobre essa camada deve ser preferido a logica inline
// no orchestrator.

import {
  isSlotAcceptanceMessage,
  looksLikeBirthDate,
  looksLikeSchedulingPreference,
} from "@/lib/booking-template";
import type { LeadData, Stage } from "./stage";

export interface StageSignalsContext {
  /** Stage atual lido de conversations.meta. */
  stage: Stage;
  /** lead_data atual (apos backfill + normalizacao). */
  leadData: LeadData;
  /** Historico ja filtrado (sem fallbacks). */
  history: { role: "user" | "assistant"; content: string }[];
  /** Integracoes de agendamento ativas (clinicorp, clinup ou gcal). */
  hasBookingIntegration: boolean;
}

export interface DetectedSignals {
  /** Ultima mensagem do usuario (trim). */
  lastUserMsg: string;
  /** Ultima mensagem do assistente (raw). */
  lastAssistantMsg: string;
  /** Usuario mandou texto que indica escolha/aceitacao de horario? */
  slotSelectionTurn: boolean;
  /** Assistente acabou de propor agendamento ("posso agendar?", "vamos marcar?"). */
  lastAssistantProposedScheduling: boolean;
  /** Usuario respondeu confirmacao curta ("sim", "ok", "pode", etc). */
  isShortYes: boolean;
  /** QUALIFICATION + assistente propos agendar + usuario disse sim. */
  userAcceptedSchedulingProposal: boolean;
  /** RECEPTION/QUALIFICATION + lead perguntou disponibilidade/data especifica
   *  ("tem disponibilidade para 25/07?"). Roteia direto pro scheduler — o
   *  qualifier nao tem tool de agenda e alucina "vou verificar" sem voltar. */
  userAskedDateAvailability: boolean;
}

const SCHEDULING_PROPOSAL_REGEX =
  /\b(posso (?:te )?agendar|vamos (?:agendar|marcar)|podemos (?:agendar|marcar)|que tal (?:agendar|marcar)|posso (?:te )?(?:reservar|propor) (?:um )?(?:hor[áa]rio|visita)|topa (?:agendar|marcar)|aceita (?:agendar|marcar)|gostaria de agendar|deseja (?:agendar|marcar)|posso te ofer)/i;

const SHORT_YES_REGEX =
  /^(sim|ok|claro|topo|topa|pode|aceito|aceita|quero|isso|vamos|bora|blz|beleza|combinado|fechado|perfeito|com certeza|por favor)[!.?\s]*$/i;

// Lead perguntando disponibilidade ou citando data especifica (dd/mm ou
// "25 de julho"). Mantido conservador para evitar falso positivo em
// QUALIFICATION (ex: "sábado" sozinho NAO casa).
const DATE_AVAILABILITY_REGEX =
  /(disponibilidade|dispon[ií]vel|tem\s+(?:data|vaga|hor[aá]rio|agenda)|data\s+(?:livre|dispon[ií]vel)|agenda\s+(?:livre|aberta)|\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b|\b\d{1,2}\s+de\s+(?:janeiro|fevereiro|mar[cç]o|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro)\b)/i;

export function detectSignals(ctx: StageSignalsContext): DetectedSignals {
  const lastUserMsg =
    [...ctx.history].reverse().find((m) => m.role === "user")?.content?.trim() ?? "";
  const lastAssistantMsg =
    [...ctx.history].reverse().find((m) => m.role === "assistant")?.content ?? "";

  const slotSelectionTurn =
    isSlotAcceptanceMessage(lastUserMsg) || looksLikeSchedulingPreference(lastUserMsg);

  const lastAssistantProposedScheduling = SCHEDULING_PROPOSAL_REGEX.test(lastAssistantMsg);
  const isShortYes = SHORT_YES_REGEX.test(lastUserMsg.toLowerCase());
  const userAcceptedSchedulingProposal =
    ctx.stage === "QUALIFICATION" && lastAssistantProposedScheduling && isShortYes;

  // Data de nascimento (resposta de campo) nunca conta como pedido de
  // disponibilidade — evita roteamento errado quando o lead responde "15/03/2019".
  const userAskedDateAvailability =
    (ctx.stage === "RECEPTION" || ctx.stage === "QUALIFICATION") &&
    DATE_AVAILABILITY_REGEX.test(lastUserMsg) &&
    !looksLikeBirthDate(lastUserMsg);

  return {
    lastUserMsg,
    lastAssistantMsg,
    slotSelectionTurn,
    lastAssistantProposedScheduling,
    isShortYes,
    userAcceptedSchedulingProposal,
    userAskedDateAvailability,
  };
}

/**
 * Calcula o stage que deve ser PASSADO ao sub-agente (effective stage).
 * Difere do stage persistido em casos onde sinais deterministicos indicam
 * que devemos rotear/promptar como se estivessemos em outro stage.
 *
 * Exemplos:
 * - QUALIFICATION + usuario aceitou agendar → roteia como SLOT_OFFER (scheduler)
 * - SLOT_OFFER + ja tem selected_slot_iso → roteia como NAME_COLLECT
 * - NAME_COLLECT sem selected_slot_iso → roteia como SLOT_OFFER (volta listar)
 */
export interface InferEffectiveStageResult {
  effectiveStage: Stage;
  reason?: string;
}

export function inferEffectiveStage(
  ctx: StageSignalsContext,
  signals: DetectedSignals,
  isReadyForBooking: boolean,
): InferEffectiveStageResult {
  const { stage, leadData, hasBookingIntegration } = ctx;

  if (signals.userAcceptedSchedulingProposal && hasBookingIntegration) {
    return {
      effectiveStage: "SLOT_OFFER",
      reason: "lead_accepted_scheduling_proposal",
    };
  }

  // Lead pediu disponibilidade/data especifica → scheduler responde JA neste
  // turno com horarios reais (listar_horarios + data_alvo). Sem isso, o
  // qualifier (sem tool de agenda) promete "vou verificar" e a conversa morre.
  if (
    (stage === "RECEPTION" || stage === "QUALIFICATION") &&
    hasBookingIntegration &&
    signals.userAskedDateAvailability &&
    !leadData.appointment_id
  ) {
    return {
      effectiveStage: "SLOT_OFFER",
      reason: "lead_asked_date_availability",
    };
  }

  if (stage === "SLOT_OFFER" && leadData.selected_slot_iso) {
    return {
      effectiveStage: "NAME_COLLECT",
      reason: "slot_already_selected",
    };
  }

  if (stage === "NAME_COLLECT" && !leadData.selected_slot_iso) {
    return {
      effectiveStage: "SLOT_OFFER",
      reason: "name_collect_without_slot",
    };
  }

  if (
    (stage === "NAME_COLLECT" || stage === "BOOKING") &&
    hasBookingIntegration &&
    !leadData.appointment_id &&
    isReadyForBooking
  ) {
    return {
      effectiveStage: "BOOKING",
      reason: "all_fields_collected",
    };
  }

  return { effectiveStage: stage };
}

/**
 * Aplica overrides deterministicos APOS o LLM ter proposto next_stage.
 * Usado para garantir progressao mesmo quando o LLM "trava" no mesmo stage.
 */
export interface ApplyOverridesInput {
  /** Stage validado pelo resolveNextStage (ja aplicou regras de transicao). */
  proposedNextStage: Stage;
  /** Stage que estava registrado em conversations.meta antes do turn. */
  originalStage: Stage;
  /** effectiveStage que foi passado ao LLM. */
  effectiveStage: Stage;
  leadData: LeadData;
  hasBookingIntegration: boolean;
  signals: DetectedSignals;
}

export interface OverrideResult {
  stage: Stage;
  reason?: string;
}

export function applyDeterministicStageOverrides(input: ApplyOverridesInput): OverrideResult {
  const { proposedNextStage, originalStage, effectiveStage, leadData, hasBookingIntegration, signals } = input;
  let result = proposedNextStage;
  let reason: string | undefined;

  // Reagendamento pendente: já existe appointment_id, mas o horário que o lead
  // selecionou agora (selected_slot_iso) ainda é DIFERENTE do que está de fato
  // reservado (booked_slot_iso) — a mudança ainda não foi executada por
  // remarcar_agendamento. Nenhum override abaixo deve AVANÇAR o stage nessa
  // condição: avançar (mesmo que só até NAME_COLLECT, não direto pra CONFIRMED)
  // faria o fluxo "esquecer" que existe uma remarcação pendente, mesmo que um
  // guard downstream (scheduler) já tenha evitado a confirmação falsa nesse
  // mesmo turn — reabrindo a mesma classe de bug por outra porta. Caso real
  // (Clínica Bomfim, 09/07): o guard do scheduler barrou "Fechado! Reservado
  // para 15/07" sem tool chamada, mas os overrides abaixo empurrariam o stage
  // adiante mesmo assim, porque só olhavam "existe appointment_id"/"existe
  // selected_slot_iso", nunca se o horário bate com o real.
  const hasPendingReschedule =
    !!leadData.selected_slot_iso &&
    !!leadData.booked_slot_iso &&
    leadData.selected_slot_iso !== leadData.booked_slot_iso;

  if (
    signals.userAcceptedSchedulingProposal &&
    hasBookingIntegration &&
    effectiveStage === "SLOT_OFFER" &&
    originalStage === "QUALIFICATION" &&
    result === "QUALIFICATION"
  ) {
    result = "SLOT_OFFER";
    reason = "force_slot_offer_after_accept";
  }

  // Pedido de disponibilidade roteado pro scheduler (effectiveStage=SLOT_OFFER):
  // persiste o avanco mesmo vindo de RECEPTION, onde a tabela de transicoes
  // bloqueia RECEPTION → SLOT_OFFER (o resolveNextStage devolve o stage antigo).
  if (
    signals.userAskedDateAvailability &&
    hasBookingIntegration &&
    effectiveStage === "SLOT_OFFER" &&
    (originalStage === "RECEPTION" || originalStage === "QUALIFICATION") &&
    (result === "RECEPTION" || result === "QUALIFICATION")
  ) {
    result = "SLOT_OFFER";
    reason = reason ?? "force_slot_offer_after_date_ask";
  }

  if (
    originalStage === "SLOT_OFFER" &&
    leadData.selected_slot_iso &&
    result === "SLOT_OFFER" &&
    !hasPendingReschedule
  ) {
    result = "NAME_COLLECT";
    reason = reason ?? "slot_selected_advance_to_name_collect";
  }

  if (
    leadData.appointment_id &&
    !hasPendingReschedule &&
    (result === "NAME_COLLECT" || result === "BOOKING")
  ) {
    result = "CONFIRMED";
    reason = reason ?? "appointment_created_advance_to_confirmed";
  }

  if (result === "NAME_COLLECT" && !leadData.selected_slot_iso) {
    result = "SLOT_OFFER";
    reason = reason ?? "name_collect_requires_slot";
  }

  return { stage: result, reason };
}

// Resposta "stall/filler": o agente PROMETE agir ("vou finalizar seu cadastro",
// "só um instante", "já te confirmo", "estou organizando") mas NÃO entrega — e
// a conversa morre esperando uma ação que nunca vem. Diferente da afirmação
// FALSA de agendamento ("agendei/marquei/confirmado"), que é tratada à parte:
// aqui o agente nem afirma que concluiu, só enrola. Bug real observado no
// SLOT_OFFER→BOOKING (lead escolhe o horário e o agente fica "vou criar seu
// cadastro rapidinho" sem nunca agendar).
//
// verificar/checar/consultar (caso real 09/07, Costa Lima Recreio): lead pede
// outra semana ("só semana que vem"), o agente responde "vou verificar a
// agenda" SEM chamar listar_horarios nesse turn — e a conversa morre esperando
// os novos horários que nunca chegam (nada re-aciona o agente depois).
//
// "vou deixar reservado / logo te envio a confirmação" (caso real 13/07, MF
// Beauty BSB, Maria de Fátima): sem agendamento criado (appointment_id nulo), o
// agente disse "Já vou deixar tudo reservado por aqui e logo te envio a
// confirmação" — uma promessa de reserva + confirmação FUTURA que o sistema
// nunca cumpre sozinho (só reage a mensagem nova do lead). A lead achou que
// estava agendada e agradeceu. Não bate nas palavras de confirmação PASSADA
// ("agendei/reservei") do false_booking_claim, nem no "já te envio" (o gatilho
// aqui é "logo", não "já"), então escapava dos dois guards.
const STALL_REPLY_REGEX =
  /(s[óo]\s+um\s+(instant(?:e|inho)|minut(?:o|inho)|moment(?:o|inho)|segund(?:o|inho))|um\s+(instant(?:e|inho)|moment(?:o|inho)|minutinho)|aguard[ae]\b|aguardar\b|(?:j[áa]|logo|em\s+seguida)\s+(?:te\s+|lhe\s+)?(retorno|volto|confirmo|aviso|respondo|envio|mando|passo|finalizo|verifico|checo|consulto|busco|procuro)|vou\s+(finalizar|criar|fazer|registrar|organizar|gerar|preparar|montar|cadastrar|verificar|checar|consultar|buscar|procurar|pesquisar|ver|olhar|levantar|separar|localizar|dar\s+uma\s+olhada)\b|vou\s+deixar\s+(?:tudo\s+|isso\s+|j[áa]\s+)?(reservad|agendad|marcad|pronto|prontinho|certinh|garantid|organizad)|te\s+(envio|mando|passo)\s+(?:a\s+|o\s+)?(confirma[çc]|agendament)|estou\s+(finalizando|criando|organizando|registrando|preparando|gerando|cadastrando|verificando|checando|consultando|buscando|procurando|pesquisando)|t[ôo]\s+(finalizando|criando|organizando|registrando|cadastrando|verificando|checando|consultando|buscando|procurando)|deixa?\s+eu\s+(finalizar|criar|organizar|registrar|cadastrar|verificar|checar|consultar|buscar|procurar|ver|dar\s+uma\s+olhada)|pe[çc]o\s+que\s+aguarde|me\s+d[êe]\s+um\s+(instante|instantinho|momento|minutinho)|rapidinho\s+(aqui|aí|pra))/i;

/**
 * Fechos retóricos no FIM da frase ("…já te mostro, tá bem?", "…, ok?"). Não
 * pedem nada acionável ao lead — são só cortesia fechando uma promessa. Sem
 * removê-los, o "?" deles fazia o reply passar por "pergunta = progresso" e
 * DESARMAVA o guard anti-stall. Caso real (Odonto Carioca Campo Grande,
 * 21 98817-7687): "Deixa eu verificar a disponibilidade de sábado e já te mostro
 * os horários que temos, tá bem?" — nenhuma tool foi chamada, a promessa saiu e
 * a conversa morreu (nada re-aciona o agente depois).
 */
const RHETORICAL_TAG_REGEX =
  /[,;\s]*\b(t[áa]\s*(bem|bom|certo|ok)?|ok|okay|tudo\s+(bem|certo)|certo|combinado|beleza|blz|pode\s+ser|sim|n[ée])\s*\?+\s*$/i;

/** Remove os fechos retóricos do fim (até 3, p/ "…, tá bem? ok?"). */
function stripRhetoricalTags(text: string): string {
  let out = text.trim();
  for (let i = 0; i < 3; i++) {
    const next = out.replace(RHETORICAL_TAG_REGEX, "").trim();
    if (next === out) break;
    out = next;
  }
  return out;
}

/**
 * True quando o `reply` do agente é só "enrolação" (promessa de agir / pedido
 * para aguardar) sem fazer pergunta. Um reply que faz pergunta REAL ("Qual seu
 * nome completo?") é progresso, não stall — por isso a presença de "?" ainda
 * desqualifica, mas só depois de descartar os fechos retóricos ("tá bem?").
 * PURA: o orquestrador decide o que fazer (perguntar campo, ofertar slot, etc.).
 */
export function looksLikeStallReply(reply: string): boolean {
  const r = (reply ?? "").trim();
  if (!r) return false;
  const semTags = stripRhetoricalTags(r);
  if (!semTags) return false; // era só o fecho retórico, não há promessa
  if (semTags.includes("?")) return false; // pergunta REAL é avançar, não enrolar
  return STALL_REPLY_REGEX.test(semTags);
}
