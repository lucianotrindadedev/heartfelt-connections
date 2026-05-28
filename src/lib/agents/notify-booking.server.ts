// Notificação de agendamento via Evolution API.
//
// Mesmo esquema da escalada humana: usa as credenciais GLOBAIS da Evolution
// (system_evolution_config) + a instância e o grupo configurados POR AGENTE
// em agent_escalation. O toggle `notificar_agendamentos` liga/desliga essas
// notificações independente da escalada humana.
//
// Dispara quando um agendamento é confirmado (created) — e, futuramente,
// quando for cancelado/remarcado (cancelled/rescheduled).

import { getSelfhost } from "@/integrations/selfhost/client.server";
import {
  EvolutionApiError,
  EvolutionConfigMissingError,
  sendText as evoSendText,
} from "@/lib/evolution.server";

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

export type BookingNotificationEvent = "created" | "cancelled" | "rescheduled";

interface NotifyBookingParams {
  agentId: string;
  accountId: string;
  event: BookingNotificationEvent;
  patientName: string;
  phone: string;
  /** ISO do horário do agendamento (selected_slot_iso). */
  datetimeIso: string;
  /** Rótulo do tipo de compromisso (settings.appointment_type_label). Ex: "Consulta", "Visita guiada". */
  appointmentLabel: string;
  /** Resumo da conversa (pode vir pré-gerado por IA). */
  summary: string;
}

const EVENT_VERB: Record<BookingNotificationEvent, string> = {
  created: "AGENDADA",
  cancelled: "CANCELADA",
  rescheduled: "REMARCADA",
};

function formatDateTimeBR(iso: string): { date: string; time: string } {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return { date: "(data)", time: "(hora)" };
    const tz = "America/Sao_Paulo";
    const date = new Intl.DateTimeFormat("pt-BR", {
      timeZone: tz,
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
    }).format(d);
    const time = new Intl.DateTimeFormat("pt-BR", {
      timeZone: tz,
      hour: "2-digit",
      minute: "2-digit",
    }).format(d);
    return { date, time };
  } catch {
    return { date: "(data)", time: "(hora)" };
  }
}

function formatPhoneDisplay(phone: string): string {
  const digits = (phone ?? "").replace(/\D/g, "");
  if (!digits) return phone;
  if (digits.startsWith("55") && digits.length >= 12) return `+${digits}`;
  if (digits.length === 10 || digits.length === 11) return `+55${digits}`;
  return `+${digits}`;
}

function buildBookingMessage(p: NotifyBookingParams): string {
  const label = (p.appointmentLabel || "Consulta").trim();
  const title = `*${label.toUpperCase()} ${EVENT_VERB[p.event]}*`;
  const { date, time } = formatDateTimeBR(p.datetimeIso);
  const labelLower = label.toLowerCase();

  let actionLine: string;
  if (p.event === "created") {
    actionLine = `${p.patientName} acabou de agendar ${labelLower} para o dia ${date} às ${time}.`;
  } else if (p.event === "cancelled") {
    actionLine = `${p.patientName} cancelou ${labelLower} que estava marcada para o dia ${date} às ${time}.`;
  } else {
    actionLine = `${p.patientName} remarcou ${labelLower} para o dia ${date} às ${time}.`;
  }

  const lines = [
    title,
    "",
    actionLine,
    `📱 Telefone: ${formatPhoneDisplay(p.phone)}`,
  ];
  if (p.summary?.trim()) {
    lines.push("", `📝 Resumo: ${p.summary.trim()}`);
  }
  return lines.join("\n");
}

/**
 * Envia a notificação de agendamento ao grupo configurado (se ativo).
 * Best-effort: nunca lança — só loga e retorna { sent }.
 */
export async function notifyBooking(
  params: NotifyBookingParams,
): Promise<{ sent: boolean }> {
  const sb = getSelfhost();

  const { data: cfg } = await sb
    .from("agent_escalation")
    .select("grupo_alerta, evolution_instance, notificar_agendamentos")
    .eq("agent_id", params.agentId)
    .single();

  if (!cfg?.notificar_agendamentos || !cfg.grupo_alerta || !cfg.evolution_instance) {
    return { sent: false };
  }

  const text = buildBookingMessage(params);
  try {
    const res = await evoSendText({
      instance: cfg.evolution_instance as string,
      number: cfg.grupo_alerta as string,
      text,
    });
    if (!res.ok) {
      console.error(
        `[notify-booking] Evolution sendText falhou ${res.status}: ${res.body.slice(0, 200)}`,
      );
    } else {
      console.log(
        `[notify-booking] notificação "${params.event}" enviada — agente=${params.agentId} grupo=${cfg.grupo_alerta}`,
      );
    }
    return { sent: res.ok };
  } catch (e) {
    if (e instanceof EvolutionConfigMissingError) {
      console.warn("[notify-booking] Evolution global não configurada — notificação não enviada");
    } else if (e instanceof EvolutionApiError) {
      console.error(`[notify-booking] Evolution API error: ${e.message}`);
    } else {
      console.error("[notify-booking] falha ao enviar notificação:", e);
    }
    return { sent: false };
  }
}

/**
 * Gera um resumo curto (1-2 frases) da conversa para a notificação, via LLM
 * barato. Best-effort: retorna "" em caso de falha (o caller usa fallback).
 */
export async function summarizeConversationForNotification(
  orKey: string,
  model: string,
  history: { role: string; content: string }[],
): Promise<string> {
  const transcript = history
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m) => `${m.role === "user" ? "Lead" : "Agente"}: ${m.content}`)
    .join("\n")
    .slice(0, 6000);

  if (!transcript.trim()) return "";

  const system =
    "Você resume conversas de atendimento para uma notificação interna da equipe. " +
    "Produza UM resumo objetivo em português (1-2 frases, máx 60 palavras) com o " +
    "contexto do lead/paciente e o que foi agendado. Não use saudações, não use " +
    "primeira pessoa, não inclua telefone nem links. Responda apenas o resumo.";

  try {
    const res = await fetch(OPENROUTER_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${orKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: system },
          { role: "user", content: `Conversa:\n${transcript}` },
        ],
        temperature: 0.3,
        max_tokens: 160,
      }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) {
      console.warn(`[notify-booking] resumo LLM falhou ${res.status}`);
      return "";
    }
    const json = (await res.json()) as {
      choices?: { message?: { content?: string | null } }[];
    };
    return (json.choices?.[0]?.message?.content ?? "").trim();
  } catch (e) {
    console.warn("[notify-booking] resumo LLM erro:", e);
    return "";
  }
}
