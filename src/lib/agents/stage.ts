// Estados da máquina multi-agente. Esta é a fonte da verdade para stages e
// transições. Modifique aqui ANTES de tocar nos agents/orchestrator.
//
// Filosofia: o LLM PROPÕE next_stage no JSON, mas o código decide se a
// transição é válida. Pulos ilegais são bloqueados silenciosamente.

export const STAGES = [
  "RECEPTION",      // primeira mensagem; saudação + identificação
  "QUALIFICATION",  // SPIN questions; identifica interesse (UTM)
  "SLOT_OFFER",     // lista horários disponíveis e oferta 2 opções
  "NAME_COLLECT",   // pede nome completo + confirma compromisso
  "BOOKING",        // chama agendar_clinicorp; cria/atualiza no sistema
  "CONFIRMED",      // pós-agendamento; aguarda warm-up
  "ESCALATED",      // handoff para humano
] as const;

export type Stage = (typeof STAGES)[number];

export function isStage(v: unknown): v is Stage {
  return typeof v === "string" && (STAGES as readonly string[]).includes(v);
}

/**
 * Lead data: scratch pad estruturado entre turns. Cada agente lê o que precisa
 * e patcha o que aprende. Nunca apagado dentro da mesma conversa (exceto /reset).
 */
export interface LeadData {
  /** Nome completo coletado (NAME_COLLECT). */
  name?: string;
  /** Interesse identificado pelo Qualifier (ex.: "IMPLANTE", "FACETAS", "PROTESE"). */
  interest?: string;
  /** Reason quando estado for ESCALATED. */
  escalation_reason?: string;
  /** ISO 8601 do slot escolhido pelo lead. */
  selected_slot_iso?: string;
  /** ID do profissional do slot escolhido — obrigatório pelo Clinicorp. */
  dentist_person_id?: number;
  /** Label da agenda Google escolhida (multi-agenda). Definido ao listar/oferecer
   *  horários e reusado no booking/cancelamento para agir na agenda certa. */
  selected_agenda?: string;
  /** Lista atual de horários oferecidos (para validar escolha do lead). */
  offered_slots?: { iso: string; date_label: string; time_label: string; dentist_person_id?: number }[];
  /** ID do agendamento criado (BOOKING → CONFIRMED). */
  appointment_id?: number | string;
  /** Confirmou compromisso na pergunta de "posso garantir ao Dr. ___?". */
  commitment_confirmed?: boolean;
  /** ID do paciente no Clinicorp (cache para evitar lookup repetido). */
  patient_id?: number;
  /** Notas livres do agente (ex.: queixa principal, objeções, observações clínicas). */
  notes?: string;
  /** Campos extras configurados por template (escola: child_name, birth_date, etc.). */
  custom_fields?: Record<string, string>;
  /** Marca que a tag inicial ("N/A Não Agendado") já foi aplicada — evita reaplicar. */
  initial_tag_applied?: boolean;
  /** Marca que a tag de status pós-agendamento ("Agendado") já foi aplicada. */
  booked_tag_applied?: boolean;
  /** Sinal transitório (truthy): a tool de cancelamento rodou neste turn. O
   *  orquestrador limpa o appointment_id de fato e remove este sinal antes de
   *  persistir. (undefined sozinho não limpa por causa do stripNullishFields.) */
  appointment_cancelled?: boolean;
  /** Sinal transitório: cancelamento foi para REMARCAR — limpar também o slot. */
  reoffer_after_cancel?: boolean;
  /** Lead já enviado ao Leads360 (POST /leads) — evita reenviar a cada turn. */
  leads360_lead_sent?: boolean;
}

/** Transições válidas entre stages. `*` = qualquer origem. */
const TRANSITIONS: Record<Stage, Stage[]> = {
  RECEPTION: ["QUALIFICATION", "ESCALATED"],
  QUALIFICATION: ["QUALIFICATION", "SLOT_OFFER", "ESCALATED"],
  SLOT_OFFER: ["SLOT_OFFER", "NAME_COLLECT", "QUALIFICATION", "ESCALATED"],
  NAME_COLLECT: ["NAME_COLLECT", "BOOKING", "SLOT_OFFER", "ESCALATED", "CONFIRMED"],
  BOOKING: ["BOOKING", "CONFIRMED", "SLOT_OFFER", "ESCALATED"], // retry ou volta ao slot
  CONFIRMED: ["CONFIRMED", "ESCALATED", "SLOT_OFFER"], // SLOT_OFFER = remarcação (cancela o antigo e reoferta)
  ESCALATED: ["ESCALATED"], // terminal — só humano pode reativar (via /ativar)
};

/**
 * Valida transição. Retorna o próximo stage permitido ou o atual se inválido.
 * Logs warning para pulos ilegais.
 */
export interface ResolveNextStageOptions {
  /** Bloqueia CONFIRMED sem appointment_id quando há integração de agenda. */
  requireAppointmentForConfirmed?: boolean;
  hasAppointmentId?: boolean;
  /** lead_data atual — usado para corrigir transições inválidas do LLM. */
  leadData?: LeadData;
}

function coerceProposedStage(current: Stage, proposed: Stage, leadData: LeadData): Stage {
  if (current === "SLOT_OFFER") {
    if (proposed === "BOOKING" || proposed === "CONFIRMED") {
      console.warn(
        `[stage] ${current} → ${proposed} redirecionado para NAME_COLLECT (coleta antes do booking)`,
      );
      return "NAME_COLLECT";
    }
    if (proposed === "NAME_COLLECT" && !leadData.selected_slot_iso) {
      console.warn(
        `[stage] ${current} → NAME_COLLECT bloqueado — selected_slot_iso ausente`,
      );
      return "SLOT_OFFER";
    }
  }
  if (
    current === "NAME_COLLECT" &&
    proposed === "SLOT_OFFER" &&
    leadData.selected_slot_iso &&
    !leadData.appointment_id
  ) {
    console.warn(
      `[stage] ${current} → SLOT_OFFER bloqueado — slot já escolhido`,
    );
    return "NAME_COLLECT";
  }
  if (current === "NAME_COLLECT" && proposed === "CONFIRMED" && !leadData.appointment_id) {
    console.warn(`[stage] ${current} → CONFIRMED redirecionado para BOOKING (sem appointment_id)`);
    return "BOOKING";
  }
  return proposed;
}

export function resolveNextStage(
  current: Stage,
  proposed: unknown,
  opts?: ResolveNextStageOptions,
): Stage {
  if (!isStage(proposed)) {
    console.warn(`[stage] proposta inválida: "${proposed}" — mantendo ${current}`);
    return current;
  }
  if (proposed === current) return current;

  const coerced = coerceProposedStage(current, proposed, opts?.leadData ?? {});
  const allowed = TRANSITIONS[current];
  if (!allowed.includes(coerced)) {
    console.warn(`[stage] transição ilegal ${current} → ${coerced} — bloqueada`);
    return current;
  }

  if (
    opts?.requireAppointmentForConfirmed &&
    coerced === "CONFIRMED" &&
    !opts.hasAppointmentId
  ) {
    console.warn(
      `[stage] CONFIRMED bloqueado sem appointment_id (de ${current}) — mantendo BOOKING`,
    );
    return current === "NAME_COLLECT" || current === "BOOKING" ? "BOOKING" : current;
  }

  return coerced;
}

/** Stage inicial para novas conversas. */
export const INITIAL_STAGE: Stage = "RECEPTION";

/** Roteamento de stage → sub-agente que responde. */
export type AgentRoute = "qualifier" | "scheduler" | "escalation";

export function routeForStage(stage: Stage): AgentRoute {
  switch (stage) {
    case "RECEPTION":
    case "QUALIFICATION":
      return "qualifier";
    case "SLOT_OFFER":
    case "NAME_COLLECT":
    case "BOOKING":
    case "CONFIRMED":
      return "scheduler";
    case "ESCALATED":
      return "escalation";
  }
}
