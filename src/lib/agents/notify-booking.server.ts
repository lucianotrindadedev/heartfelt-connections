// Notificação de agendamento via Evolution API.
//
// Mesmo esquema da escalada humana: usa as credenciais GLOBAIS da Evolution
// (system_evolution_config) + a instância e o grupo configurados POR AGENTE
// em agent_escalation. O toggle `notificar_agendamentos` liga/desliga essas
// notificações independente da escalada humana.
//
// Formato configurável pela UI admin (campos em agent_escalation):
//   * notification_template          — Markdown WhatsApp com {{variáveis}}
//   * notification_summary_enabled   — gera (ou não) o {{resumo}} via LLM
//   * notification_summary_instruction — instrução para o LLM do resumo

import { getSelfhost } from "@/integrations/selfhost/client.server";
import {
  EvolutionApiError,
  EvolutionConfigMissingError,
  sendText as evoSendText,
} from "@/lib/evolution.server";

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

export type BookingNotificationEvent = "created" | "cancelled" | "rescheduled";

/** Variáveis disponíveis em todo template de notificação. */
export interface BookingTemplateVars {
  nome: string;
  telefone: string;
  evento: string;
  data: string;
  hora: string;
  data_hora: string;
  dia_semana: string;
  tipo_consulta: string;
  agenda: string;
  interesse: string;
  observacoes: string;
  resumo: string;
  agente: string;
  empresa: string;
  /** Custom fields do lead — acessados via {{cf.<chave>}}. */
  cf: Record<string, string>;
}

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
  /** Resumo já gerado (legado). Se omitido, o resumo é gerado AQUI (quando habilitado). */
  summary?: string;
  /** Contexto adicional disponibilizado ao template. */
  agenda?: string;
  interesse?: string;
  observacoes?: string;
  agenteNome?: string;
  empresa?: string;
  customFields?: Record<string, string>;
  /** Histórico para gerar o resumo (quando habilitado). Se omitido, usa `summary` cru. */
  history?: { role: string; content: string }[];
  /** OpenRouter key + modelo para o resumo. Necessários quando history vem e summary não. */
  orKey?: string;
  summaryModel?: string;
}

const EVENT_VERB: Record<BookingNotificationEvent, string> = {
  created: "AGENDADA",
  cancelled: "CANCELADA",
  rescheduled: "REMARCADA",
};

const DEFAULT_TEMPLATE =
  `*{{tipo_consulta}} {{evento}}*\n\n` +
  `{{nome}} acabou de agendar para o dia {{data}} às {{hora}}.\n` +
  `📱 Telefone: {{telefone}}\n\n` +
  `📝 Resumo: {{resumo}}`;

const DEFAULT_SUMMARY_INSTRUCTION =
  "Resuma em 1-2 frases o contexto do lead/paciente e o que foi agendado. " +
  "Não use saudações, primeira pessoa, telefone ou links. Máximo 60 palavras.";

function formatDateTimeBR(iso: string): {
  date: string;
  time: string;
  weekday: string;
  combined: string;
} {
  const empty = { date: "(data)", time: "(hora)", weekday: "", combined: "(data) às (hora)" };
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return empty;
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
    const weekday = new Intl.DateTimeFormat("pt-BR", {
      timeZone: tz,
      weekday: "long",
    }).format(d);
    return {
      date,
      time,
      weekday: weekday.charAt(0).toUpperCase() + weekday.slice(1),
      combined: `${date} às ${time}`,
    };
  } catch {
    return empty;
  }
}

function formatPhoneDisplay(phone: string): string {
  const digits = (phone ?? "").replace(/\D/g, "");
  if (!digits) return phone;
  if (digits.startsWith("55") && digits.length >= 12) return `+${digits}`;
  if (digits.length === 10 || digits.length === 11) return `+55${digits}`;
  return `+${digits}`;
}

/** Monta o dicionário de variáveis a partir dos parâmetros da notificação. */
export function buildTemplateVars(p: NotifyBookingParams, summary: string): BookingTemplateVars {
  const label = (p.appointmentLabel || "Consulta").trim();
  const dt = formatDateTimeBR(p.datetimeIso);
  return {
    nome: p.patientName || "",
    telefone: formatPhoneDisplay(p.phone),
    evento: EVENT_VERB[p.event],
    data: dt.date,
    hora: dt.time,
    data_hora: dt.combined,
    dia_semana: dt.weekday,
    tipo_consulta: label,
    agenda: (p.agenda ?? "").trim(),
    interesse: (p.interesse ?? "").trim(),
    observacoes: (p.observacoes ?? "").trim(),
    resumo: (summary ?? "").trim(),
    agente: (p.agenteNome ?? "").trim(),
    empresa: (p.empresa ?? "").trim(),
    cf: p.customFields ?? {},
  };
}

/**
 * Substitui {{var}} e {{cf.<chave>}} no template. Variáveis desconhecidas viram
 * string vazia (não causam erro). Mantém suporte a Markdown WhatsApp como está
 * (não escapamos nada — o template é fornecido por superadmin, não por lead).
 */
export function renderBookingTemplate(template: string, vars: BookingTemplateVars): string {
  return template.replace(/\{\{\s*([a-zA-Z_][a-zA-Z0-9_.]*)\s*\}\}/g, (_m, key: string) => {
    if (key.startsWith("cf.")) {
      const cfKey = key.slice(3);
      return vars.cf[cfKey] ?? "";
    }
    const v = (vars as unknown as Record<string, unknown>)[key];
    return typeof v === "string" ? v : "";
  });
}

/** Retorna true se o template realmente usa {{resumo}} em algum lugar. */
function templateUsesSummary(template: string): boolean {
  return /\{\{\s*resumo\s*\}\}/.test(template);
}

interface EscalationConfigRow {
  grupo_alerta: string | null;
  evolution_instance: string | null;
  notificar_agendamentos: boolean | null;
  notification_template: string | null;
  notification_summary_enabled: boolean | null;
  notification_summary_instruction: string | null;
}

/**
 * Envia a notificação de agendamento ao grupo configurado (se ativo).
 * Best-effort: nunca lança — só loga e retorna { sent }.
 */
export async function notifyBooking(
  params: NotifyBookingParams,
): Promise<{ sent: boolean }> {
  const sb = getSelfhost();

  const { data: cfgRaw } = await sb
    .from("agent_escalation")
    .select(
      "grupo_alerta, evolution_instance, notificar_agendamentos, " +
        "notification_template, notification_summary_enabled, notification_summary_instruction",
    )
    .eq("agent_id", params.agentId)
    .single();
  const cfg = cfgRaw as EscalationConfigRow | null;

  if (!cfg?.notificar_agendamentos || !cfg.grupo_alerta || !cfg.evolution_instance) {
    return { sent: false };
  }

  const template = (cfg.notification_template?.trim() || DEFAULT_TEMPLATE);
  const summaryEnabled = cfg.notification_summary_enabled !== false; // default true
  const summaryInstruction =
    cfg.notification_summary_instruction?.trim() || DEFAULT_SUMMARY_INSTRUCTION;

  // Decide se precisa gerar resumo: só quando habilitado + template usa {{resumo}}
  // + não veio resumo pronto. Economiza tokens em quem desliga ou não usa.
  let summary = params.summary ?? "";
  const needGenerate =
    !summary && summaryEnabled && templateUsesSummary(template) && !!params.history?.length;
  if (needGenerate && params.orKey && params.summaryModel) {
    summary = await summarizeConversationForNotification(
      params.orKey,
      params.summaryModel,
      params.history ?? [],
      summaryInstruction,
    );
  }
  // Fallback do resumo: usa observações do lead se nada veio.
  if (!summary && summaryEnabled) summary = (params.observacoes ?? "").trim();

  const vars = buildTemplateVars(params, summary);
  const text = renderBookingTemplate(template, vars).trim();
  if (!text) {
    console.warn("[notify-booking] template renderizou vazio — nada enviado");
    return { sent: false };
  }

  try {
    const res = await evoSendText({
      instance: cfg.evolution_instance,
      number: cfg.grupo_alerta,
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
 *
 * O caller pode customizar o prompt do sistema via `customInstruction` (ex.:
 * vindo de agent_escalation.notification_summary_instruction).
 */
export async function summarizeConversationForNotification(
  orKey: string,
  model: string,
  history: { role: string; content: string }[],
  customInstruction?: string,
): Promise<string> {
  const transcript = history
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m) => `${m.role === "user" ? "Lead" : "Agente"}: ${m.content}`)
    .join("\n")
    .slice(0, 6000);

  if (!transcript.trim()) return "";

  const baseDefault =
    "Você resume conversas de atendimento para uma notificação interna da equipe. " +
    "Produza UM resumo objetivo em português (1-2 frases, máx 60 palavras) com o " +
    "contexto do lead/paciente e o que foi agendado. Não use saudações, não use " +
    "primeira pessoa, não inclua telefone nem links. Responda apenas o resumo.";
  const system = customInstruction?.trim()
    ? `Você resume conversas de atendimento para uma notificação interna da equipe.\n\n` +
      `INSTRUÇÕES DO USUÁRIO:\n${customInstruction.trim()}\n\n` +
      `Responda APENAS o resumo, em português, sem saudações ou primeira pessoa.`
    : baseDefault;

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

/** Exportado para a UI de pré-visualização e para o orchestrator. */
export { DEFAULT_TEMPLATE, DEFAULT_SUMMARY_INSTRUCTION };
