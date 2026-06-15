// SCHEDULER AGENT
// Único agente que enxerga as ferramentas de agendamento (Clinicorp/Clinup/GCal).
// Operando em stages: SLOT_OFFER, NAME_COLLECT, BOOKING, CONFIRMED.
//
// Filosofia:
// - Prompt curto e focado (~1.5k tokens vs 14k do monolito).
// - Structured output: { reply, next_stage, lead_data_patch }.
// - O orchestrator valida a transição. O agente não pode "saltar" estados.
// - Tools só estão disponíveis se o stage atual permitir (ex.: agendar_clinicorp
//   só funciona se já temos selected_slot_iso + name).

import { z } from "zod";
import { sanitizeStructuredAgentJson, stripNullishFields } from "./parse-llm-json.server";
import {
  listClinicorpSlots,
  createClinicorpAppointment,
  cancelClinicorpAppointment,
  findClinicorpPatient,
  type ClinicorpSlot,
} from "@/lib/tools/clinicorp.server";
import {
  listGoogleCalendarSlots,
  createGoogleCalendarEvent,
  cancelGoogleCalendarEvent,
  findGoogleCalendarEventsByPhone,
  activeWeekdayKeys,
  diaSemanaChave,
  type GCalSlot,
} from "@/lib/tools/google-calendar.server";
import { loadHelenaAccount } from "@/lib/helena.server";
import {
  swapTagBySynonyms,
  NOT_SCHEDULED_SYNONYMS,
  SCHEDULED_SYNONYMS,
} from "@/lib/helena-tags.server";
import {
  searchKnowledge,
  formatChunksAsContext,
} from "@/lib/knowledge/retrieval.server";
import {
  sendMediaBySlug,
  getAvailableMediaForPrompt,
} from "./send-media.server";
import type { AgentContext, AgentResult } from "./context";
import type { LeadData, Stage } from "./stage";
import {
  callLlmWithFallback,
  callLlmStructuredWithFallback,
  type LlmMessage,
  type LlmTool,
} from "./llm.server";
import { normalizeBrazilPhone } from "@/lib/conversation-channel.server";
import { decideRagNeed } from "./rag-gate.server";
import { buildOwnerStylePromptBlock } from "./owner-style-prompt.server";
import {
  buildBookingFieldsPromptBlock,
  clearBookingFields,
  defaultCommitmentQuestion,
  getBookingFields,
  getBookingFieldsForChannel,
  resolveCollectedPhone,
  buildChannelPhonePromptBlock,
  getMissingBookingFields,
  isCommitmentRequired,
  isReadyForBooking,
  mergeLeadDataPatch,
  preflightBookingFields,
  resolveBookingLeadName,
  tryAutoSelectOfferedSlot,
  resolveGcalEventTemplates,
} from "@/lib/booking-template";

/**
 * Após agendamento confirmado: remove a tag de "não agendado" e adiciona a
 * de "agendado" — usando os sinônimos cadastrados no CRM da conta.
 * Funciona para clínicas ("N/A Não Agendado" → "Agendado") e para escolas
 * ("Lead" → "Matriculado") sem mudar código — só depende do CRM.
 * MANTÉM a tag de interesse (o swap só toca as 2 tags de status).
 */
async function applyBookedTagSwap(ctx: AgentContext): Promise<void> {
  if (ctx.dryRun || ctx.disableTags) return;
  if (!ctx.helenaContact?.id) return;
  if (ctx.leadData.booked_tag_applied) return; // idempotente
  try {
    const helena = await loadHelenaAccount(ctx.accountId);
    const res = await swapTagBySynonyms(
      helena,
      ctx.helenaContact.id,
      NOT_SCHEDULED_SYNONYMS,
      SCHEDULED_SYNONYMS,
    );
    if (res.ok) {
      console.log(
        `[scheduler] tag swap após agendamento: removeu=${res.removed ?? "(não existia)"} adicionou=${res.added}`,
      );
    } else {
      console.warn(`[scheduler] tag swap falhou: motivo=${res.reason}`);
    }
  } catch (e) {
    console.warn("[scheduler] erro ao trocar tags pós-agendamento:", e);
  }
}

// ── Schema de saída estruturada ────────────────────────────────────────────

const VALID_STAGES = ["SLOT_OFFER", "NAME_COLLECT", "BOOKING", "CONFIRMED", "ESCALATED"] as const;

// custom_fields é Record<string,string>, mas o LLM às vezes manda número
// (ex: convidados: 150) ou boolean. Coage para string em vez de quebrar o
// turn; descarta null/objeto/array.
const coercibleStringRecord = z.preprocess((val) => {
  if (val == null || typeof val !== "object" || Array.isArray(val)) return val;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
    if (typeof v === "string") out[k] = v;
    else if (typeof v === "number" || typeof v === "boolean") out[k] = String(v);
  }
  return out;
}, z.record(z.string()));

const ResultSchema = z.object({
  reply: z.string().min(1, "Reply não pode ser vazio"),
  // next_stage opcional — fallback aplicado no runSchedulerAgent (mantém stage atual).
  next_stage: z.enum(VALID_STAGES).optional(),
  lead_data_patch: z
    .object({
      name: z.string().nullish(),
      selected_slot_iso: z.string().nullish(),
      selected_agenda: z.string().nullish(),
      dentist_person_id: z.number().nullish(),
      commitment_confirmed: z.boolean().nullish(),
      patient_id: z.number().nullish(),
      appointment_id: z.union([z.number(), z.string()]).nullish(),
      notes: z.string().nullish(),
      escalation_reason: z.string().nullish(),
      custom_fields: coercibleStringRecord.nullish(),
    })
    .optional(),
  reasoning: z.string().optional(),
});

type SchedulerJsonResult = z.infer<typeof ResultSchema>;

// ── Ferramentas que o scheduler pode chamar ────────────────────────────────

const SCHEDULER_TOOLS: LlmTool[] = [
  {
    type: "function",
    function: {
      name: "buscar_paciente",
      description:
        "Procura paciente no Clinicorp pelo telefone do lead (já fixo no contexto). " +
        "Use UMA vez no início de NAME_COLLECT para evitar duplicar cadastro. " +
        "Retorna {patient_id, name} se encontrado, ou {found: false}.",
      parameters: {
        type: "object",
        properties: {},
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "listar_horarios",
      description:
        "Lista horários disponíveis na agenda (Clinicorp OU Google Calendar, conforme integração ativa da conta). " +
        "Use quando precisar oferecer slots ao lead (stage SLOT_OFFER). " +
        "Retorna no máximo 6 horários alinhados à duração configurada. " +
        "IMPORTANTE: se o lead pedir uma DATA específica (ex: '25 de julho', '20/07', 'dia 3'), passe-a em `data_alvo` (formato YYYY-MM-DD) para a busca começar nessa data — caso contrário a busca olha só os próximos dias e NÃO vai alcançar datas distantes. " +
        "Aliases reconhecidos (caso o prompt mencione): listar_horarios_clinicorp, listar_horarios_google_calendar, listar_horarios_clinup.",
      parameters: {
        type: "object",
        properties: {
          data_alvo: {
            type: "string",
            description:
              "Data específica pedida pelo lead, no formato YYYY-MM-DD (ex: '2026-07-25'). A busca começa nessa data. Omita se o lead não citou uma data.",
          },
          dias_a_frente: {
            type: "integer",
            description:
              "Tamanho da janela de busca em dias a partir do início (default 7). Use um valor maior se quiser oferecer mais alternativas.",
          },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "criar_agendamento",
      description:
        "Cria o agendamento na agenda integrada (Google Calendar, Clinicorp ou Clinup). " +
        "Use APENAS quando todos os campos obrigatórios estiverem preenchidos e lead_data.selected_slot_iso existir. " +
        "NUNCA confirme agendamento ao lead sem chamar esta tool e receber ok=true com appointment_id. " +
        "Retorna {ok, appointment_id} ou {ok:false, error}.",
      parameters: {
        type: "object",
        properties: {},
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "cancelar_agendamento",
      description:
        "Cancela o agendamento ATIVO do lead (que já tem appointment_id) e remove o evento da agenda " +
        "(Clinicorp/Google Calendar). Use quando o lead pedir explicitamente para CANCELAR e NÃO quiser " +
        "remarcar. Depois, confirme o cancelamento ao lead. Retorna {ok, cancelled} ou {ok:false, error}.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "remarcar_agendamento",
      description:
        "Cancela o agendamento ATIVO do lead e REINICIA a oferta de horários para marcar um novo. " +
        "Use quando o lead quiser MUDAR a data/horário do agendamento existente. Após esta tool, " +
        "ofereça novos horários (chame listar_horarios) e use next_stage=\"SLOT_OFFER\". " +
        "Retorna {ok, cancelled, reoffer:true} ou {ok:false, error}.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "enviar_midia",
      description:
        "Envia uma mídia cadastrada (imagem, vídeo, áudio ou PDF) para o lead via WhatsApp. " +
        "Use quando fizer sentido no fluxo (ex: vídeo de localização ao confirmar agendamento, " +
        "foto da fachada da clínica). As mídias disponíveis estão na seção 'MÍDIAS DISPONÍVEIS'.",
      parameters: {
        type: "object",
        properties: {
          slug: {
            type: "string",
            description: "Slug EXATO da mídia (ex: 'localizacao', 'fachada').",
          },
          caption: {
            type: "string",
            description: "Legenda opcional.",
          },
        },
        required: ["slug"],
      },
    },
  },
];

/** True quando a conta tem 2+ agendas Google e o agente deve escolher. */
function isMultiAgenda(ctx: AgentContext): boolean {
  return ctx.integrations.googleCalendar && (ctx.googleAgendas?.length ?? 0) >= 2;
}

/**
 * Monta as tools do scheduler. Em multi-agenda (2+ agendas Google), injeta o
 * parâmetro `agenda` (enum dos labels) nas tools que tocam a agenda, para o
 * agente escolher conforme as regras do prompt. Em agenda única, retorna o
 * conjunto base inalterado (comportamento idêntico ao atual).
 */
function buildSchedulerTools(ctx: AgentContext): LlmTool[] {
  if (!isMultiAgenda(ctx)) return SCHEDULER_TOOLS;

  const labels = ctx.googleAgendas.map((a) => a.label);
  const agendaProp = {
    type: "string",
    enum: labels,
    description:
      "Qual agenda usar nesta operação. Escolha EXATAMENTE um destes labels conforme a situação:\n" +
      ctx.googleAgendas
        .map((a) => `- "${a.label}": ${a.descricao || "(sem descrição)"}`)
        .join("\n"),
  };

  return SCHEDULER_TOOLS.map((t) => {
    if (t.function.name !== "listar_horarios" && t.function.name !== "criar_agendamento") {
      return t;
    }
    const params = t.function.parameters as {
      type: string;
      properties?: Record<string, unknown>;
      required?: string[];
    };
    return {
      ...t,
      function: {
        ...t.function,
        parameters: {
          ...params,
          properties: { ...(params.properties ?? {}), agenda: agendaProp },
          required: Array.from(new Set([...(params.required ?? []), "agenda"])),
        },
      },
    };
  });
}

// ── Execução das tools ─────────────────────────────────────────────────────

interface ToolOutcome {
  result: string;
  patch?: Partial<LeadData>;
}

/**
 * Resolve o calendarId (Google) a partir do label de agenda em multi-agenda.
 * Retorna:
 *  - { calendarId } quando o label é válido.
 *  - { error } quando multi-agenda mas o label está ausente ou é inválido.
 *  - {} (sem calendarId nem error) em agenda única → usa o calendar_id padrão.
 */
interface ResolvedAgenda {
  calendarId?: string;
  agendaLabel?: string;
  duracaoMinutos?: number;
  businessHoursJson?: string;
  umaPorDia?: boolean;
  diasUmaPorDia?: string[];
  granularidadeMinutos?: number;
  bufferMinutos?: number;
  bufferDias?: string[];
  tituloTemplate?: string;
  descricaoTemplate?: string;
  error?: string;
}

function resolveGcalAgenda(ctx: AgentContext, label?: string): ResolvedAgenda {
  if (!isMultiAgenda(ctx)) return {};
  const validLabels = ctx.googleAgendas.map((a) => a.label);
  if (!label || !label.trim()) {
    return {
      error: `Esta conta tem várias agendas. Informe o parâmetro "agenda" com um destes valores: ${validLabels.join(", ")}.`,
    };
  }
  const wanted = label.trim().toLowerCase();
  const match = ctx.googleAgendas.find((a) => a.label.toLowerCase() === wanted);
  if (!match) {
    return {
      error: `Agenda "${label}" não existe. Use exatamente um destes: ${validLabels.join(", ")}.`,
    };
  }
  return {
    calendarId: match.calendarId,
    agendaLabel: match.label,
    duracaoMinutos: match.duracaoMinutos,
    businessHoursJson: match.businessHoursJson,
    umaPorDia: match.umaPorDia,
    diasUmaPorDia: match.diasUmaPorDia,
    granularidadeMinutos: match.granularidadeMinutos,
    bufferMinutos: match.bufferMinutos,
    bufferDias: match.bufferDias,
    tituloTemplate: match.tituloTemplate,
    descricaoTemplate: match.descricaoTemplate,
  };
}

async function execBuscarPaciente(ctx: AgentContext): Promise<ToolOutcome> {
  if (!ctx.effectivePhone) {
    return { result: JSON.stringify({ found: false, reason: "no_phone" }) };
  }

  // Google Calendar: usa busca por telefone na descrição dos eventos
  if (ctx.integrations.googleCalendar) {
    try {
      const events = await findGoogleCalendarEventsByPhone(ctx.accountId, ctx.effectivePhone);
      if (events.length === 0) {
        return { result: JSON.stringify({ found: false }) };
      }
      // Retorna o próximo agendamento futuro
      const next = events.sort((a, b) => a.inicio.localeCompare(b.inicio))[0];
      return {
        result: JSON.stringify({
          found: true,
          appointment_id: next.id,
          titulo: next.titulo,
          inicio: next.inicio,
          ...(next.agendaLabel ? { agenda: next.agendaLabel } : {}),
        }),
        patch: {
          appointment_id: next.id,
          // Marca em qual agenda o evento existe → cancelar/remarcar acertam o calendário.
          ...(next.agendaLabel ? { selected_agenda: next.agendaLabel } : {}),
        },
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { result: JSON.stringify({ found: false, error: msg.slice(0, 200) }) };
    }
  }

  // Default: Clinicorp
  const patient = await findClinicorpPatient(ctx.accountId, ctx.effectivePhone);
  if (!patient?.id) {
    return { result: JSON.stringify({ found: false }) };
  }
  return {
    result: JSON.stringify({ found: true, patient_id: patient.id, name: patient.name }),
    patch: {
      patient_id: patient.id,
      // Não sobrescreve um nome já coletado pelo agente.
      ...(ctx.leadData.name ? {} : { name: patient.name }),
    },
  };
}

function formatSlot(s: ClinicorpSlot): {
  iso: string;
  date_label: string;
  time_label: string;
  dentist_person_id?: number;
} {
  const d = new Date(s.start);
  const date_label = new Intl.DateTimeFormat("pt-BR", {
    timeZone: "America/Sao_Paulo",
    weekday: "long",
    day: "2-digit",
    month: "2-digit",
  }).format(d);
  return {
    iso: s.start,
    date_label,
    time_label: s.fromTime,
    dentist_person_id: s.dentistPersonId,
  };
}

function formatGCalSlot(s: GCalSlot): {
  iso: string;
  date_label: string;
  time_label: string;
} {
  return {
    iso: s.inicio,
    date_label: s.date_label,
    time_label: s.time_label,
  };
}

/** Converte "YYYY-MM-DD" (data pedida pelo lead) em Date no início do dia BRT.
 *  Retorna null se o formato for inválido. Aceita ISO mais longo (usa os 10
 *  primeiros caracteres). */
function parseDataAlvoBrt(dataAlvo?: string): Date | null {
  if (!dataAlvo || typeof dataAlvo !== "string") return null;
  const m = dataAlvo.trim().slice(0, 10).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const d = new Date(`${m[1]}-${m[2]}-${m[3]}T00:00:00-03:00`);
  return isNaN(d.getTime()) ? null : d;
}

async function execListarHorarios(
  ctx: AgentContext,
  diasAFrente?: number,
  agendaLabel?: string,
  dataAlvo?: string,
): Promise<ToolOutcome> {
  const selected = ctx.leadData.selected_slot_iso;
  if (selected) {
    const existing = ctx.leadData.offered_slots?.find((s) => s.iso === selected);
    const slots = existing
      ? [existing]
      : [
          {
            iso: selected,
            date_label: "(horário escolhido)",
            time_label: new Intl.DateTimeFormat("pt-BR", {
              timeZone: "America/Sao_Paulo",
              hour: "2-digit",
              minute: "2-digit",
              hour12: false,
            }).format(new Date(selected)),
          },
        ];
    console.log(
      `[scheduler] listar_horarios ignorado conv=${ctx.conversationId} — slot já escolhido iso=${selected}`,
    );
    return {
      result: JSON.stringify({
        count: slots.length,
        slots,
        note: "Lead já escolheu horário (selected_slot_iso). NÃO re-listar; confirme o slot e avance a coleta.",
      }),
      patch: {},
    };
  }

  const now = new Date();
  // Ancoragem na data pedida pelo lead (data_alvo). Se for uma data futura,
  // a busca começa nela; senão começa agora.
  const anchor = parseDataAlvoBrt(dataAlvo);
  const today = anchor && anchor.getTime() > now.getTime() ? anchor : now;
  const end = new Date(today.getTime() + (diasAFrente ?? 7) * 24 * 60 * 60 * 1000);

  // Google Calendar: usa lógica de janelas com expediente da clínica
  if (ctx.integrations.googleCalendar) {
    // Multi-agenda: resolve qual calendário consultar a partir do label.
    const resolved = resolveGcalAgenda(ctx, agendaLabel);
    if (resolved.error) {
      return { result: JSON.stringify({ count: 0, slots: [], error: resolved.error }) };
    }
    // Duração: específica da agenda (multi-agenda) ou a global do agente.
    const duracao =
      resolved.duracaoMinutos ??
      (Number(ctx.agentSettings.duracao_consulta_minutos ?? "40") || 40);
    // Horários liberados: específicos da agenda ou os globais do agente.
    const businessHoursJson =
      resolved.businessHoursJson ?? ctx.agentSettings.business_hours_json;
    // Modo "uma por dia" (festas): sem data_alvo, amplia a janela padrão para
    // alcançar os próximos dias livres (festas costumam ser semanas à frente).
    const gcalEnd =
      resolved.umaPorDia && !anchor && diasAFrente == null
        ? new Date(today.getTime() + 60 * 24 * 60 * 60 * 1000)
        : end;
    // Granularidade: passo configurado da agenda OU igual à duração (slots não
    // sobrepostos). Ex: festas de 240min com opções a cada 30min (12:00, 12:30...).
    const slots = await listGoogleCalendarSlots(
      ctx.accountId,
      {
        periodoInicio: today.toISOString(),
        periodoFim: gcalEnd.toISOString(),
        tamanhoJanelaMinutos: duracao,
        granularidade: resolved.granularidadeMinutos ?? duracao,
        amostras: 6,
        businessHoursJson,
        umaPorDia: resolved.umaPorDia,
        umaPorDiaDias: resolved.diasUmaPorDia,
        bufferMinutos: resolved.bufferMinutos,
        bufferDias: resolved.bufferDias,
      },
      resolved.calendarId,
    );
    const formatted = slots.map(formatGCalSlot);
    // Persiste a agenda escolhida para o booking/cancelamento usarem a mesma.
    const agendaPatch: Partial<LeadData> = resolved.agendaLabel
      ? { selected_agenda: resolved.agendaLabel }
      : {};

    // Quando vier vazio, devolve diagnostico p/ o LLM decidir bem
    // (ex: pedir pra suporte, sugerir janela maior, etc.) e nao alucinar.
    if (formatted.length === 0) {
      const hasBusinessHours = !!businessHoursJson?.trim();
      const diasAtivos = activeWeekdayKeys(businessHoursJson);
      // Data especifica pedida: verifica se o dia da semana esta habilitado
      // nos horarios liberados — sem isso o LLM conclui "tudo ocupado" e
      // responde errado quando na verdade o dia nem abre (ex: sabado).
      let dataAlvoDebug: Record<string, unknown> = {};
      let causa: string;
      if (!hasBusinessHours) {
        causa = "Horario de funcionamento nao esta configurado nas Settings.";
      } else if (anchor) {
        const diaAlvo = diaSemanaChave(anchor);
        const diaAtivo = diasAtivos.includes(diaAlvo);
        dataAlvoDebug = {
          data_alvo: anchor.toISOString().slice(0, 10),
          dia_semana_alvo: diaAlvo,
          dia_ativo_no_expediente: diaAtivo,
        };
        causa = diaAtivo
          ? "A data pedida esta com todos os horarios ocupados nesta agenda. Ofereca a data livre mais proxima (chame de novo sem data_alvo ou com outra data)."
          : `A data pedida cai em ${diaAlvo.toUpperCase()}, dia que NAO esta habilitado nos horarios desta agenda (dias ativos: ${diasAtivos.join(", ") || "nenhum"}). Informe ao lead que nao atendemos nesse dia da semana e ofereca um dia ativo.`;
      } else {
        causa =
          "Todos os horarios no periodo consultado estao ocupados na agenda Google. Tente um periodo maior OU verifique se realmente ha disponibilidade.";
      }
      const diag = {
        count: 0,
        slots: [],
        debug: {
          duracao_consulta_min: duracao,
          dias_consultados: diasAFrente ?? 7,
          tem_horario_funcionamento: hasBusinessHours,
          dias_ativos: diasAtivos,
          ...dataAlvoDebug,
          possivel_causa: causa,
        },
      };
      console.warn("[scheduler] listar_horarios retornou 0 slots:", diag.debug);
      return {
        result: JSON.stringify(diag),
        patch: { offered_slots: [], ...agendaPatch },
      };
    }

    return {
      result: JSON.stringify({
        count: formatted.length,
        slots: formatted,
        ...(resolved.agendaLabel ? { agenda: resolved.agendaLabel } : {}),
      }),
      patch: { offered_slots: formatted, ...agendaPatch },
    };
  }

  // Default: Clinicorp
  const fmt = (d: Date) =>
    new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(d);

  const slots = await listClinicorpSlots(ctx.accountId, fmt(today), fmt(end));
  // Limita a 6 (2 por dia em até 3 dias) para não confundir o lead.
  const limited = slots.slice(0, 6).map(formatSlot);
  return {
    result: JSON.stringify({ count: limited.length, slots: limited }),
    patch: { offered_slots: limited },
  };
}

/**
 * Telefone a usar no agendamento. Prefere o `effectivePhone` (telefone do
 * WhatsApp / CRM resolvido pelo orquestrador). Quando ele está ausente — caso
 * típico de canais sem telefone no contato (Instagram/Messenger) ou contato de
 * teste sem número no CRM —, cai para o telefone que o próprio lead informou na
 * conversa e que ficou salvo em `lead_data.custom_fields` (ex.: whatsapp_phone).
 * Sem esse fallback, o lead enviava o número, mas `criar_agendamento` devolvia
 * "telefone ausente" mesmo assim.
 */
function resolveBookingPhone(ctx: AgentContext): string | null {
  if (ctx.effectivePhone) return ctx.effectivePhone;
  return resolveCollectedPhone(
    getBookingFields(ctx.agentSettings),
    ctx.leadData,
    normalizeBrazilPhone,
  );
}

async function execCriarAgendamento(
  ctx: AgentContext,
  agendaLabel?: string,
): Promise<ToolOutcome> {
  const ld = ctx.leadData;

  // GUARD DE IDEMPOTENCIA — bug "agendamento duplo" (27/05/2026):
  // se ja temos appointment_id (criado seja pelo tryDeterministicBooking
  // deste turn, seja por turn anterior), NUNCA chamar a API de novo.
  // Quando o LLM (gpt-4.1-mini) insiste em chamar criar_agendamento
  // mesmo depois do evento ja ter sido criado, a segunda chamada conflita
  // com o evento que ele mesmo criou e devolve "HORÁRIO INDISPONÍVEL" —
  // o lead ve o evento na agenda mas recebe mensagem de erro.
  if (ld.appointment_id) {
    console.warn(
      `[scheduler:telemetry] ${JSON.stringify({
        event: "double_booking_blocked",
        conv: ctx.conversationId,
        account: ctx.accountId,
        agent: ctx.agentId,
        appointment_id: ld.appointment_id,
        model: ctx.model,
      })}`,
    );
    return {
      result: JSON.stringify({
        ok: true,
        appointment_id: ld.appointment_id,
        already_booked: true,
        note: "Agendamento ja existe — nao foi recriado. Apenas confirme ao lead.",
      }),
    };
  }

  const bookingFields = getBookingFieldsForChannel(ctx.agentSettings, {
    channel: ctx.channel,
    effectivePhone: ctx.effectivePhone,
  });
  const missing = getMissingBookingFields(bookingFields, ld);
  if (missing.length > 0) {
    return {
      result: JSON.stringify({
        ok: false,
        error: `Campos obrigatórios pendentes: ${missing.map((f) => f.key).join(", ")}`,
        missing: missing.map((f) => ({ key: f.key, question: f.question })),
      }),
    };
  }

  if (!ld.selected_slot_iso) {
    return { result: JSON.stringify({ ok: false, error: "selected_slot_iso ausente" }) };
  }

  const leadName = resolveBookingLeadName(ld);
  if (!leadName) {
    return { result: JSON.stringify({ ok: false, error: "name ausente" }) };
  }
  const bookingPhone = resolveBookingPhone(ctx);
  if (!bookingPhone) {
    return { result: JSON.stringify({ ok: false, error: "telefone ausente" }) };
  }

  const bookingCtx: AgentContext = {
    ...ctx,
    effectivePhone: bookingPhone,
    leadData: { ...ld, name: leadName },
  };

  // Google Calendar
  if (ctx.integrations.googleCalendar) {
    try {
      // Multi-agenda: usa o label informado OU a agenda escolhida na oferta de
      // horários (selected_agenda). Garante que o evento vá para a MESMA agenda
      // onde os slots livres foram consultados.
      const resolved = resolveGcalAgenda(ctx, agendaLabel ?? ld.selected_agenda);
      if (resolved.error) {
        return { result: JSON.stringify({ ok: false, error: resolved.error }) };
      }
      // Duração específica da agenda (multi-agenda) ou a global do agente.
      const duracao =
        resolved.duracaoMinutos ??
        (Number(ctx.agentSettings.duracao_consulta_minutos ?? "40") || 40);
      // Título/descrição específicos da agenda (multi-agenda); vazio → global.
      const { titulo, descricao } = resolveGcalEventTemplates(bookingCtx, {
        titleTemplate: resolved.tituloTemplate,
        descriptionTemplate: resolved.descricaoTemplate,
      });
      const ev = await createGoogleCalendarEvent(
        ctx.accountId,
        {
          eventoInicio: ld.selected_slot_iso,
          duracaoMinutos: duracao,
          titulo,
          descricao,
          telefone: bookingPhone,
        },
        resolved.calendarId,
      );
      await applyBookedTagSwap(ctx);
      return {
        result: JSON.stringify({
          ok: true,
          appointment_id: ev.id,
          datetime: ev.start,
          calendar_event_link: ev.htmlLink,
        }),
        patch: {
          appointment_id: ev.id,
          name: leadName,
          booked_tag_applied: true,
          ...(resolved.agendaLabel ? { selected_agenda: resolved.agendaLabel } : {}),
        },
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[scheduler] criar_agendamento GCal falhou: ${msg}`);
      return { result: JSON.stringify({ ok: false, error: msg.slice(0, 300) }) };
    }
  }

  // Default: Clinicorp
  try {
    const appt = await createClinicorpAppointment(ctx.accountId, {
      phone: bookingPhone,
      name: leadName,
      datetime: ld.selected_slot_iso,
      dentistPersonId: ld.dentist_person_id,
    });
    await applyBookedTagSwap(ctx);
    return {
      result: JSON.stringify({ ok: true, appointment_id: appt.id, datetime: appt.datetime }),
      patch: { appointment_id: appt.id, name: leadName, booked_tag_applied: true },
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { result: JSON.stringify({ ok: false, error: msg.slice(0, 300) }) };
  }
}

/** Reverte as tags pós-cancelamento: remove "Agendado" e volta "Não Agendado". */
async function applyUnbookedTagSwap(ctx: AgentContext): Promise<void> {
  if (ctx.dryRun || ctx.disableTags) return;
  if (!ctx.helenaContact?.id) return;
  try {
    const helena = await loadHelenaAccount(ctx.accountId);
    const res = await swapTagBySynonyms(
      helena,
      ctx.helenaContact.id,
      SCHEDULED_SYNONYMS,
      NOT_SCHEDULED_SYNONYMS,
    );
    if (res.ok) {
      console.log(
        `[scheduler] tag swap pós-cancelamento: removeu=${res.removed ?? "(n/a)"} adicionou=${res.added}`,
      );
    }
  } catch (e) {
    console.warn("[scheduler] erro ao reverter tags pós-cancelamento:", e);
  }
}

/**
 * Cancela o agendamento ativo do lead (Clinicorp ou Google Calendar) e limpa
 * o appointment_id. Com `reoffer=true` (remarcação), também limpa o slot e os
 * horários oferecidos para reiniciar a oferta. Determinístico — não precisa de
 * outro turn de LLM para efetivar o cancelamento.
 */
async function execCancelarAgendamento(
  ctx: AgentContext,
  opts?: { reoffer?: boolean },
): Promise<ToolOutcome> {
  const ld = ctx.leadData;
  if (!ld.appointment_id) {
    return {
      result: JSON.stringify({
        ok: false,
        error: "Nenhum agendamento ativo para cancelar.",
      }),
    };
  }

  const clearPatch: Partial<LeadData> = {
    appointment_id: undefined,
    booked_tag_applied: false,
    commitment_confirmed: false,
    appointment_cancelled: true, // sinal p/ o orquestrador limpar o appointment_id de fato
  };
  if (opts?.reoffer) {
    clearPatch.selected_slot_iso = undefined;
    clearPatch.offered_slots = undefined;
    clearPatch.dentist_person_id = undefined;
    clearPatch.reoffer_after_cancel = true;
  }

  if (ctx.dryRun) {
    return {
      result: JSON.stringify({ ok: true, cancelled: true, dry_run: true, reoffer: !!opts?.reoffer }),
      patch: clearPatch,
    };
  }

  try {
    if (ctx.integrations.googleCalendar) {
      // Multi-agenda: tenta primeiro a agenda conhecida (selected_agenda); se
      // não houver, cancelGoogleCalendarEvent varre todas as agendas.
      const resolved = resolveGcalAgenda(ctx, ld.selected_agenda);
      await cancelGoogleCalendarEvent(
        ctx.accountId,
        String(ld.appointment_id),
        resolved.calendarId,
      );
    } else {
      await cancelClinicorpAppointment(ctx.accountId, ld.appointment_id);
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[scheduler] cancelamento falhou conv=${ctx.conversationId}: ${msg}`);
    return { result: JSON.stringify({ ok: false, error: msg.slice(0, 200) }) };
  }

  await applyUnbookedTagSwap(ctx);
  console.log(
    `[scheduler] agendamento cancelado conv=${ctx.conversationId} appt=${ld.appointment_id} reoffer=${!!opts?.reoffer}`,
  );

  return {
    result: JSON.stringify({
      ok: true,
      cancelled: true,
      reoffer: !!opts?.reoffer,
      note: opts?.reoffer
        ? "Agendamento anterior cancelado. Agora ofereça novos horários ao lead (next_stage=SLOT_OFFER)."
        : "Agendamento cancelado com sucesso. Confirme ao lead.",
    }),
    patch: clearPatch,
  };
}

// ── Prompts (separados em cached + dynamic) ───────────────────────────────

function buildCachedSystemPrompt(ctx: AgentContext): string {
  const s = ctx.agentSettings;
  const orgLabel = s.company_name?.trim() || "empresa";
  const appointmentLabel = s.appointment_type_label?.trim() || "Consulta";
  const commitmentQ = defaultCommitmentQuestion(s);
  const commitmentEnabled = isCommitmentRequired(s) && !!commitmentQ;
  const bookingFields = getBookingFieldsForChannel(s, {
    channel: ctx.channel,
    effectivePhone: ctx.effectivePhone,
  });
  const phoneBlock = buildChannelPhonePromptBlock(ctx.channel, ctx.effectivePhone);
  const fieldsBlock = buildBookingFieldsPromptBlock(bookingFields, ctx.leadData);

  // Scaffold técnico — SEMPRE presente, mesmo quando o prompt do dono domina.
  // Contém estágios, ferramentas, guardrails inegociáveis (ex: não confirmar
  // sem appointment_id) e o formato JSON — tudo que o parser e a máquina de
  // estados precisam para funcionar, independente do comportamento escrito.
  const technicalScaffold = `# ⚙️ REGRAS TÉCNICAS DO SISTEMA (não exibir ao lead)

Você opera no MÓDULO DE AGENDAMENTO. O que fazer em cada estágio:
- **SLOT_OFFER**: ofereça no máx 2 horários. SEMPRE chame listar_horarios
  primeiro (se selected_slot_iso vazio). Nunca invente horários. Se o lead
  pedir uma DATA específica (ex: "25 de julho", "20/07"), passe-a em
  \`data_alvo\` (YYYY-MM-DD) ao chamar listar_horarios. Só avance para
  NAME_COLLECT quando selected_slot_iso estiver preenchido.
- **NAME_COLLECT**: só se selected_slot_iso existir. Confirme o slot. NÃO
  chame listar_horarios. Colete os campos obrigatórios (UM por mensagem).${commitmentEnabled ? ` Ao final dos campos, pergunte: "${commitmentQ}"` : ""}
- **BOOKING**: o sistema cria o agendamento. Se criar_agendamento ok=true,
  confirme e use next_stage="CONFIRMED". Se ok=false, NÃO diga que agendou.
- **CONFIRMED**: só após appointment_id em lead_data. Agradeça e encerre.

# CANCELAMENTO E REMARCAÇÃO (quando já existe appointment_id)
- Se o lead pedir para CANCELAR e não quiser outro horário → chame
  cancelar_agendamento e confirme o cancelamento. NÃO peça novos horários.
- Se o lead quiser MUDAR a data/horário (remarcar) → chame remarcar_agendamento,
  depois ofereça novos horários (listar_horarios) e use next_stage="SLOT_OFFER".
- Nunca diga que cancelou/remarcou sem a tool retornar ok=true.

${fieldsBlock}
${phoneBlock ? `\n${phoneBlock}\n` : ""}

# GUARDRAILS INEGOCIÁVEIS
1. NUNCA diga "vou verificar", "estou consultando", "já retorno" — chame a tool de verdade.
2. NUNCA invente horários, IDs ou nomes. Use APENAS valores vindos das tools.
3. **NUNCA diga "agendei", "marquei" ou "confirmado" sem appointment_id** em lead_data (ok=true de criar_agendamento).
4. Se o lead já tem appointment_id em lead_data → next_stage="CONFIRMED".
5. NUNCA repita pergunta de campo que já consta em LEAD_DATA.
6. Se o lead pedir explicitamente humano → next_stage="ESCALATED".

# FORMATO DE SAÍDA OBRIGATÓRIO

Responda APENAS em JSON válido:
{
  "reply": "mensagem a enviar ao lead",
  "next_stage": "SLOT_OFFER" | "NAME_COLLECT" | "BOOKING" | "CONFIRMED" | "ESCALATED",
  "lead_data_patch": { ...campos aprendidos neste turn... },
  "reasoning": "1 frase explicando sua decisão (não vai para o lead)"
}

Campos válidos em lead_data_patch:
- name (string): nome COMPLETO do responsável / lead (nome + sobrenome) — guarde sempre o nome inteiro informado, nunca só o primeiro nome (vai para a agenda e cadastro do paciente)
- custom_fields (object): { "child_name": "...", "child_birth_date": "...", "guardians": "..." }
- selected_slot_iso (string): ISO do slot escolhido (copie de offered_slots)
- dentist_person_id (number): copie de offered_slots (Clinicorp)
- commitment_confirmed (boolean): true quando o lead confirma compromisso
- patient_id (number): do retorno de buscar_paciente
- appointment_id (string|number): do retorno de criar_agendamento
- notes (string): RESUMO RICO do agendamento para quem vai atender. Reúna o que foi descoberto na conversa, uma informação por linha (2 a 4 linhas curtas), por exemplo: motivo/motivação do contato; situação atual (ex.: escola e série atuais da criança); turma/interesse identificado; preferências (turno, observações). NÃO escreva apenas uma frase genérica — capture os detalhes úteis do histórico. Preserve notes já existentes e acrescente o que faltar.`;

  // Prompt do proprietário DOMINA quando presente.
  if (ctx.basePrompt && ctx.basePrompt.trim()) {
    return `${ctx.basePrompt.trim()}

${buildOwnerStylePromptBlock()}

${technicalScaffold}`;
  }

  return `Você é ${s.assistant_name || "a assistente"}, ${s.assistant_role || "atendente virtual"} da ${orgLabel}.

Você está no MÓDULO DE AGENDAMENTO. Seu objetivo é converter um lead já qualificado em um ${appointmentLabel.toLowerCase()} agendado — com o mínimo de fricção.

# ESTÁGIOS QUE VOCÊ OPERA

- **SLOT_OFFER**: ofereça no máximo 2 horários ao lead. SEMPRE use a tool listar_horarios primeiro (só se selected_slot_iso ainda estiver vazio). Nunca invente horários. Se o lead pedir uma DATA específica (ex: "25 de julho", "20/07"), passe-a em \`data_alvo\` (YYYY-MM-DD) ao chamar listar_horarios — sem isso a busca não alcança datas distantes. Só avance para NAME_COLLECT quando selected_slot_iso estiver preenchido (lead escolheu horário ou turno manhã/tarde).
- **NAME_COLLECT**: só opere aqui se selected_slot_iso existir. Confirme o slot escolhido. NÃO chame listar_horarios. Colete os campos obrigatórios abaixo (UM por mensagem).${commitmentEnabled ? ` Depois de todos os campos, pergunte compromisso: "${commitmentQ}"` : " Não pergunte sobre dentista/médico — use linguagem do negócio (visita, reunião, etc.)."}
- **BOOKING**: o sistema tenta criar o agendamento automaticamente. Se criar_agendamento retornar ok=true, confirme ao lead e use next_stage="CONFIRMED". Se ok=false, NÃO diga que agendou — peça desculpas e ofereça outro horário.
- **CONFIRMED**: só após appointment_id em lead_data (evento criado na agenda). Agradeça e encerre.

${fieldsBlock}
${phoneBlock ? `\n${phoneBlock}\n` : ""}

# REGRAS ABSOLUTAS

1. NUNCA diga "vou verificar", "estou consultando", "já te retorno" — chame a tool de verdade.
2. NUNCA invente horários, IDs ou nomes. Use APENAS valores das tools.
3. UMA pergunta por vez. Mensagens curtas. Use \\n\\n no reply para separar bolhas no WhatsApp.
4. NUNCA use "dentista" ou "consulta odontológica" se o contexto for escola/educação — use "${appointmentLabel}" e linguagem do prompt do proprietário.
5. Se o lead pedir explicitamente para falar com humano → next_stage="ESCALATED".
6. **NUNCA diga "agendei", "marquei" ou "está confirmado" sem appointment_id em lead_data** (ok=true de criar_agendamento).
7. Se o lead já tem appointment_id em lead_data → next_stage="CONFIRMED" e agradeça.
8. Se buscar_paciente retornar found=true e name combinar, confirme o nome com o lead ANTES de prosseguir.
9. **NUNCA repita pergunta de campo que já consta em LEAD_DATA / "Já coletados".** Telefone do lead já está no sistema — não peça telefone em custom_fields.

# FORMATO DE SAÍDA OBRIGATÓRIO

Responda APENAS em JSON válido:
{
  "reply": "mensagem a enviar ao lead (emojis permitidos se o proprietário pedir)",
  "next_stage": "SLOT_OFFER" | "NAME_COLLECT" | "BOOKING" | "CONFIRMED" | "ESCALATED",
  "lead_data_patch": { ...campos aprendidos neste turn... },
  "reasoning": "1 frase explicando sua decisão (não vai para o lead)"
}

Campos válidos em lead_data_patch:
- name (string): nome COMPLETO do responsável / lead (nome + sobrenome) — guarde sempre o nome inteiro informado, nunca só o primeiro nome (vai para a agenda e cadastro do paciente)
- custom_fields (object): campos extras { "child_name": "...", "child_birth_date": "...", "guardians": "..." }
- selected_slot_iso (string): ISO do slot escolhido (copie do offered_slots)
- dentist_person_id (number): copie do offered_slots correspondente (Clinicorp)
- commitment_confirmed (boolean): true quando o lead confirma compromisso
- patient_id (number): do retorno de buscar_paciente
- appointment_id (string|number): do retorno de criar_agendamento
- notes (string): RESUMO RICO do agendamento para quem vai atender. Reúna o que foi descoberto na conversa, uma informação por linha (2 a 4 linhas curtas), por exemplo: motivo/motivação do contato; situação atual (ex.: escola e série atuais da criança); turma/interesse identificado; preferências (turno, observações). NÃO escreva apenas uma frase genérica — capture os detalhes úteis do histórico. Preserve notes já existentes e acrescente o que faltar.

# DADOS DO NEGÓCIO

- Endereço: ${s.company_address || "(não informado)"}
- Horário de funcionamento: ${s.business_hours || "(não informado)"}
- Profissional / referência: ${s.doctor_name || s.contact_person_name || "(não informado)"}

${buildOwnerStylePromptBlock()}`;
}

function buildDynamicSystemPrompt(ctx: AgentContext): string {
  const TZ = "America/Sao_Paulo";
  const now = new Date();
  const dateStr = new Intl.DateTimeFormat("pt-BR", {
    timeZone: TZ,
    weekday: "long",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(now);

  const ld = ctx.leadData;
  const offeredSlotsText = (ld.offered_slots ?? [])
    .map((s) => `  • ${s.date_label} ${s.time_label} (iso=${s.iso}, dentist_person_id=${s.dentist_person_id ?? "?"})`)
    .join("\n");

  const channelCtx = { channel: ctx.channel, effectivePhone: ctx.effectivePhone };
  const bookingFields = getBookingFieldsForChannel(ctx.agentSettings, channelCtx);
  const phoneBlock = buildChannelPhonePromptBlock(ctx.channel, ctx.effectivePhone);

  // Bloco de agendas (multi-agenda). Lista os labels + quando usar cada uma,
  // e instrui o agente a passar o parâmetro `agenda` nas tools de agenda.
  const agendasBlock = isMultiAgenda(ctx)
    ? `\n# AGENDAS DISPONÍVEIS (Google Calendar)

Esta conta tem MAIS DE UMA agenda. Ao chamar **listar_horarios** e **criar_agendamento**, você DEVE preencher o parâmetro \`agenda\` com EXATAMENTE um destes labels, escolhido conforme a situação:
${ctx.googleAgendas
  .map(
    (a) =>
      `- "${a.label}": ${a.descricao || "(sem descrição — use seu julgamento pelo nome)"}` +
      (a.umaPorDia ? " [reserva o DIA inteiro — 1 por dia]" : ""),
  )
  .join("\n")}

Regras:
- Use a MESMA agenda para listar horários e para agendar (não misture).
- Se não tiver certeza de qual agenda, pergunte ao lead antes de listar horários.
- Cada agenda tem sua própria duração e horários liberados — você não precisa se preocupar com isso, a tool já aplica conforme a agenda escolhida.
${ld.selected_agenda ? `- Agenda já escolhida nesta conversa: "${ld.selected_agenda}". Mantenha-a, a menos que o lead peça para trocar.` : ""}
`
    : "";

  return `# ESTADO ATUAL

- Agora (BRT): ${dateStr}
- Stage corrente: ${ctx.stage}
- Telefone do lead: ${ctx.effectivePhone ?? "(sem telefone WhatsApp confirmado)"}
- Canal: ${ctx.channel}
${phoneBlock ? `\n${phoneBlock}\n` : ""}${ctx.helenaContact?.utm.content ? `- UTM Content: ${ctx.helenaContact.utm.content}` : ""}
${agendasBlock}
# LEAD_DATA ACUMULADO

${JSON.stringify(
  {
    name: ld.name ?? null,
    custom_fields: ld.custom_fields ?? null,
    interest: ld.interest ?? null,
    selected_slot_iso: ld.selected_slot_iso ?? null,
    dentist_person_id: ld.dentist_person_id ?? null,
    ...(isMultiAgenda(ctx) ? { selected_agenda: ld.selected_agenda ?? null } : {}),
    commitment_confirmed: ld.commitment_confirmed ?? false,
    patient_id: ld.patient_id ?? null,
    appointment_id: ld.appointment_id ?? null,
  },
  null,
  2,
)}

${(() => {
  const missing = getMissingBookingFields(bookingFields, ld);
  if (missing.length === 0) return "";
  const f = missing[0]!;
  const lastUser = [...ctx.history].reverse().find((m) => m.role === "user")?.content?.trim();
  const savePath =
    f.maps_to === "name" || f.key === "name"
      ? "lead_data_patch.name"
      : `lead_data_patch.custom_fields.${f.key}`;
  return `# PRÓXIMO CAMPO A COLETAR
Campo pendente: ${f.key} — pergunta sugerida: "${f.question}"
${lastUser ? `- Última mensagem do lead: "${lastUser.slice(0, 120)}"` : ""}
- Se essa mensagem já responde o campo, salve em ${savePath} e avance para o próximo campo (não repita a pergunta).
- Só faça a pergunta sugerida se o campo ainda estiver vazio após analisar a última mensagem do lead.`;
})()}

${offeredSlotsText ? `# SLOTS JÁ OFERECIDOS NESTE CICLO\n${offeredSlotsText}\n` : ""}${
    ld.selected_slot_iso
      ? `\n# HORÁRIO JÁ ESCOLHIDO PELO LEAD\nselected_slot_iso=${ld.selected_slot_iso}\nNÃO chame listar_horarios de novo. Confirme este horário ao lead e colete os campos pendentes.\n`
      : ""
  }`;
}

function hasBookingIntegration(ctx: AgentContext): boolean {
  return ctx.integrations.googleCalendar || ctx.integrations.clinicorp || ctx.integrations.clinup;
}

async function ensureOfferedSlots(ctx: AgentContext): Promise<{
  patch: Partial<LeadData>;
  toolResult?: string;
  toolsCalled: string[];
}> {
  if (ctx.stage !== "SLOT_OFFER" || ctx.dryRun) {
    return { patch: {}, toolsCalled: [] };
  }
  if (!hasBookingIntegration(ctx)) return { patch: {}, toolsCalled: [] };
  if ((ctx.leadData.offered_slots?.length ?? 0) > 0) {
    return { patch: {}, toolsCalled: [] };
  }
  // Multi-agenda: não dá pra auto-listar sem saber QUAL agenda. Deixa o LLM
  // chamar listar_horarios com o parâmetro `agenda` conforme as regras do prompt.
  if (isMultiAgenda(ctx)) {
    return { patch: {}, toolsCalled: [] };
  }

  console.log(`[scheduler] auto listar_horarios conv=${ctx.conversationId} (offered_slots vazio)`);
  const outcome = await execListarHorarios(ctx, 14);
  return {
    patch: outcome.patch ?? {},
    toolResult: outcome.result,
    toolsCalled: ["listar_horarios"],
  };
}

async function tryDeterministicBooking(ctx: AgentContext): Promise<{
  patch: Partial<LeadData>;
  toolResult?: string;
  toolsCalled: string[];
  telemetry?: Record<string, unknown>;
}> {
  if (ctx.leadData.appointment_id) return { patch: {}, toolsCalled: [] };
  if (!hasBookingIntegration(ctx)) return { patch: {}, toolsCalled: [] };
  if (ctx.stage !== "BOOKING" && ctx.stage !== "NAME_COLLECT") {
    return { patch: {}, toolsCalled: [] };
  }

  const slotPatch = tryAutoSelectOfferedSlot(ctx.stage, ctx.leadData, ctx.history);
  if (Object.keys(slotPatch).length > 0) {
    ctx.leadData = mergeLeadDataPatch(ctx.leadData, slotPatch);
  }

  // NÃO adiamos mais o criar_agendamento no turn de escolha de horário.
  // Assim que o lead escolhe o slot e os dados obrigatórios estão completos,
  // agendamos AQUI mesmo, de forma determinística (sem depender de outro turn
  // de LLM). O createClinicorpAppointment busca o paciente e, se não existir,
  // cria o cadastro antes de marcar. Se ainda faltar dado, o isReadyForBooking
  // abaixo retorna sem agendar e o agente pergunta o que falta no próximo turn.

  const ready = isReadyForBooking(ctx.leadData, ctx.agentSettings, {
    hasPhone: !!ctx.effectivePhone,
    hasBookingIntegration: hasBookingIntegration(ctx),
    channel: ctx.channel,
    effectivePhone: ctx.effectivePhone,
  });
  if (!ready) return { patch: slotPatch, toolsCalled: [] };

  // Preflight: ultima barreira antes de criar evento na agenda real.
  // Detecta lixo que escapou dos filtros anteriores (intent message gravada
  // como child_name etc) e ABORTA a criacao silenciosamente — o LLM no
  // proximo turn vai re-perguntar o campo limpo.
  const channelCtxForFields =
    ctx.channel != null
      ? { channel: ctx.channel, effectivePhone: ctx.effectivePhone ?? null }
      : undefined;
  const allFields = getBookingFieldsForChannel(ctx.agentSettings, channelCtxForFields);
  const preflight = preflightBookingFields(allFields, ctx.leadData);
  if (!preflight.ok) {
    console.warn(
      `[scheduler:telemetry] ${JSON.stringify({
        event: "false_booking_blocked_preflight",
        conv: ctx.conversationId,
        account: ctx.accountId,
        agent: ctx.agentId,
        stage: ctx.stage,
        model: ctx.model,
        issues: preflight.issues.map((i) => ({ key: i.key, reason: i.reason })),
        values_preview: preflight.issues.map((i) => i.value.slice(0, 80)),
      })}`,
    );
    const dirtyFields = allFields.filter((f) =>
      preflight.issues.some((i) => i.key === f.key),
    );
    const cleanedLead = clearBookingFields(ctx.leadData, dirtyFields);
    ctx.leadData = cleanedLead;
    return {
      patch: { ...slotPatch, ...cleanedLead },
      toolsCalled: [],
      telemetry: { preflight_blocked: true, dirty_fields: dirtyFields.map((f) => f.key) },
    };
  }

  console.log(
    `[scheduler] auto criar_agendamento conv=${ctx.conversationId} stage=${ctx.stage} slot=${ctx.leadData.selected_slot_iso}`,
  );
  const outcome = await execCriarAgendamento(ctx);
  let extraPatch: Partial<LeadData> = { ...slotPatch, ...(outcome.patch ?? {}) };
  let toolResult = outcome.result;
  const toolsCalled: string[] = ["criar_agendamento"];

  const failed =
    toolResult.includes('"ok":false') || toolResult.includes('"ok": false');
  if (failed && /INDISPON|indispon|conflit/i.test(toolResult)) {
    console.warn(
      `[scheduler] slot indisponível conv=${ctx.conversationId} — atualizando horários`,
    );
    delete ctx.leadData.selected_slot_iso;
    extraPatch = { ...extraPatch };
    delete extraPatch.selected_slot_iso;
    // Re-lista a MESMA agenda (multi-agenda) — selected_agenda persiste no conflito.
    const refresh = await execListarHorarios(ctx, 14, ctx.leadData.selected_agenda);
    toolsCalled.push("listar_horarios");
    extraPatch = mergeLeadDataPatch(extraPatch as LeadData, refresh.patch ?? {});
    toolResult += `\n\n# HORÁRIOS ATUALIZADOS (listar_horarios)\n${refresh.result}`;
  }

  return {
    patch: extraPatch,
    toolResult,
    toolsCalled,
  };
}

// ── Loop principal: tool use + structured output ──────────────────────────

const MAX_TOOL_LOOPS = 6;

export async function runSchedulerAgent(ctx: AgentContext): Promise<AgentResult> {
  // RAG com Gate: modelo barato decide se a msg precisa de busca.
  const lastUserMsg = [...ctx.history].reverse().find((m) => m.role === "user")?.content ?? "";
  let ragContext = "";
  if (lastUserMsg) {
    const gate = await decideRagNeed(ctx.orKey, ctx.ragGateModel, ctx.history, lastUserMsg);
    if (gate.need) {
      const ragChunks = await searchKnowledge(ctx.agentId, gate.query || lastUserMsg, 5);
      ragContext = formatChunksAsContext(ragChunks);
      console.log(
        `[scheduler] RAG: gate=true (${gate.reasoning ?? "ok"}) query="${(gate.query || lastUserMsg).slice(0, 60)}" → ${ragChunks.length} chunks`,
      );
    } else {
      console.log(`[scheduler] RAG: gate=false (${gate.reasoning ?? "skip"}) — busca evitada`);
    }
  }

  // Mídias disponíveis (para a tool enviar_midia)
  const mediaContext = await getAvailableMediaForPrompt(ctx.agentId);
  const extras = [ragContext, mediaContext].filter(Boolean).join("\n\n");

  const cached = buildCachedSystemPrompt(ctx);
  let baseDynamic = buildDynamicSystemPrompt(ctx);

  const slotListing = await ensureOfferedSlots(ctx);
  let accumulatedPatch: Partial<LeadData> = slotListing.patch;
  const toolsCalled: string[] = [...slotListing.toolsCalled];
  if (Object.keys(slotListing.patch).length > 0) {
    ctx.leadData = mergeLeadDataPatch(ctx.leadData, slotListing.patch);
    baseDynamic = buildDynamicSystemPrompt(ctx);
  }
  if (slotListing.toolResult) {
    baseDynamic += `\n\n# RESULTADO listar_horarios (automático)\n${slotListing.toolResult}\nUse os horários acima para oferecer ao lead.`;
  }

  const slotAuto = tryAutoSelectOfferedSlot(ctx.stage, ctx.leadData, ctx.history);
  if (Object.keys(slotAuto).length > 0) {
    accumulatedPatch = mergeLeadDataPatch(accumulatedPatch as LeadData, slotAuto);
    ctx.leadData = mergeLeadDataPatch(ctx.leadData, slotAuto);
    console.log(
      `[scheduler] auto-selecao slot conv=${ctx.conversationId} iso=${slotAuto.selected_slot_iso}`,
    );
    baseDynamic = buildDynamicSystemPrompt(ctx);
  }

  const autoBooking = await tryDeterministicBooking(ctx);
  accumulatedPatch = mergeLeadDataPatch(accumulatedPatch as LeadData, autoBooking.patch);
  toolsCalled.push(...autoBooking.toolsCalled);
  if (Object.keys(autoBooking.patch).length > 0) {
    ctx.leadData = mergeLeadDataPatch(ctx.leadData, autoBooking.patch);
    baseDynamic = buildDynamicSystemPrompt(ctx);
  }
  if (autoBooking.toolResult) {
    baseDynamic += `\n\n# RESULTADO criar_agendamento (automático)\n${autoBooking.toolResult}\n` +
      (ctx.leadData.appointment_id
        ? "Evento criado na agenda. Confirme ao lead e use next_stage=CONFIRMED."
        : "Falha ao criar evento. NÃO confirme agendamento — peça desculpas e ofereça outro horário.");
  }

  const dynamic = extras ? baseDynamic + "\n\n" + extras : baseDynamic;

  // Histórico convertido para LlmMessage.
  const history: LlmMessage[] = ctx.history.map((m) => ({ role: m.role, content: m.content }));

  let workingMessages: LlmMessage[] = [...history];
  let totalTokensIn = 0;
  let totalTokensOut = 0;
  let totalCostUsd = 0;
  // Telemetria: marca quando o LLM tentou criar agendamento DUPLICADO no mesmo
  // turn (apos o tryDeterministicBooking ja ter criado). O guard em
  // execCriarAgendamento retorna already_booked:true e a flag vai para
  // messages.meta para diagnostico.
  let doubleBookingBlocked = false;

  // Loop de tools: GPT-4.1 mini (toolModel) — Gemini costuma falhar em function calling.
  // Resposta final ao lead continua em ctx.model (Gemini Flash Lite).
  for (let loop = 0; loop < MAX_TOOL_LOOPS; loop++) {
    const turn = await callLlmWithFallback(ctx.orKey, {
      model: ctx.toolModel,
      systemCached: cached,
      systemDynamic: dynamic,
      messages: workingMessages,
      tools: buildSchedulerTools(ctx),
      toolChoice: "auto",
      maxTokens: ctx.maxTokens,
      temperature: Math.min(ctx.temperature, 0.4),
      enableCaching: false,
    }, ctx.toolFallbackModels);

    if (loop === 0) {
      console.log(
        `[scheduler] tool loop model=${turn.modelUsed} fallback=${turn.fallbackUsed} stage=${ctx.stage}`,
      );
    }

    totalTokensIn += turn.tokensIn;
    totalTokensOut += turn.tokensOut;
    totalCostUsd += turn.costUsd;

    if (turn.toolCalls.length === 0) {
      // LLM não chamou tool. Vai para o passo de structured output (próximo).
      break;
    }

    // Acumula tool calls no histórico de trabalho.
    workingMessages.push({
      role: "assistant",
      content: turn.content,
      tool_calls: turn.toolCalls,
    });

    for (const tc of turn.toolCalls) {
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(tc.function.arguments) as Record<string, unknown>;
      } catch {
        args = {};
      }

      let outcome: ToolOutcome;
      try {
        switch (tc.function.name) {
          case "buscar_paciente":
          case "buscar_paciente_clinicorp":
          case "buscar_paciente_clinup":
            outcome = await execBuscarPaciente(ctx);
            break;
          case "listar_horarios":
          case "listar_horarios_clinicorp":
          case "listar_horarios_google_calendar":
          case "listar_horarios_clinup":
          case "clinup_buscar_horarios":
            outcome = await execListarHorarios(
              ctx,
              args.dias_a_frente as number | undefined,
              typeof args.agenda === "string" ? args.agenda : undefined,
              typeof args.data_alvo === "string" ? args.data_alvo : undefined,
            );
            break;
          case "criar_agendamento":
          case "agendar_clinicorp":
          case "agendar_google_calendar":
          case "agendar_clinup":
            outcome = await execCriarAgendamento(
              ctx,
              typeof args.agenda === "string" ? args.agenda : undefined,
            );
            break;
          case "cancelar_agendamento":
          case "cancelar_clinicorp":
          case "cancelar_google_calendar":
            outcome = await execCancelarAgendamento(ctx);
            break;
          case "remarcar_agendamento":
          case "reagendar":
          case "reagendar_agendamento":
            outcome = await execCancelarAgendamento(ctx, { reoffer: true });
            break;
          case "enviar_midia": {
            const slug = typeof args.slug === "string" ? args.slug : "";
            const caption = typeof args.caption === "string" ? args.caption : undefined;
            const res = await sendMediaBySlug(ctx, slug, caption);
            outcome = {
              result: JSON.stringify(
                res.ok
                  ? { ok: true, media_title: res.media_title }
                  : { ok: false, error: res.error },
              ),
            };
            break;
          }
          default:
            outcome = { result: JSON.stringify({ error: "tool desconhecida" }) };
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        outcome = { result: JSON.stringify({ error: msg.slice(0, 200) }) };
      }

      toolsCalled.push(tc.function.name);
      if (outcome.patch) {
        accumulatedPatch = mergeLeadDataPatch(accumulatedPatch as LeadData, outcome.patch);
        ctx.leadData = mergeLeadDataPatch(ctx.leadData, outcome.patch);
      }
      if (
        (tc.function.name === "criar_agendamento" ||
          tc.function.name === "agendar_clinicorp" ||
          tc.function.name === "agendar_google_calendar" ||
          tc.function.name === "agendar_clinup") &&
        outcome.result.includes('"already_booked":true')
      ) {
        doubleBookingBlocked = true;
      }
      console.log(`[scheduler] tool ${tc.function.name} → ${outcome.result.slice(0, 200)}`);

      workingMessages.push({
        role: "tool",
        tool_call_id: tc.id,
        content: outcome.result,
      });
    }
  }

  // Resposta estruturada final: ctx.model (conversa / tom / JSON reply).
  const finalBaseDynamic = buildDynamicSystemPrompt(ctx); // reflete patches acumulados
  const finalDynamic = extras ? finalBaseDynamic + "\n\n" + extras : finalBaseDynamic;
  console.log(`[scheduler] reply JSON model=${ctx.model} stage=${ctx.stage}`);
  const { result, response: finalResponse } = await callLlmStructuredWithFallback<SchedulerJsonResult>(
    ctx.orKey,
    {
      model: ctx.model,
      systemCached: cached,
      systemDynamic: finalDynamic,
      messages: [
        ...workingMessages,
        {
          role: "user",
          content:
            "Com base no histórico e nas tools executadas, gere a resposta final em JSON conforme o schema instruído.",
        },
      ],
      maxTokens: ctx.maxTokens,
      temperature: ctx.temperature,
      enableCaching: ctx.model.startsWith("anthropic/"),
      toolChoice: "none",
    },
    (raw) => ResultSchema.parse(sanitizeStructuredAgentJson(raw)),
    ctx.fallbackModels,
  );

  totalTokensIn += finalResponse.tokensIn;
  totalTokensOut += finalResponse.tokensOut;
  totalCostUsd += finalResponse.costUsd;

  // Merge final do patch: o que o LLM declarou + o que veio de tools.
  const mergedPatch = mergeLeadDataPatch(
    accumulatedPatch as LeadData,
    stripNullishFields((result.lead_data_patch ?? {}) as Record<string, unknown>) as Partial<LeadData>,
  );

  // Fallback: se LLM omitiu next_stage, mantem o stage atual.
  const finalStage: Stage = (result.next_stage as Stage | undefined) ?? ctx.stage;

  let reply = result.reply;
  let outStage: Stage = finalStage;
  let outPatch = mergedPatch;
  const mergedTelemetry: Record<string, unknown> = { ...(autoBooking.telemetry ?? {}) };
  if (doubleBookingBlocked) mergedTelemetry.double_booking_blocked = true;

  // ── Agendamento no MESMO turn em que o último campo obrigatório chega ──────
  // Quando o lead manda o último dado (ex.: CPF) AGORA, o tryDeterministicBooking
  // do início do turn não o viu (só entra em lead_data_patch depois). Sem isto, o
  // agendamento só acontecia no turn seguinte (lead precisava mandar "ok").
  // Aqui mesclamos o patch recém-extraído e tentamos agendar de novo; se criar,
  // geramos a confirmação no mesmo turn.
  if (
    !ctx.leadData.appointment_id &&
    (ctx.stage === "NAME_COLLECT" || ctx.stage === "BOOKING")
  ) {
    ctx.leadData = mergeLeadDataPatch(ctx.leadData, outPatch);
    const lateBooking = await tryDeterministicBooking(ctx);
    if (lateBooking.toolsCalled.length > 0) {
      toolsCalled.push(...lateBooking.toolsCalled);
      outPatch = mergeLeadDataPatch(outPatch as LeadData, lateBooking.patch);
      ctx.leadData = mergeLeadDataPatch(ctx.leadData, lateBooking.patch);
      Object.assign(mergedTelemetry, lateBooking.telemetry ?? {}, {
        same_turn_late_booking: !!ctx.leadData.appointment_id,
      });
    }

    if (ctx.leadData.appointment_id) {
      // Agendou agora → regenera a resposta como CONFIRMAÇÃO no mesmo turn.
      const confirmBase =
        buildDynamicSystemPrompt(ctx) +
        `\n\n# RESULTADO criar_agendamento (automático)\n${lateBooking.toolResult ?? '{"ok":true}'}\n` +
        "Evento criado na agenda. Confirme ao lead de forma calorosa e use next_stage=CONFIRMED.";
      const confirmDynamic = extras ? confirmBase + "\n\n" + extras : confirmBase;
      console.log(
        `[scheduler] late booking ok conv=${ctx.conversationId} — confirmando no mesmo turn`,
      );
      const { result: cRes, response: cResp } =
        await callLlmStructuredWithFallback<SchedulerJsonResult>(
          ctx.orKey,
          {
            model: ctx.model,
            systemCached: cached,
            systemDynamic: confirmDynamic,
            messages: [
              ...workingMessages,
              {
                role: "user",
                content:
                  "O agendamento acabou de ser criado com sucesso na agenda. Gere a confirmação final ao lead em JSON conforme o schema (next_stage=CONFIRMED).",
              },
            ],
            maxTokens: ctx.maxTokens,
            temperature: ctx.temperature,
            enableCaching: ctx.model.startsWith("anthropic/"),
            toolChoice: "none",
          },
          (raw) => ResultSchema.parse(sanitizeStructuredAgentJson(raw)),
          ctx.fallbackModels,
        );
      totalTokensIn += cResp.tokensIn;
      totalTokensOut += cResp.tokensOut;
      totalCostUsd += cResp.costUsd;
      reply = cRes.reply;
      outStage = (cRes.next_stage as Stage | undefined) ?? "CONFIRMED";
      outPatch = mergeLeadDataPatch(
        outPatch as LeadData,
        stripNullishFields(
          (cRes.lead_data_patch ?? {}) as Record<string, unknown>,
        ) as Partial<LeadData>,
      );
    }
  }

  return {
    reply,
    next_stage: outStage,
    lead_data_patch: outPatch,
    reasoning: result.reasoning,
    tools_called: toolsCalled,
    tokens_in: totalTokensIn,
    tokens_out: totalTokensOut,
    cost_usd: totalCostUsd,
    telemetry: Object.keys(mergedTelemetry).length > 0 ? mergedTelemetry : undefined,
  };
}
