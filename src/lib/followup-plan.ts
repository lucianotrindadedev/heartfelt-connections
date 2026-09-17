// Decisão pura do cron de follow-up: dado o estado de UMA conversa, qual o
// próximo passo? Separado do cron para ser testável.
//
// Caso real (Sorriso Saúde, set/2026): o cron descontava a cota de envios do
// tick ANTES de descobrir que a conversa estava fora da janela de 24h do
// WhatsApp e sem template. As conversas eram varridas da mais antiga para a
// mais nova, então ~700 conversas velhas (que nunca enviam nada) esgotavam a
// cota em todo tick e nenhum lead recente recebia follow-up desde 09/07.
// Agora só `send_text`/`send_template` consomem cota.

export interface PlanStep {
  id: string;
  ordem: number;
  delay_value: number;
  delay_unit: string;
  window_start_hour: number | null;
  window_end_hour: number | null;
  allowed_days: string[] | null;
  helena_template_name: string | null;
}

export interface PlanSentRun {
  step_id: string;
  sent_at: string;
}

export type FollowupDecision<S extends PlanStep = PlanStep> =
  /** Sequência inteira já rodou neste ciclo. */
  | { kind: "done" }
  /** Ainda não passou o delay do próximo step. */
  | { kind: "wait"; step: S }
  /** Fora do horário/dia permitido do step. */
  | { kind: "closed_hours"; step: S }
  /** Fora das 24h do WhatsApp e o step não tem template: nada a entregar. */
  | { kind: "skip_no_template"; step: S }
  /** Fora das 24h: envia o template oficial do step. */
  | { kind: "send_template"; step: S; templateName: string }
  /** Dentro das 24h: envia texto (fixo ou contextual). */
  | { kind: "send_text"; step: S };

export const WHATSAPP_WINDOW_MS = 24 * 60 * 60 * 1000;

export function delayToMs(value: number, unit: string): number {
  switch (unit) {
    case "minutes":
      return value * 60 * 1000;
    case "hours":
      return value * 60 * 60 * 1000;
    case "days":
      return value * 24 * 60 * 60 * 1000;
    default:
      return value * 60 * 1000;
  }
}

const WEEKDAY_KEYS: Record<string, string> = {
  Sun: "dom",
  Mon: "seg",
  Tue: "ter",
  Wed: "qua",
  Thu: "qui",
  Fri: "sex",
  Sat: "sab",
};

/** Janela horária + dias permitidos, sempre no horário de São Paulo. */
export function isAllowedNow(
  windowStart: number | null,
  windowEnd: number | null,
  allowedDays: string[] | null,
  now: Date,
): boolean {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Sao_Paulo",
    hour: "numeric",
    weekday: "short",
    hour12: false,
  }).formatToParts(now);
  // Alguns runtimes devolvem "24" à meia-noite com hour12:false.
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? "0") % 24;
  const weekdayKey = WEEKDAY_KEYS[parts.find((p) => p.type === "weekday")?.value ?? ""] ?? "";

  if (windowStart !== null && windowEnd !== null) {
    if (hour < windowStart || hour >= windowEnd) return false;
  }
  if (Array.isArray(allowedDays) && allowedDays.length > 0) {
    if (!allowedDays.includes(weekdayKey)) return false;
  }
  return true;
}

/**
 * @param steps       steps habilitados do agente, em ordem
 * @param sentInCycle envios com sucesso DEPOIS da última msg do lead
 * @param lastMsgAt   última mensagem da conversa (não é do lead)
 * @param cycleStartAt última msg do lead (epoch se nunca mandou)
 */
export function planFollowupStep<S extends PlanStep>(input: {
  steps: S[];
  sentInCycle: PlanSentRun[];
  lastMsgAt: Date;
  cycleStartAt: Date;
  now: Date;
}): FollowupDecision<S> {
  const { steps, sentInCycle, lastMsgAt, cycleStartAt, now } = input;
  const sentIds = new Set(sentInCycle.map((r) => r.step_id));
  const step = steps.find((s) => !sentIds.has(s.id));
  if (!step) return { kind: "done" };

  // Delay contado a partir da última msg da IA (step 1) ou do último envio
  // deste ciclo (step N) — o que for mais recente.
  let anchorAt = lastMsgAt;
  for (const r of sentInCycle) {
    const t = new Date(r.sent_at);
    if (t > anchorAt) anchorAt = t;
  }
  if (now.getTime() < anchorAt.getTime() + delayToMs(step.delay_value, step.delay_unit)) {
    return { kind: "wait", step };
  }

  if (!isAllowedNow(step.window_start_hour, step.window_end_hour, step.allowed_days, now)) {
    return { kind: "closed_hours", step };
  }

  if (now.getTime() - cycleStartAt.getTime() > WHATSAPP_WINDOW_MS) {
    const templateName = (step.helena_template_name ?? "").trim();
    return templateName
      ? { kind: "send_template", step, templateName }
      : { kind: "skip_no_template", step };
  }
  return { kind: "send_text", step };
}

/**
 * Sem nenhum step com template, conversa cuja última atividade passou das 24h
 * nunca envia nada — o cron pode nem buscá-la. `conversations.atualizado_em` é
 * sempre >= última msg do lead (conferido em produção, 904/904 conversas).
 */
export function agentNeedsStaleConversations(steps: PlanStep[]): boolean {
  return steps.some((s) => (s.helena_template_name ?? "").trim().length > 0);
}
