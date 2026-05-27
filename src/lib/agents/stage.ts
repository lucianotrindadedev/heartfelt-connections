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
}

/** Transições válidas entre stages. `*` = qualquer origem. */
const TRANSITIONS: Record<Stage, Stage[]> = {
  RECEPTION: ["QUALIFICATION", "ESCALATED"],
  QUALIFICATION: ["QUALIFICATION", "SLOT_OFFER", "ESCALATED"],
  SLOT_OFFER: ["SLOT_OFFER", "NAME_COLLECT", "QUALIFICATION", "ESCALATED"],
  NAME_COLLECT: ["NAME_COLLECT", "BOOKING", "SLOT_OFFER", "ESCALATED"],
  BOOKING: ["BOOKING", "CONFIRMED", "SLOT_OFFER", "ESCALATED"], // retry ou volta ao slot
  CONFIRMED: ["CONFIRMED", "ESCALATED"],
  ESCALATED: ["ESCALATED"], // terminal — só humano pode reativar (via /ativar)
};

/**
 * Valida transição. Retorna o próximo stage permitido ou o atual se inválido.
 * Logs warning para pulos ilegais.
 */
export function resolveNextStage(current: Stage, proposed: unknown): Stage {
  if (!isStage(proposed)) {
    console.warn(`[stage] proposta inválida: "${proposed}" — mantendo ${current}`);
    return current;
  }
  if (proposed === current) return current;
  const allowed = TRANSITIONS[current];
  if (allowed.includes(proposed)) return proposed;
  console.warn(`[stage] transição ilegal ${current} → ${proposed} — bloqueada`);
  return current;
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
