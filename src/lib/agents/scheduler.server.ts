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
import {
  listClinicExpertsSlots,
  createClinicExpertsAppointment,
  cancelClinicExpertsAppointment,
  findClinicExpertsPatient,
  type ClinicExpertsSlot,
} from "@/lib/tools/clinic-experts.server";
import { loadHelenaAccount, removeContactFromAllSequences } from "@/lib/helena.server";
import { summarizeConversationForNotification } from "@/lib/agents/notify-booking.server";
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
import { stripLlmForbiddenFields } from "./lead-patch-guard";
import {
  classifyBookingError,
  parseBookingFailure,
  isGuardHoldFailure,
  isValidationOnlyFailure,
  pruneOfferedSlot,
  buildConflictReply,
  TECH_RETRY_REPLY,
  TECH_ESCALATE_REPLY,
  TECH_ESCALATION_REASON,
  MAX_BOOKING_TECH_RETRIES,
  type BookingFailureKind,
} from "./booking-failure";
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
  looksLikeDecline,
  mergeLeadDataPatch,
  preflightBookingFields,
  resolveBookingLeadName,
  clearRejectedBookingName,
  tryAutoSelectOfferedSlot,
  slotsOfferedInLastTurn,
  patchFromSlot,
  mentionsUnavailability,
  leadRequestedUnofferedDate,
  requestedDateFromText,
  requestedPeriodoFromText,
  requestedHoraFromText,
  rankSlotsByRequestedHour,
  minutesOfDayFromLabel,
  affirmedDatesFromAssistant,
  ddmmInBrt,
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
  if (ctx.dryRun || ctx.disableTags) {
    // Causa nº1 de "a etiqueta não mudou para IA AGENDOU": em MODO TESTE
    // (settings.test_mode) a visita É agendada, mas a escrita de tags fica
    // desligada de propósito. Logamos para não parecer bug silencioso.
    console.log(
      `[scheduler] tag swap pós-agendamento PULADO (${ctx.dryRun ? "dry_run" : "test_mode"}) conv=${ctx.conversationId}`,
    );
    return;
  }
  if (!ctx.helenaContact?.id) {
    console.warn(
      `[scheduler] tag swap pós-agendamento PULADO — contato Helena não resolvido conv=${ctx.conversationId}`,
    );
    return;
  }
  if (ctx.leadData.booked_tag_applied) return; // idempotente
  try {
    const helena = await loadHelenaAccount(ctx.accountId);
    const res = await swapTagBySynonyms(
      helena,
      ctx.helenaContact.id,
      NOT_SCHEDULED_SYNONYMS,
      SCHEDULED_SYNONYMS,
      { currentTags: ctx.helenaContact.tagNames },
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

/**
 * Lead agendado sai de QUALQUER sequência (cadência) do CRM — requisito de
 * negócio: não pode receber follow-up de cadência depois de agendar. Roda em
 * todo agendamento bem-sucedido (qualquer agente). Best-effort; só é pulado em
 * dryRun (trainer/replay). NÃO pula em test_mode (queremos validar de verdade).
 */
async function removeLeadFromSequences(ctx: AgentContext): Promise<void> {
  if (ctx.dryRun) return;
  const contactId = ctx.helenaContact?.id ?? null;
  const phoneNumber = ctx.effectivePhone ?? null;
  if (!contactId && !phoneNumber) return;
  try {
    const helena = await loadHelenaAccount(ctx.accountId);
    const res = await removeContactFromAllSequences(helena, { contactId, phoneNumber });
    console.log(
      `[scheduler] lead removido de sequências: ${res.removed}/${res.attempted} conv=${ctx.conversationId}`,
    );
  } catch (e) {
    console.warn("[scheduler] erro ao remover lead de sequências:", e);
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
      retomar_em: z.string().nullish(),
      retorno_motivo: z.string().nullish(),
      custom_fields: coercibleStringRecord.nullish(),
    })
    // .nullish(): alguns modelos devolvem lead_data_patch:null (em vez de omitir)
    // — sem isto o turn inteiro quebrava na validação Zod.
    .nullish(),
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
        "Procura paciente no Clinicorp/Clinic Experts pelo telefone do lead (já fixo no contexto). " +
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
        "Lista horários disponíveis na agenda (Clinicorp, Clinic Experts OU Google Calendar, conforme integração ativa da conta). " +
        "Use quando precisar oferecer slots ao lead (stage SLOT_OFFER). " +
        "Retorna no máximo 6 horários alinhados à duração configurada. " +
        "IMPORTANTE: se o lead pedir uma DATA específica (ex: '25 de julho', '20/07', 'dia 3'), passe-a em `data_alvo` (formato YYYY-MM-DD) para a busca começar nessa data — caso contrário a busca olha só os próximos dias e NÃO vai alcançar datas distantes. " +
        "Aliases reconhecidos (caso o prompt mencione): listar_horarios_clinicorp, listar_horarios_google_calendar, listar_horarios_clinup, listar_horarios_clinic_experts.",
      parameters: {
        type: "object",
        properties: {
          data_alvo: {
            type: "string",
            description:
              "Data específica pedida pelo lead PARA A CONSULTA, no formato YYYY-MM-DD (ex: '2026-07-25'). A busca começa nessa data. Omita se o lead não citou uma data. " +
              "NÃO use a data em que o lead VOLTA de viagem / fica disponível ('volto dia 07', 'chego dia 10', 'estou de férias até X') — essa é o PRIMEIRO dia possível, não a data desejada; ofereça a partir do dia SEGUINTE à volta, nunca o próprio dia da volta. Se o lead disser a data desejada depois ('quero dia 11'), use essa.",
          },
          dias_a_frente: {
            type: "integer",
            description:
              "Tamanho da janela de busca em dias a partir do início. Omita para o padrão (próximos 3 dias — a busca já oferece os horários MAIS PRÓXIMOS e amplia sozinha se não houver vaga). Só informe um valor se quiser forçar uma janela específica.",
          },
          periodo: {
            type: "string",
            enum: ["manha", "tarde", "noite"],
            description:
              "Turno do dia pedido pelo lead: 'manha' (antes do meio-dia), 'tarde' (12:00–18:00) ou 'noite' (a partir das 18:00). SEMPRE informe quando o lead disser um período (ex: 'de tarde', 'pela manhã', 'à noite'). Sem isso, a busca traz só os horários mais cedo e pode responder que a tarde não tem vaga mesmo quando tem.",
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
        "Cria o agendamento na agenda integrada (Google Calendar, Clinicorp, Clinup ou Clinic Experts). " +
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
        "(Clinicorp/Google Calendar/Clinic Experts). Use quando o lead pedir explicitamente para CANCELAR e NÃO quiser " +
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

  // Clinic Experts
  if (ctx.integrations.clinicExperts) {
    try {
      const patient = await findClinicExpertsPatient(ctx.accountId, ctx.effectivePhone);
      if (!patient?.uuid) {
        return { result: JSON.stringify({ found: false }) };
      }
      return {
        result: JSON.stringify({ found: true, patient_id: patient.uuid, name: patient.name }),
        patch: {
          patient_uuid: patient.uuid,
          ...(ctx.leadData.name ? {} : { name: patient.name }),
        },
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { result: JSON.stringify({ found: false, error: msg.slice(0, 200) }) };
    }
  }

  // Default: Clinicorp. Passa o nome coletado (se houver) para a dedup por
  // nome+telefone — a busca só por telefone não acha cadastros criados pelo
  // agente (ver findClinicorpPatient).
  const patient = await findClinicorpPatient(
    ctx.accountId,
    ctx.effectivePhone,
    ctx.leadData.name ?? undefined,
  );
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

/** Fallback determinístico do resumo do caso (sem LLM): usa o que já foi
 *  coletado na qualificação (queixa/motivo em `notes` + `interest`). */
function buildClinicorpCaseNotesFallback(ld: LeadData): string {
  const segs: string[] = [];
  const notes = (ld.notes ?? "").trim();
  if (notes) segs.push(notes);
  const interest = (ld.interest ?? "").trim();
  if (interest && !notes.toLowerCase().includes(interest.toLowerCase())) {
    segs.push(`Interesse: ${interest}`);
  }
  let s = segs.join(" — ").replace(/\s*\n+\s*/g, "; ").replace(/\s{2,}/g, " ").trim();
  if (s.length > 150) s = s.slice(0, 149).trimEnd() + "…";
  return s;
}

/** Resumo do caso (≤150 chars) gerado por IA a partir da conversa, para o campo
 *  Notes do Clinicorp. Best-effort: se a IA falhar/voltar vazia, cai no resumo
 *  determinístico montado dos dados coletados. */
async function buildClinicorpCaseNotes(ctx: AgentContext): Promise<string> {
  const fallback = () => buildClinicorpCaseNotesFallback(ctx.leadData);
  if (!ctx.orKey || !ctx.history?.length) return fallback();
  try {
    const summary = await summarizeConversationForNotification(
      ctx.orKey,
      ctx.ragGateModel,
      ctx.history,
      "Resuma o caso do paciente em UMA frase de no máximo 150 caracteres, para a equipe da clínica ler na agenda. Foque no motivo/queixa e no procedimento de interesse. Sem saudações, sem nome próprio, sem telefone, sem links.",
    );
    const s = (summary ?? "").trim();
    return s ? s.slice(0, 150) : fallback();
  } catch {
    return fallback();
  }
}

function formatSlot(s: ClinicorpSlot): {
  iso: string;
  end_iso: string;
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
    // Fim REAL do slot conforme a grade da agenda (ex.: 14:30). Usado no
    // create para não estourar a grade com a duração padrão (ex.: 40 min).
    end_iso: s.end,
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

function formatCeSlot(s: ClinicExpertsSlot): {
  iso: string;
  end_iso: string;
  date_label: string;
  time_label: string;
  professional_uuid: string;
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
    end_iso: s.end,
    date_label,
    time_label: s.fromTime,
    professional_uuid: s.professionalUuid,
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

/**
 * Última data explicitamente pedida pelo lead nas mensagens recentes — dia da
 * semana ("quinta") ou relativa ("amanhã"). Varre da mais recente pra trás e
 * devolve a PRIMEIRA encontrada (auto-corrige se o lead mudou de dia depois).
 * Usado como fallback do `data_alvo` quando o LLM esquece de passá-lo ao chamar
 * listar_horarios — sem isso a busca começa em "hoje" e oferta um dia DIFERENTE
 * do pedido. Caso real (MF Beauty BSB, Sônia (61) 98679-1009): lead pediu
 * quinta 16/07, o LLM chamou listar_horarios sem data_alvo, veio segunda 13/07,
 * e o "11h" da lead casou o slot de segunda — agendou no dia ERRADO (e num
 * profissional que nem atende quinta).
 */
function requestedDateFromHistory(
  history: { role: "user" | "assistant"; content: string }[],
): string | null {
  const userMsgs = history.filter((m) => m.role === "user");
  for (let i = userMsgs.length - 1; i >= 0; i--) {
    const d = requestedDateFromText(userMsgs[i]!.content);
    if (d) return d;
  }
  return null;
}

/**
 * Último turno (manhã/tarde/noite) pedido pelo lead nas mensagens recentes.
 * Fallback do `periodo` quando o LLM esquece de passá-lo ao chamar
 * listar_horarios — sem isso a busca não filtra por turno e o corte das 6 vagas
 * mais próximas pode devolver só um turno (ex.: só tarde) mesmo o lead pedindo
 * manhã. Caso real (Costa Lima Madureira, 21 99150-4698): lead pediu "de manhã",
 * o LLM chamou listar_horarios sem periodo → só veio tarde.
 */
function requestedPeriodoFromHistory(
  history: { role: "user" | "assistant"; content: string }[],
): "manha" | "tarde" | "noite" | null {
  const userMsgs = history.filter((m) => m.role === "user");
  for (let i = userMsgs.length - 1; i >= 0; i--) {
    const p = requestedPeriodoFromText(userMsgs[i]!.content);
    if (p) return p;
  }
  return null;
}

/**
 * Hora exata (ex.: 16) que o lead pediu numa mensagem recente, ou null.
 * Fallback do corte de 6 vagas: sem isso, dentro do turno filtrado o corte
 * pega sempre as 6 mais cedo e nunca alcança um horário pedido mais tarde no
 * mesmo turno (ver requestedHoraFromText).
 */
function requestedHoraFromHistory(
  history: { role: "user" | "assistant"; content: string }[],
): number | null {
  const userMsgs = history.filter((m) => m.role === "user");
  for (let i = userMsgs.length - 1; i >= 0; i--) {
    const h = requestedHoraFromText(userMsgs[i]!.content);
    if (h != null) return h;
  }
  return null;
}

// Janela padrão do slot offer: prioriza SEMPRE os horários mais próximos —
// hoje + os próximos 3 dias. Se não houver vaga nesse período, a busca amplia
// automaticamente até SLOT_WIDE_WINDOW_DAYS para achar as próximas datas livres.
const SLOT_NEAR_WINDOW_DAYS = 4; // hoje + 3 dias
const SLOT_WIDE_WINDOW_DAYS = 60;

/** Faixa de horas (hora local BRT) de um turno pedido pelo lead. Fronteiras
 *  alinhadas ao pickSlotByPreference: manhã <12, tarde 12–18, noite ≥18. */
function periodoParaHoras(periodo?: string): { min: number; max: number } | null {
  const p = (periodo ?? "")
    .toLowerCase()
    .trim()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, ""); // remove acentos (manhã → manha)
  switch (p) {
    case "manha":
      return { min: 0, max: 12 };
    case "tarde":
      return { min: 12, max: 18 };
    case "noite":
      return { min: 18, max: 24 };
    default:
      return null;
  }
}

async function execListarHorarios(
  ctx: AgentContext,
  diasAFrente?: number,
  agendaLabel?: string,
  dataAlvo?: string,
  periodo?: string,
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
  // a busca começa nela; senão começa agora. Quando o LLM não passa data_alvo
  // mas o lead pediu um dia específico numa mensagem recente ("quinta"), usa
  // esse dia como âncora — senão a busca começa em "hoje" e oferta um dia
  // DIFERENTE do pedido (ver requestedDateFromHistory).
  // Só ancora pelo histórico em chamada "simples" (LLM não passou data_alvo NEM
  // dias_a_frente). Com dias_a_frente explícito o LLM está fazendo uma busca
  // ampla de propósito (ex.: achar alternativas) — respeita isso.
  const resolvedDataAlvo =
    dataAlvo ??
    (diasAFrente == null ? requestedDateFromHistory(ctx.history) : null) ??
    undefined;
  if (!dataAlvo && resolvedDataAlvo) {
    console.log(
      `[scheduler] listar_horarios conv=${ctx.conversationId}: data_alvo ausente do LLM — ancorando no dia pedido pelo lead (${resolvedDataAlvo})`,
    );
  }
  const anchor = parseDataAlvoBrt(resolvedDataAlvo);
  const today = anchor && anchor.getTime() > now.getTime() ? anchor : now;
  const end = new Date(
    today.getTime() + (diasAFrente ?? SLOT_NEAR_WINDOW_DAYS) * 24 * 60 * 60 * 1000,
  );

  // Fallback do TURNO: quando o LLM não passa `periodo` mas o lead pediu um
  // turno numa mensagem recente ("de manhã"), filtra por ele — senão o corte
  // das 6 vagas mais próximas pode trazer só um turno e o agente diz "não tem
  // de manhã" com a manhã livre (ver requestedPeriodoFromHistory).
  const resolvedPeriodo = periodo ?? requestedPeriodoFromHistory(ctx.history) ?? undefined;
  if (!periodo && resolvedPeriodo) {
    console.log(
      `[scheduler] listar_horarios conv=${ctx.conversationId}: periodo ausente do LLM — usando o turno pedido pelo lead (${resolvedPeriodo})`,
    );
  }
  // Hora exata pedida pelo lead ("16h", "às 16 horas"): usada para priorizar,
  // dentro do turno, os horários mais próximos dela antes do corte de 6 — ver
  // requestedHoraFromHistory.
  const resolvedHora = requestedHoraFromHistory(ctx.history);

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
    const fetchFormatted = async (periodoFimDate: Date) => {
      const slots = await listGoogleCalendarSlots(
        ctx.accountId,
        {
          periodoInicio: today.toISOString(),
          periodoFim: periodoFimDate.toISOString(),
          tamanhoJanelaMinutos: duracao,
          granularidade: resolved.granularidadeMinutos ?? duracao,
          amostras: 6,
          businessHoursJson,
          // Turno pedido (manhã/tarde/noite): filtra ANTES do corte de 6 para a
          // tarde não cair fora quando a manhã tem vagas. Festas ("uma por dia")
          // não têm turno — não aplica.
          periodoHoras: resolved.umaPorDia ? undefined : periodoParaHoras(resolvedPeriodo) ?? undefined,
          // Hora exata pedida ("perto das 16h"): prioriza os horários próximos
          // dela antes do corte de 6. Festas ("uma por dia") não têm hora pedida.
          horaPreferida: resolved.umaPorDia ? undefined : resolvedHora ?? undefined,
          umaPorDia: resolved.umaPorDia,
          umaPorDiaDias: resolved.diasUmaPorDia,
          bufferMinutos: resolved.bufferMinutos,
          bufferDias: resolved.bufferDias,
        },
        resolved.calendarId,
      );
      return slots.map(formatGCalSlot);
    };

    let formatted = await fetchFormatted(gcalEnd);
    // Sem vaga na janela próxima (hoje + 3 dias)? Amplia a busca automaticamente
    // para achar as PRÓXIMAS datas livres — sem depender de o lead pedir uma
    // data específica. Não se aplica ao modo "uma por dia" (festas, que já usa
    // janela ampla) nem quando o lead pediu uma data (anchor) ou um período
    // explícito (diasAFrente).
    if (formatted.length === 0 && !anchor && !resolved.umaPorDia && diasAFrente == null) {
      const wideEnd = new Date(
        today.getTime() + SLOT_WIDE_WINDOW_DAYS * 24 * 60 * 60 * 1000,
      );
      console.log(
        `[scheduler] listar_horarios conv=${ctx.conversationId}: 0 vaga(s) em ${SLOT_NEAR_WINDOW_DAYS}d — ampliando busca p/ ${SLOT_WIDE_WINDOW_DAYS}d`,
      );
      formatted = await fetchFormatted(wideEnd);
    }
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
          dias_consultados: diasAFrente ?? SLOT_WIDE_WINDOW_DAYS,
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

    // Data pedida (data_alvo) sem vaga, mas há vaga em datas POSTERIORES:
    // avisa explicitamente para o agente NÃO afirmar a data pedida (o modelo
    // tende a ecoar "dia 7" mesmo quando os slots são de 13/07).
    const anchorKey = anchor
      ? new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(anchor)
      : null;
    const requestedDateUnavailable =
      !!anchorKey && !formatted.some((s) => (s.iso ?? "").slice(0, 10) === anchorKey);
    return {
      result: JSON.stringify({
        count: formatted.length,
        slots: formatted,
        ...(resolved.agendaLabel ? { agenda: resolved.agendaLabel } : {}),
        ...(requestedDateUnavailable
          ? {
              aviso_data: `SEM VAGA em ${anchorKey}. Os horários abaixo são de OUTRAS datas (as próximas disponíveis). Diga ao lead que ${anchorKey} não tem vaga e ofereça ESTAS datas — NUNCA afirme/confirme a data pedida (${anchorKey}).`,
            }
          : {}),
      }),
      patch: { offered_slots: formatted, ...agendaPatch },
    };
  }

  // Clinic Experts — o expediente por profissional já é aplicado dentro de
  // listClinicExpertsSlots (pula dias sem bloco ativo, filtra horas fora da
  // janela configurada); aqui só cuidamos da janela de busca (auto-ampliação)
  // e do filtro de turno, igual ao Clinicorp abaixo.
  if (ctx.integrations.clinicExperts) {
    const fmtCe = (d: Date) =>
      new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(d);

    let ceSlots = await listClinicExpertsSlots(ctx.accountId, fmtCe(today), fmtCe(end));
    if (ceSlots.length === 0 && !anchor && diasAFrente == null) {
      const wideEnd = new Date(today.getTime() + SLOT_WIDE_WINDOW_DAYS * 24 * 60 * 60 * 1000);
      console.log(
        `[scheduler] listar_horarios (clinic experts) conv=${ctx.conversationId}: 0 vaga(s) em ${SLOT_NEAR_WINDOW_DAYS}d — ampliando p/ ${SLOT_WIDE_WINDOW_DAYS}d`,
      );
      ceSlots = await listClinicExpertsSlots(ctx.accountId, fmtCe(today), fmtCe(wideEnd));
    }
    const ceBounds = periodoParaHoras(resolvedPeriodo);
    let cePeriodoAviso: string | undefined;
    if (ceBounds) {
      const noPeriodo = ceSlots.filter((s) => {
        const h = Number(s.fromTime.slice(0, 2));
        return Number.isFinite(h) && h >= ceBounds.min && h < ceBounds.max;
      });
      if (noPeriodo.length > 0) {
        ceSlots = noPeriodo;
      } else if (ceSlots.length > 0) {
        cePeriodoAviso = `Sem vaga no turno pedido (${resolvedPeriodo}). Os horários abaixo são de OUTRO turno — diga ao lead que o turno pedido não tem vaga e ofereça estes.`;
      }
    }
    // Prioriza a hora pedida ANTES do corte de 6 (senão o slice pega sempre as
    // vagas mais cedo do turno e "prefiro perto das 16h" nunca é alcançado),
    // reordenando cronologicamente só na saída — igual ao Clinicorp.
    const ceLimited = rankSlotsByRequestedHour(ceSlots, resolvedHora, (s) =>
      minutesOfDayFromLabel(s.fromTime),
    )
      .slice(0, 6)
      .sort((a, b) => a.start.localeCompare(b.start))
      .map(formatCeSlot);
    if (ceLimited.length === 0) {
      const noProfessionals = ctx.clinicExpertsProfessionals.length === 0;
      const causa = noProfessionals
        ? "Nenhum profissional está configurado no Clinic Experts desta conta (painel de Integrações → Clinic Experts). Não é possível buscar horários até um profissional com expediente ser cadastrado — não prometa horário ao lead; ofereça escalar para um humano."
        : "Nenhum horário livre encontrado no período consultado para os profissionais/expediente configurados. Tente um período maior ou verifique se o expediente cadastrado está correto.";
      console.warn(
        `[scheduler] listar_horarios (clinic experts) retornou 0 slots conv=${ctx.conversationId} — ${noProfessionals ? "0 profissionais configurados" : "verifique profissionais/expediente configurados"}`,
      );
      return {
        result: JSON.stringify({
          count: 0,
          slots: [],
          debug: {
            profissionais_configurados: ctx.clinicExpertsProfessionals.length,
            possivel_causa: causa,
          },
        }),
        patch: { offered_slots: [] },
      };
    }
    const ceAnchorKey = anchor
      ? new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(anchor)
      : null;
    const ceRequestedDateUnavailable =
      !!ceAnchorKey && !ceLimited.some((s) => (s.iso ?? "").slice(0, 10) === ceAnchorKey);
    return {
      result: JSON.stringify({
        count: ceLimited.length,
        slots: ceLimited,
        ...(cePeriodoAviso ? { aviso_periodo: cePeriodoAviso } : {}),
        ...(ceRequestedDateUnavailable
          ? {
              aviso_data: `SEM VAGA em ${ceAnchorKey}. Os horários abaixo são de OUTRAS datas (as próximas disponíveis). Diga ao lead que ${ceAnchorKey} não tem vaga e ofereça ESTAS datas — NUNCA afirme/confirme a data pedida (${ceAnchorKey}).`,
            }
          : {}),
      }),
      patch: { offered_slots: ceLimited },
    };
  }

  // Default: Clinicorp
  const fmt = (d: Date) =>
    new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(d);

  const bounds = periodoParaHoras(resolvedPeriodo);
  const inPeriodo = (arr: ClinicorpSlot[]) =>
    bounds
      ? arr.filter((s) => {
          const h = Number(s.fromTime.slice(0, 2));
          return Number.isFinite(h) && h >= bounds.min && h < bounds.max;
        })
      : arr;

  let slots = await listClinicorpSlots(ctx.accountId, fmt(today), fmt(end));
  // Amplia a busca para a janela ampla (até 60 dias) quando: (a) NÃO há vaga
  // nenhuma na janela próxima, OU (b) o lead pediu um TURNO e não há vaga NESSE
  // turno na janela próxima. Assim "de tarde" VARRE vários dias até achar uma
  // tarde livre — em vez de devolver manhã ou vazio. Combinado com o cross-check
  // (só horários REALMENTE livres), o agente para de ofertar horário ocupado e
  // sempre alcança as próximas vagas de verdade. Só em busca "simples" (o LLM
  // não fixou data nem dias_a_frente).
  const canExpand = !anchor && diasAFrente == null;
  if (canExpand && (slots.length === 0 || (!!bounds && inPeriodo(slots).length === 0))) {
    const wideEnd = new Date(today.getTime() + SLOT_WIDE_WINDOW_DAYS * 24 * 60 * 60 * 1000);
    console.log(
      `[scheduler] listar_horarios (clinicorp) conv=${ctx.conversationId}: sem vaga${bounds ? ` no turno (${resolvedPeriodo})` : ""} em ${SLOT_NEAR_WINDOW_DAYS}d — ampliando p/ ${SLOT_WIDE_WINDOW_DAYS}d`,
    );
    slots = await listClinicorpSlots(ctx.accountId, fmt(today), fmt(wideEnd));
  }
  // Filtro de TURNO ANTES do corte de 6 (senão o slice pegava só os mais cedo).
  let periodoAviso: string | undefined;
  if (bounds) {
    const noPeriodo = inPeriodo(slots);
    if (noPeriodo.length > 0) {
      slots = noPeriodo;
    } else if (slots.length > 0) {
      // Nem na janela ampla há vaga NESSE turno, mas há em outro: não esconde os
      // reais — avisa o LLM para ser honesto ("à tarde não tenho, mas tenho...").
      periodoAviso = `Sem vaga no turno pedido (${resolvedPeriodo}) nos próximos ${SLOT_WIDE_WINDOW_DAYS} dias. Os horários abaixo são de OUTRO turno — diga ao lead que o turno pedido não tem vaga e ofereça estes.`;
    }
  }
  // Limita a 6. Se o lead pediu uma hora exata ("16h"), prioriza os mais
  // PRÓXIMOS dela antes do corte — senão o corte pega sempre os 6 mais cedo
  // do turno (ex: 12:00-14:30) e nunca alcança um horário pedido mais tarde
  // no mesmo turno (ex: 16:00), mesmo com esse horário livre.
  const ranked = rankSlotsByRequestedHour(slots, resolvedHora, (s) =>
    minutesOfDayFromLabel(s.fromTime),
  );
  const limited = ranked
    .slice(0, 6)
    .sort((a, b) => a.start.localeCompare(b.start))
    .map(formatSlot);
  // Data pedida (anchor) sem vaga, mas há vaga em OUTRAS datas: avisa o modelo
  // para NÃO afirmar/confirmar a data pedida — senão ele tende a ecoar o dia
  // pedido mesmo com os slots sendo de outro dia (mesma proteção do Google
  // Calendar acima). Sem isto, o modelo relabela os slots reais e o lead recebe
  // uma data que não corresponde ao horário realmente reservado.
  const anchorKey = anchor
    ? new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(anchor)
    : null;
  const requestedDateUnavailable =
    !!anchorKey && !limited.some((s) => (s.iso ?? "").slice(0, 10) === anchorKey);
  return {
    result: JSON.stringify({
      count: limited.length,
      slots: limited,
      ...(periodoAviso ? { aviso_periodo: periodoAviso } : {}),
      ...(requestedDateUnavailable
        ? {
            aviso_data: `SEM VAGA em ${anchorKey}. Os horários abaixo são de OUTRAS datas (as próximas disponíveis). Diga ao lead que ${anchorKey} não tem vaga e ofereça ESTAS datas — NUNCA afirme/confirme a data pedida (${anchorKey}).`,
          }
        : {}),
    }),
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

const NAME_VALIDATION_SCHEMA = z.object({
  eh_nome: z.boolean(),
  motivo: z.string().nullish(),
});

/**
 * Valida SEMANTICAMENTE, via LLM, se o texto é o NOME PRÓPRIO de uma pessoa
 * real (adequado para cadastro na clínica) — em vez de regras fixas. Rejeita
 * agradecimento ("obrigado", "Deus abençoe"), recusa ("não obrigado"),
 * saudação, pergunta, preferência de horário ("quinta à tarde"), apelido
 * genérico, emoji ou frase/texto aleatório. É a barreira final antes de criar
 * o agendamento — nenhum evento é criado sem o nome ser confirmado como real.
 *
 * Fail-open: se o validador (infra LLM) falhar, NÃO bloqueia o agendamento
 * (evita travar um lead legítimo por indisponibilidade momentânea do modelo).
 */
async function validatePatientNameLLM(
  ctx: AgentContext,
  name: string,
): Promise<{ valid: boolean; reason: string }> {
  const candidate = (name ?? "").trim();
  if (!candidate) return { valid: false, reason: "vazio" };

  try {
    const { result } = await callLlmStructuredWithFallback<z.infer<typeof NAME_VALIDATION_SCHEMA>>(
      ctx.orKey,
      {
        model: ctx.toolModel,
        systemCached:
          "Você verifica se um texto é o NOME PRÓPRIO de uma pessoa real, para cadastro de paciente numa clínica. Responda SEMPRE em JSON.",
        systemDynamic: "",
        messages: [
          {
            role: "user",
            content:
              `Texto recebido no campo "nome do paciente": "${candidate}"\n\n` +
              `É um nome próprio de pessoa (idealmente nome + sobrenome)?\n` +
              `Responda { "eh_nome": true|false, "motivo": "curto" }.\n` +
              `eh_nome=false para: agradecimento ("obrigado", "Deus abençoe", "amém"), recusa ("não", "não obrigado"), saudação, pergunta, preferência de horário ("quinta à tarde", "amanhã"), apelido genérico/isolado, emoji, ou frase/texto que claramente não é nome.\n` +
              `eh_nome=true para nomes reais de pessoa, mesmo com só o primeiro nome se parecer nome próprio.`,
          },
        ],
        maxTokens: 120,
        temperature: 0,
        toolChoice: "none",
      },
      (raw) => NAME_VALIDATION_SCHEMA.parse(raw),
      ctx.toolFallbackModels,
    );
    return { valid: !!result.eh_nome, reason: result.motivo ?? "" };
  } catch (e) {
    console.warn(
      `[scheduler] validador de nome indisponível (fail-open) conv=${ctx.conversationId}: ${e instanceof Error ? e.message : e}`,
    );
    return { valid: true, reason: "validador_indisponivel" };
  }
}

// ── Portão de intenção de agendamento ──────────────────────────────────────

const BOOKING_INTENT_SCHEMA = z.object({
  agendar: z.boolean(),
  motivo: z.string().nullish(),
});

/** Rótulo humano (dia da semana + DD/MM + HH:MM, BRT) de um ISO. */
function slotHumanLabel(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat("pt-BR", {
    timeZone: "America/Sao_Paulo",
    weekday: "long",
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(d);
}

/**
 * BARREIRA FINAL antes de criar um agendamento REAL. Lê a conversa inteira e o
 * horário exato prestes a ser marcado, e decide — via LLM, com contexto completo
 * — se o paciente pediu/confirmou CLARAMENTE aquele dia e horário.
 *
 * É o ponto único onde as três falhas recorrentes convergem: (a) agendar quando
 * o lead recusou/pediu para não agendar; (b) agendar no dia/horário ERRADO
 * (diferente do que o lead pediu); (c) agendar sem o lead ter confirmado. A
 * heurística determinística é rápida mas erra com confiança — aqui um juiz com
 * a conversa toda tem a palavra final. Casos reais: Wagner 21 99401-9696
 * (agendou 07/08, o lead queria 11/08), Clínica Bomfim 21 96416-7887 (agendou o
 * horário que o lead recusou).
 *
 * Fail-OPEN: se a infra da LLM falhar, NÃO bloqueia (evita derrubar o
 * agendamento da clínica inteira num soluço de rede) — os guards determinísticos
 * anteriores (recusa, data afirmada, viagem) seguem valendo. Loga alto.
 */
async function verifyBookingIntentLLM(
  ctx: AgentContext,
  slotIso: string,
): Promise<{ ok: boolean; reason: string }> {
  const ld = ctx.leadData;
  const slotLabel = slotHumanLabel(slotIso);
  const offered = (ld.offered_slots ?? [])
    .map((s) => `- ${s.date_label} às ${s.time_label}`)
    .join("\n");
  // Conversa recente, ambos os lados, rotulada. Últimas ~16 mensagens não-vazias.
  const convo = ctx.history
    .filter((m) => (m.content ?? "").trim().length > 0)
    .slice(-16)
    .map((m) => `${m.role === "user" ? "Paciente" : "Atendente"}: ${m.content.trim()}`)
    .join("\n");
  const hoje = new Intl.DateTimeFormat("pt-BR", {
    timeZone: "America/Sao_Paulo",
    weekday: "long",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).format(new Date());

  try {
    const { result } = await callLlmStructuredWithFallback<z.infer<typeof BOOKING_INTENT_SCHEMA>>(
      ctx.orKey,
      {
        model: ctx.toolModel,
        systemCached:
          "Você é a barreira final antes de criar um agendamento real numa clínica. Decide se o paciente pediu/confirmou CLARAMENTE o dia e horário que estão prestes a ser marcados. Responda SEMPRE em JSON.",
        systemDynamic: "",
        messages: [
          {
            role: "user",
            content:
              `Hoje é ${hoje}.\n\n` +
              `O sistema está prestes a MARCAR este horário:\n>>> ${slotLabel} <<<\n\n` +
              (offered ? `Horários que foram oferecidos ao paciente:\n${offered}\n\n` : "") +
              `Conversa (mais recente por último):\n${convo}\n\n` +
              `O paciente pediu ou confirmou CLARAMENTE marcar em ${slotLabel}?\n` +
              `Responda { "agendar": true|false, "motivo": "curto" }.\n\n` +
              `Responda agendar=false se o paciente:\n` +
              `- recusou ou disse que NÃO quer agendar agora;\n` +
              `- pediu para ser contatado depois / adiar / "me chama quando";\n` +
              `- pediu um DIA ou HORÁRIO diferente do que está sendo marcado (ex.: sistema vai marcar ${slotLabel} mas o paciente pediu outro dia);\n` +
              `- disse que não pode nesse dia/horário (viagem, trabalho, etc.);\n` +
              `- ainda NÃO confirmou esse horário específico.\n` +
              `Responda agendar=true só se estiver CLARO que ele quer esse dia e horário.\n` +
              `Na dúvida, agendar=false — é melhor o atendente reconfirmar do que marcar errado.`,
          },
        ],
        maxTokens: 150,
        temperature: 0,
        toolChoice: "none",
      },
      (raw) => BOOKING_INTENT_SCHEMA.parse(raw),
      ctx.toolFallbackModels,
    );
    if (!result.agendar) {
      console.warn(
        `[scheduler:telemetry] ${JSON.stringify({
          event: "booking_intent_hold",
          conv: ctx.conversationId,
          account: ctx.accountId,
          agent: ctx.agentId,
          slot: slotIso,
          motivo: result.motivo ?? "",
          model: ctx.model,
        })}`,
      );
    }
    return { ok: !!result.agendar, reason: result.motivo ?? "" };
  } catch (e) {
    console.warn(
      `[scheduler] portão de intenção indisponível (fail-open) conv=${ctx.conversationId}: ${e instanceof Error ? e.message : e}`,
    );
    return { ok: true, reason: "gate_indisponivel" };
  }
}

// ── Resolução da escolha de horário ────────────────────────────────────────

/**
 * A LLM escolhe por ÍNDICE, nunca por horário/ISO. O espaço de saída é
 * {0..N-1} ∪ {null} e quem mapeia índice → slot é o código — por isso ela não
 * consegue inventar um horário que não foi oferecido nem forjar um agendamento
 * (é a mesma garantia que LLM_FORBIDDEN_LEAD_FIELDS protege; ver
 * lead-patch-guard.ts e o caso Clínica Bomfim 09/07).
 */
const SLOT_CHOICE_SCHEMA = z.object({
  escolha: z.number().int().nullable(),
  motivo: z.string().nullish(),
});

/**
 * Resolve SEMANTICAMENTE qual dos horários oferecidos o lead escolheu — em vez
 * de depender do formato em que ele escreveu o número. Cobre o que nenhuma
 * regex cobre: "14: 30", "14.30", "duas e meia", "o primeiro", "o mais cedo",
 * "aquele das 14".
 *
 * Devolve o ÍNDICE em `candidates` ou null (recusa, pergunta, ambíguo).
 *
 * Fail-CLOSED: se o validador (infra LLM) falhar, devolve null e NADA é
 * selecionado — o agente repergunta o horário (comportamento de hoje). Ao
 * contrário do validador de nome (fail-open), aqui um erro NUNCA pode virar um
 * agendamento real.
 */
async function resolveSlotChoiceLLM(
  ctx: AgentContext,
  candidates: NonNullable<LeadData["offered_slots"]>,
  lastUser: string,
): Promise<number | null> {
  const lista = candidates
    .map((s, i) => `${i}: ${s.date_label} às ${s.time_label}`)
    .join("\n");

  try {
    const { result } = await callLlmStructuredWithFallback<z.infer<typeof SLOT_CHOICE_SCHEMA>>(
      ctx.orKey,
      {
        model: ctx.toolModel,
        systemCached:
          "Você identifica QUAL horário, de uma lista numerada, o paciente escolheu numa mensagem de WhatsApp. Responda SEMPRE em JSON.",
        systemDynamic: "",
        messages: [
          {
            role: "user",
            content:
              `Horários que o atendente ofereceu, nesta ordem:\n${lista}\n\n` +
              `Mensagem do paciente: "${lastUser}"\n\n` +
              `Qual ele escolheu? Responda { "escolha": <número da lista> | null, "motivo": "curto" }.\n\n` +
              `Regras:\n` +
              `- "escolha" DEVE ser um dos números da lista acima. NUNCA invente horário.\n` +
              `- Aceite qualquer forma de escrever a hora: "14:30", "14: 30", "14.30", "14h30", "14h", "duas e meia", "2 e meia da tarde".\n` +
              `- Aceite referência por ordem: "o primeiro"/"a 1ª" = ${0}, "o segundo" = ${1}, "o mais cedo" = o mais cedo da lista, "o mais tarde" = o mais tarde.\n` +
              `- escolha=null se NÃO for uma escolha: recusa ("nenhum dos dois"), restrição/indisponibilidade ("só saio às 18h", "não posso de manhã"), pergunta ("tem na quinta?"), pedido de outro horário, ou se ficar ambíguo.\n` +
              `- Na dúvida, escolha=null. É melhor o atendente reperguntar do que marcar o horário errado.`,
          },
        ],
        maxTokens: 120,
        temperature: 0,
        toolChoice: "none",
      },
      (raw) => SLOT_CHOICE_SCHEMA.parse(raw),
      ctx.toolFallbackModels,
    );

    const idx = result.escolha;
    // Validação final: o índice PRECISA existir na lista. Qualquer coisa fora
    // da faixa (alucinação) vira "não escolheu".
    if (idx == null || !Number.isInteger(idx) || idx < 0 || idx >= candidates.length) {
      return null;
    }
    console.log(
      `[scheduler] slot resolvido por LLM conv=${ctx.conversationId} idx=${idx} iso=${candidates[idx]!.iso} motivo=${result.motivo ?? ""}`,
    );
    return idx;
  } catch (e) {
    console.warn(
      `[scheduler] resolvedor de horário indisponível (fail-closed) conv=${ctx.conversationId}: ${e instanceof Error ? e.message : e}`,
    );
    return null;
  }
}

/**
 * Escolha de horário do lead: heurística determinística primeiro (instantânea e
 * de graça — resolve "14:30", "9h", "o primeiro"), e só quando ela não resolve
 * é que a LLM entra para interpretar a mensagem. Assim o caminho comum não paga
 * latência nem token, e as formas que a regex nunca vai cobrir param de travar
 * o agendamento (caso real Costa Lima Recreio, 21 98985-6865: "14: 30" e
 * "14.30" viravam loop de "tive um problema ao registrar sua visita").
 */
/**
 * Valor usado para ZERAR selected_slot_iso num patch. Tem que ser "" e NUNCA
 * undefined: o orquestrador passa o lead_data_patch por stripNullishFields antes
 * de mergear/persistir, então uma chave undefined é REMOVIDA do patch e o valor
 * velho sobrevive no banco — a limpeza só valia dentro do turn e o slot recusado
 * voltava no turn seguinte. Foi o que aconteceu com a Silvia (12 97407-5229):
 * o guard slot_not_offered "limpou" a escolha, mas o lead_data persistido seguiu
 * com selected_slot_iso=2026-07-16T16:00 e o agente reafirmou o dia recusado.
 * "" sobrevive ao strip e é falsy em todos os checks a jusante (`!selected`,
 * `(selected ?? "").trim()`). Mesmo padrão de clearRejectedBookingName.
 */
const CLEARED_SLOT = "";

async function autoSelectSlot(ctx: AgentContext): Promise<Partial<LeadData>> {
  // Já escolhido neste turn (ou num anterior): nada a resolver. Sem isto, o
  // tryDeterministicBooking — que roda DEPOIS do caminho principal — chamaria a
  // LLM uma segunda vez no mesmo turn.
  //
  // MAS a escolha só vale enquanto o lead não disser que NÃO pode nesse dia: o
  // selected_slot_iso era GRUDENTO — uma vez setado, este return abandonava a
  // função e nada mais o limpava (só os guards do criar_agendamento, tarde
  // demais). Caso real (Escudero, Silvia 12 97407-5229): "pode ser a tarde"
  // auto-selecionou 16/07 16:00; ela respondeu "por hoje não vou conseguir ir,
  // pode ser amanhã ou sábado" e o agente REAFIRMOU "ficou para 16/07 às 16:00"
  // duas vezes, quebrando só no guard do booking. Recusa/indisponibilidade →
  // limpa a escolha para o agente reofertar.
  //
  // Limpamos com QUALQUER recusa, sem tentar adivinhar de que dia ela fala: na
  // frase real da lead o requestedDateFromText devolve null (a negação impede a
  // extração da data, e com razão), então não há sinal confiável de dia. O pior
  // caso de limpar demais é reofertar um turn a mais; o de limpar de menos é
  // reafirmar um dia recusado e queimar o lead.
  if ((ctx.leadData.selected_slot_iso ?? "").trim()) {
    const lastUserMsg =
      [...ctx.history].reverse().find((m) => m.role === "user")?.content?.trim() ?? "";
    if (
      lastUserMsg &&
      (looksLikeDecline(lastUserMsg) || mentionsUnavailability(lastUserMsg.toLowerCase()))
    ) {
      console.log(
        `[scheduler] lead recusou o horário escolhido conv=${ctx.conversationId} iso=${ctx.leadData.selected_slot_iso} — limpando a escolha p/ reofertar`,
      );
      return { selected_slot_iso: CLEARED_SLOT };
    }
    return {};
  }

  const det = tryAutoSelectOfferedSlot(ctx.stage, ctx.leadData, ctx.history);
  if (Object.keys(det).length > 0) return det;

  if (ctx.dryRun) return {};
  if (ctx.stage !== "SLOT_OFFER" && ctx.stage !== "NAME_COLLECT" && ctx.stage !== "BOOKING") {
    return {};
  }
  if ((ctx.leadData.offered_slots?.length ?? 0) === 0) return {};

  const lastUser = [...ctx.history].reverse().find((m) => m.role === "user")?.content?.trim() ?? "";
  if (!lastUser) return {};

  // Recusa/indisponibilidade NUNCA vai para a LLM — os guards determinísticos
  // que impedem "só largo às 18:00" de virar agendamento continuam mandando.
  if (looksLikeDecline(lastUser) || mentionsUnavailability(lastUser.toLowerCase())) return {};

  // Lead pediu uma DATA que não está entre os slots ofertados ("dia 11/08" com
  // ofertas de 07-08/08): quer trocar de dia. Não deixa a LLM escolher um slot
  // do dia errado — o agente re-lista na data pedida. Ver o mesmo guard em
  // tryAutoSelectOfferedSlot (caso Wagner 21 99401-9696).
  if (leadRequestedUnofferedDate(ctx.leadData, ctx.history)) return {};

  // Candidatos: o que o agente falou no último turno, na ordem em que falou.
  // Sem isso, "o primeiro" apontaria para offered_slots[0] — um horário que o
  // agente pode nunca ter mencionado.
  const spoken = slotsOfferedInLastTurn(ctx.leadData, ctx.history);
  const candidates = spoken.length > 0 ? spoken : (ctx.leadData.offered_slots ?? []);
  if (candidates.length === 0) return {};

  const idx = await resolveSlotChoiceLLM(ctx, candidates, lastUser);
  if (idx == null) return {};
  return patchFromSlot(candidates[idx]!);
}

/**
 * true quando o horário a agendar NÃO é um dos que a busca realmente ofereceu.
 * selected_slot_iso deveria sempre ser membro de offered_slots (a escolha sai
 * de lá). Se não é, é um horário fantasma — inventado pelo modelo ou um slot
 * velho que sobrou depois de offered_slots ser atualizado. Sem offered_slots
 * (lista vazia) não dá para validar → retorna false (deixa outros guards agir).
 */
export function isSlotNotOffered(
  selectedIso: string | null | undefined,
  offeredSlots: ReadonlyArray<{ iso: string }>,
): boolean {
  const sel = (selectedIso ?? "").trim();
  if (!sel) return false;
  if (offeredSlots.length === 0) return false;
  return !offeredSlots.some((s) => s.iso === sel);
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
    // REMARCAÇÃO vs DUPLICATA: se o horário pedido AGORA é DIFERENTE do que já
    // está agendado (booked_slot_iso), é uma REMARCAÇÃO → cancela o antigo e
    // segue para criar o novo. Só é duplicata (idempotência) quando o horário
    // é o MESMO. Sem isso, o lead remarcava e a trava dizia "já agendado",
    // deixando o novo horário SEM ser criado no CRM.
    const bookedSlot = (ld.booked_slot_iso ?? "").trim();
    const requestedSlot = (ld.selected_slot_iso ?? "").trim();
    const isReschedule = !!bookedSlot && !!requestedSlot && bookedSlot !== requestedSlot;

    if (!isReschedule) {
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
          note: "Agendamento ja existe (mesmo horário) — nao foi recriado. Apenas confirme ao lead.",
        }),
      };
    }

    // Remarcação: cancela o agendamento anterior antes de criar o novo.
    console.log(
      `[scheduler] REMARCAÇÃO conv=${ctx.conversationId}: cancela ${ld.appointment_id} (${bookedSlot}) → cria novo (${requestedSlot})`,
    );
    if (!ctx.dryRun) {
      try {
        if (ctx.integrations.googleCalendar) {
          const resolved = resolveGcalAgenda(ctx, ld.selected_agenda);
          await cancelGoogleCalendarEvent(
            ctx.accountId,
            String(ld.appointment_id),
            resolved.calendarId,
          );
        } else if (ctx.integrations.clinicExperts) {
          await cancelClinicExpertsAppointment(ctx.accountId, String(ld.appointment_id));
        } else {
          await cancelClinicorpAppointment(ctx.accountId, ld.appointment_id);
        }
        await applyUnbookedTagSwap(ctx);
      } catch (e) {
        console.error(
          `[scheduler] cancelamento do anterior falhou na remarcação conv=${ctx.conversationId}: ${e instanceof Error ? e.message : e}`,
        );
        // Não bloqueia a criação do novo — melhor um duplicado do que o lead
        // sem o novo horário. Fica logado para limpeza.
      }
    }
    // Limpa o appointment_id antigo para o create abaixo prosseguir (o patch de
    // sucesso grava o NOVO id + booked_slot_iso).
    ld.appointment_id = undefined;
    ctx.leadData = { ...ctx.leadData, appointment_id: undefined };
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

  // GUARD DE DISPONIBILIDADE REAL: o horário a marcar TEM que ser um dos que a
  // busca (listar_horarios) realmente ofereceu. offered_slots é a lista de
  // vagas REAIS da agenda; selected_slot_iso deveria sempre sair dela (a
  // heurística/o resolvedor escolhem por índice dentro dela). Se não bate, é
  // um horário FANTASMA — ou um slot velho que sobrou de uma oferta anterior
  // (offered_slots foi atualizado e a escolha não), ou uma hora inventada.
  // Caso real (Costa Lima Recreio, Osiane 21 96678-6864): ofertou a tarde
  // (17/07 13:00), a lead pediu manhã, offered_slots virou os da manhã, mas
  // selected_slot_iso ficou preso em 13:00 → o create tentava marcar 13:00.
  // Só valida quando há offered_slots; sem eles, deixa os outros guards agirem.
  const offered = ld.offered_slots ?? [];
  if (isSlotNotOffered(ld.selected_slot_iso, offered)) {
    console.warn(
      `[scheduler:telemetry] ${JSON.stringify({
        event: "slot_not_offered_blocked",
        conv: ctx.conversationId,
        account: ctx.accountId,
        agent: ctx.agentId,
        selected: ld.selected_slot_iso,
        offered: offered.map((s) => s.iso),
        model: ctx.model,
      })}`,
    );
    return {
      result: JSON.stringify({
        ok: false,
        error_kind: "slot_not_offered",
        error:
          `O horário ${slotHumanLabel(ld.selected_slot_iso)} NÃO está na lista de horários realmente disponíveis desta agenda — não existe ou é de uma oferta antiga. NÃO agende esse horário e NÃO invente horários. Chame listar_horarios e ofereça ao lead APENAS os horários exatos que a ferramenta retornar.`,
      }),
      // Zera a escolha velha/fantasma para forçar nova listagem real.
      patch: { selected_slot_iso: CLEARED_SLOT },
    };
  }

  // GUARD DE CONSISTÊNCIA (data afirmada ao lead vs. slot escolhido): se o
  // agente afirmou ao lead uma data (DD/MM) e o slot a agendar cai num dia
  // DIFERENTE — que nunca foi mostrado no texto —, NÃO agenda. É o sinal de que
  // o modelo reescreveu a data dos slots reais. Caso real (Costa Lima Recreio,
  // Melissa 21 99305-7044): a tool devolveu quarta 15/07, o agente escreveu
  // "segunda 20/07", o "13h" casou o slot oculto de 15/07 e agendou o dia
  // ERRADO com o lead achando que era 20/07. Fail-open: só bloqueia quando há
  // uma data explícita no texto do agente E o slot não bate com nenhuma delas.
  const affirmedDates = affirmedDatesFromAssistant(
    ctx.history
      .filter((m) => m.role === "assistant")
      .slice(-8)
      .map((m) => m.content),
  );
  const slotDdmm = ddmmInBrt(ld.selected_slot_iso);
  if (affirmedDates.size > 0 && slotDdmm && !affirmedDates.has(slotDdmm)) {
    console.warn(
      `[scheduler:telemetry] ${JSON.stringify({
        event: "slot_date_mismatch_blocked",
        conv: ctx.conversationId,
        account: ctx.accountId,
        agent: ctx.agentId,
        slot_ddmm: slotDdmm,
        affirmed_ddmm: [...affirmedDates],
        model: ctx.model,
      })}`,
    );
    return {
      result: JSON.stringify({
        ok: false,
        error_kind: "date_mismatch",
        error: `O horário escolhido é do dia ${slotDdmm}, mas ao lead foi dito ${[...affirmedDates].join(" / ")}. NÃO agende esse horário. Chame listar_horarios com data_alvo (YYYY-MM-DD) da data que o lead realmente pediu e ofereça os horários REAIS dessa data antes de agendar.`,
      }),
      // Zera o slot/oferta para forçar nova listagem na data correta — sem isso
      // o "13h" volta a casar o mesmo slot oculto e o guard entra em loop.
      // `[]` (não undefined) pelo mesmo motivo do CLEARED_SLOT: undefined é
      // removido pelo stripNullishFields e a oferta velha sobreviveria.
      patch: { selected_slot_iso: CLEARED_SLOT, offered_slots: [] },
    };
  }

  const leadName = resolveBookingLeadName(ld);
  if (!leadName) {
    return { result: JSON.stringify({ ok: false, error: "name ausente" }) };
  }
  // BARREIRA FINAL: valida via LLM que o nome é de fato um nome de pessoa real
  // (não agradecimento/recusa/apelido/frase). Nenhum evento é criado sem isso.
  const nameVerdict = await validatePatientNameLLM(ctx, leadName);
  if (!nameVerdict.valid) {
    console.warn(
      `[scheduler] nome rejeitado pelo validador conv=${ctx.conversationId} name="${leadName.slice(0, 60)}" motivo=${nameVerdict.reason}`,
    );
    return {
      result: JSON.stringify({
        ok: false,
        error: "NOME_INVALIDO",
        need_valid_name: true,
        motivo: nameVerdict.reason,
      }),
    };
  }
  // BARREIRA FINAL DE INTENÇÃO: antes de criar o agendamento REAL, um juiz LLM
  // com a conversa inteira confirma que o paciente quer ESTE dia e horário. É
  // por aqui que passam as três falhas recorrentes (agendar recusado, agendar
  // dia errado, agendar sem confirmação). Fail-open no erro de infra.
  if (!ctx.dryRun) {
    const intent = await verifyBookingIntentLLM(ctx, ld.selected_slot_iso);
    if (!intent.ok) {
      console.warn(
        `[scheduler] portão de intenção BLOQUEOU o agendamento conv=${ctx.conversationId} slot=${ld.selected_slot_iso} motivo=${intent.reason}`,
      );
      return {
        result: JSON.stringify({
          ok: false,
          error_kind: "intent_hold",
          error:
            `O paciente NÃO confirmou claramente marcar em ${slotHumanLabel(ld.selected_slot_iso)} (motivo: ${intent.reason}). ` +
            `NÃO diga que agendou. Releia a última mensagem dele e responda ao que ele realmente pediu: se ele quer outro dia/horário, chame listar_horarios na data certa; se pediu para ser contatado depois, registre o retorno; se recusou, acolha. Só agende depois de uma confirmação clara.`,
        }),
        // Zera a escolha para não reagendar o mesmo slot em loop no próximo turn.
        patch: { selected_slot_iso: CLEARED_SLOT },
      };
    }
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
      await removeLeadFromSequences(ctx);
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
          booked_slot_iso: ld.selected_slot_iso,
          ...(resolved.agendaLabel ? { selected_agenda: resolved.agendaLabel } : {}),
        },
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const kind = classifyBookingError(msg);
      console.error(
        `[scheduler] criar_agendamento GCal falhou conv=${ctx.conversationId} kind=${kind}: ${msg}`,
      );
      return { result: JSON.stringify({ ok: false, error: msg.slice(0, 300), error_kind: kind }) };
    }
  }

  // Clinic Experts
  if (ctx.integrations.clinicExperts) {
    try {
      const chosenSlot = ld.offered_slots?.find((s) => s.iso === ld.selected_slot_iso);
      const appt = await createClinicExpertsAppointment(ctx.accountId, {
        phone: bookingPhone,
        name: leadName,
        datetime: ld.selected_slot_iso,
        endDatetime: chosenSlot?.end_iso,
        professionalUuid: ld.professional_uuid ?? chosenSlot?.professional_uuid,
        notes: await buildClinicorpCaseNotes(ctx),
      });
      await applyBookedTagSwap(ctx);
      await removeLeadFromSequences(ctx);
      return {
        result: JSON.stringify({ ok: true, appointment_id: appt.id, datetime: appt.datetime }),
        patch: {
          appointment_id: appt.id,
          name: leadName,
          booked_tag_applied: true,
          booked_slot_iso: ld.selected_slot_iso,
        },
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const kind = classifyBookingError(msg);
      console.error(
        `[scheduler] criar_agendamento Clinic Experts falhou conv=${ctx.conversationId} kind=${kind}: ${msg}`,
      );
      return { result: JSON.stringify({ ok: false, error: msg.slice(0, 300), error_kind: kind }) };
    }
  }

  // Default: Clinicorp
  try {
    // Fim REAL do slot escolhido (da grade da agenda) — evita estourar a grade
    // com a duração padrão. Ex.: agenda oferta 14:00–14:30, mas a duração
    // configurada é 40min → sem isto o create pediria 14:00–14:40 e o Clinicorp
    // recusaria como "ocupado".
    const chosenSlot = ld.offered_slots?.find((s) => s.iso === ld.selected_slot_iso);
    const appt = await createClinicorpAppointment(ctx.accountId, {
      phone: bookingPhone,
      name: leadName,
      datetime: ld.selected_slot_iso,
      endDatetime: chosenSlot?.end_iso,
      dentistPersonId: ld.dentist_person_id,
      notes: await buildClinicorpCaseNotes(ctx),
    });
    await applyBookedTagSwap(ctx);
    await removeLeadFromSequences(ctx);
    return {
      result: JSON.stringify({ ok: true, appointment_id: appt.id, datetime: appt.datetime }),
      patch: {
        appointment_id: appt.id,
        name: leadName,
        booked_tag_applied: true,
        booked_slot_iso: ld.selected_slot_iso,
      },
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const kind = classifyBookingError(msg);
    console.error(
      `[scheduler] criar_agendamento Clinicorp falhou conv=${ctx.conversationId} kind=${kind}: ${msg}`,
    );
    return { result: JSON.stringify({ ok: false, error: msg.slice(0, 300), error_kind: kind }) };
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
      { currentTags: ctx.helenaContact.tagNames },
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
 * Cancela o agendamento ativo do lead (Clinicorp, Google Calendar ou Clinic Experts) e limpa
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
    clearPatch.professional_uuid = undefined;
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
    } else if (ctx.integrations.clinicExperts) {
      await cancelClinicExpertsAppointment(ctx.accountId, String(ld.appointment_id));
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

  if (!opts?.reoffer) {
    return {
      result: JSON.stringify({
        ok: true,
        cancelled: true,
        reoffer: false,
        note: "Agendamento cancelado com sucesso. Confirme ao lead.",
      }),
      patch: clearPatch,
    };
  }

  // REMARCAÇÃO: já traz os NOVOS horários no MESMO turn. O lead não pode ficar
  // esperando "vou buscar e já volto" — caso real (21 97558-2703): cancelou o
  // horário antigo e nunca trouxe/remarcou os novos. Listamos aqui e devolvemos
  // os slots no resultado da tool para o agente ofertar de imediato.
  ctx.leadData = mergeLeadDataPatch(ctx.leadData, clearPatch);
  const listing = await execListarHorarios(ctx, undefined, ctx.leadData.selected_agenda);
  const reofferPatch = mergeLeadDataPatch(clearPatch as LeadData, listing.patch ?? {});
  return {
    result:
      JSON.stringify({
        ok: true,
        cancelled: true,
        reoffer: true,
        note: "Agendamento anterior cancelado. OFEREÇA JÁ os horários abaixo ao lead nesta MESMA resposta (next_stage=SLOT_OFFER). NÃO diga que vai buscar/verificar depois — os horários já estão aqui.",
      }) + `\n\n# NOVOS HORÁRIOS DISPONÍVEIS (listar_horarios)\n${listing.result}`,
    patch: reofferPatch,
  };
}

// ── Prompts (separados em cached + dynamic) ───────────────────────────────

function buildCachedSystemPrompt(ctx: AgentContext): string {
  const s = ctx.agentSettings;
  const orgLabel = s.company_name?.trim() || "empresa";
  const appointmentLabel = s.appointment_type_label?.trim() || "Consulta";
  const commitmentQ = defaultCommitmentQuestion(s);
  const commitmentEnabled = isCommitmentRequired(s) && !!commitmentQ;
  // NOTA: fieldsBlock (campos já coletados / faltantes) e phoneBlock são VOLÁTEIS
  // — mudam a cada turno conforme o lead responde. Por isso NÃO entram aqui: este
  // prompt é o bloco CACHEADO (prefix-match do prompt caching Anthropic) e precisa
  // ser byte-estável para o cache valer. Esses blocos vão em buildDynamicSystemPrompt
  // (bloco NÃO cacheado). Ver [[prompt-caching-fieldsblock]].

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
  ⚠️ Se o lead perguntar por OUTRO dia/data — inclusive relativo ("tem amanhã?",
  "e sexta?", "semana que vem", "outro dia", "de manhã") — NÃO responda com
  pergunta de confirmação nem repita os horários antigos: CHAME listar_horarios
  com \`data_alvo\` desse dia (calcule "amanhã"/"sexta" a partir de HOJE) e
  ofereça os horários reais daquele dia. Consultar a agenda é obrigatório aqui.
  ⛔ UMA pergunta de esclarecimento no MÁXIMO. Assim que o lead indicar QUALQUER
  preferência de tempo (um período "manhã"/"tarde" OU um dia), PARE de perguntar
  e CHAME listar_horarios IMEDIATAMENTE para ofertar 2 horários REAIS. NUNCA faça
  uma segunda pergunta do tipo "amanhã de manhã ou outro dia de manhã?" — a essa
  altura o lead espera VER horários, não responder outra pergunta.
  🚫 Essa pergunta de esclarecimento tem que ser NEUTRA: "prefere manhã ou tarde?"
  ou "algum dia específico?". NUNCA proponha dias/datas concretos que você NÃO
  confirmou no listar_horarios ("segunda ou terça?", "que tal sexta?") — a agenda
  pode estar FECHADA nesses dias e você criaria uma expectativa falsa. Só CITE um
  dia ou horário DEPOIS que a tool o retornar. Se o lead recusar um horário sem
  dar preferência (ex.: "hoje não dá"), prefira JÁ chamar listar_horarios para os
  próximos dias e ofertar os dias REAIS, em vez de adivinhar dias.
  ⚠️ Se o lead disser um TURNO ("de manhã", "à tarde", "de noite"), passe
  \`periodo\` ("manha"/"tarde"/"noite") em listar_horarios — sem isso a busca traz
  só os horários mais cedo e pode dizer que a tarde não tem vaga mesmo tendo.
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
- ⛔ MUDANÇA DE HORÁRIO NÃO É AUTOMÁTICA: criar_agendamento NÃO move um evento
  existente (é bloqueado por já haver appointment_id). A ÚNICA forma de mudar a
  data/hora é remarcar_agendamento. Portanto, se o lead pedir outro horário,
  NUNCA diga "atualizei", "remarquei", "mudei", "ajustei" ou "já está alterado"
  ANTES de chamar remarcar_agendamento e receber ok=true. Sem a tool, o horário
  na agenda continua o ANTIGO e o lead aparece num horário que não existe.
- Nunca diga que cancelou/remarcou sem a tool retornar ok=true.

# GUARDRAILS INEGOCIÁVEIS
🚫 **PREÇO/VALOR:** NUNCA informe preço, valor, "a partir de", "em torno de" ou "investimento de R$" de consulta, avaliação ou procedimento — mesmo que o lead insista várias vezes ou pressione dizendo que só decide sabendo o valor. Só cite um valor se ele estiver ESCRITO EXPLICITAMENTE nas instruções acima (prompt do proprietário). Se não estiver, responda que o valor é definido na avaliação presencial (cada caso é único) e conduza ao agendamento. NUNCA invente nem estime um número.
1. NUNCA diga "vou verificar", "estou consultando", "já retorno" — chame a tool de verdade.
2. NUNCA invente horários, IDs ou nomes. Use APENAS valores vindos das tools.
3. **NUNCA diga "agendei", "marquei" ou "confirmado" sem appointment_id** em lead_data (ok=true de criar_agendamento).
4. Se o lead já tem appointment_id em lead_data → next_stage="CONFIRMED".
5. NUNCA repita pergunta de campo que já consta em LEAD_DATA.
6. Escale para humano (next_stage="ESCALATED" + lead_data_patch.escalation_reason) quando o lead pedir explicitamente OU quando ele demonstrar frustração real / risco de desistir (reclamar do atendimento, dizer que foi induzido/enrolado, ameaçar não vir, dizer que vai procurar outro lugar). NUNCA diga "vou chamar alguém da equipe", "vou te transferir" ou algo parecido sem usar next_stage="ESCALATED" no MESMO turno — dizer isso sem escalar deixa o lead esperando um atendimento que nunca chega.

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

- **SLOT_OFFER**: ofereça no máximo 2 horários ao lead. SEMPRE use a tool listar_horarios primeiro (só se selected_slot_iso ainda estiver vazio). Nunca invente horários. Se o lead pedir uma DATA específica (ex: "25 de julho", "20/07"), passe-a em \`data_alvo\` (YYYY-MM-DD) ao chamar listar_horarios — sem isso a busca não alcança datas distantes. **Se o lead perguntar por OUTRO dia/data, inclusive relativo ("tem amanhã?", "e sexta?", "semana que vem", "outro dia", "de manhã"), NÃO responda com pergunta de confirmação nem repita os horários antigos: chame listar_horarios com \`data_alvo\` daquele dia (calcule "amanhã"/"sexta" a partir de HOJE) e ofereça os horários reais. Consultar a agenda é obrigatório. ⛔ UMA pergunta de esclarecimento no MÁXIMO: assim que o lead indicar QUALQUER preferência (período "manhã"/"tarde" OU um dia), PARE de perguntar e chame listar_horarios IMEDIATAMENTE — nunca faça uma segunda pergunta tipo "amanhã de manhã ou outro dia?", traga os horários reais. Se o lead disser um TURNO ("de manhã", "à tarde", "de noite"), passe \`periodo\` ("manha"/"tarde"/"noite") — sem isso a busca traz só os horários mais cedo e pode dizer que a tarde não tem vaga mesmo tendo. 🚫 Numa pergunta de esclarecimento, NUNCA cite dias/datas específicos que você não confirmou na agenda ("segunda ou terça?", "que tal sexta?") — a agenda pode estar FECHADA nesses dias e você criaria uma expectativa falsa. Esclareça de forma NEUTRA ("prefere manhã ou tarde?", "algum dia específico?") e só CITE um dia/horário DEPOIS que listar_horarios o retornar; se o lead recusar sem dar preferência (ex.: "hoje não dá"), prefira já chamar listar_horarios e ofertar os dias REAIS.** Só avance para NAME_COLLECT quando selected_slot_iso estiver preenchido (lead escolheu horário ou turno manhã/tarde).
- **NAME_COLLECT**: só opere aqui se selected_slot_iso existir. Confirme o slot escolhido. NÃO chame listar_horarios. Colete os campos obrigatórios abaixo (UM por mensagem).${commitmentEnabled ? ` Depois de todos os campos, pergunte compromisso: "${commitmentQ}"` : " Não pergunte sobre dentista/médico — use linguagem do negócio (visita, reunião, etc.)."}
- **BOOKING**: o sistema tenta criar o agendamento automaticamente. Se criar_agendamento retornar ok=true, confirme ao lead e use next_stage="CONFIRMED". Se ok=false, NÃO diga que agendou. Só diga que o horário "ficou indisponível" quando error_kind="conflict" (horário ocupado) — e ofereça OUTRO horário, nunca o mesmo. Se error_kind="technical", NÃO minta sobre indisponibilidade: peça desculpas por um problema técnico e diga que vai tentar registrar de novo.
- **CONFIRMED**: só após appointment_id em lead_data (evento criado na agenda). Agradeça e encerre.

# REGRAS ABSOLUTAS

0. 🚫 **PREÇO/VALOR:** NUNCA informe preço, valor, "a partir de", "em torno de" ou "investimento de R$" de consulta, avaliação ou procedimento — mesmo que o lead insista ou pressione dizendo que só decide sabendo o valor. Só cite um valor se estiver ESCRITO EXPLICITAMENTE no prompt do proprietário. Se não estiver, diga que o valor é definido na avaliação presencial (cada caso é único) e conduza ao agendamento. NUNCA invente nem estime um número.
1. NUNCA diga "vou verificar", "estou consultando", "já te retorno" — chame a tool de verdade.
2. NUNCA invente horários, IDs ou nomes. Use APENAS valores das tools.
3. UMA pergunta por vez. Mensagens curtas. Use \\n\\n no reply para separar bolhas no WhatsApp.
4. NUNCA use "dentista" ou "consulta odontológica" se o contexto for escola/educação — use "${appointmentLabel}" e linguagem do prompt do proprietário.
5. Escale para humano (next_stage="ESCALATED" + lead_data_patch.escalation_reason) quando o lead pedir explicitamente OU quando ele demonstrar frustração real / risco de desistir (reclamar do atendimento, dizer que foi induzido/enrolado, ameaçar não vir, dizer que vai procurar outro lugar). NUNCA diga "vou chamar alguém da equipe", "vou te transferir" ou algo parecido sem usar next_stage="ESCALATED" no MESMO turno — dizer isso sem escalar deixa o lead esperando um atendimento que nunca chega.
6. **NUNCA diga "agendei", "marquei" ou "está confirmado" sem appointment_id em lead_data** (ok=true de criar_agendamento).
7. Se o lead já tem appointment_id em lead_data → next_stage="CONFIRMED" e agradeça.
7b. **MUDAR data/hora de um agendamento existente SÓ via remarcar_agendamento.** criar_agendamento não move evento já criado. NUNCA diga "atualizei/remarquei/mudei/ajustei o agendamento" antes de remarcar_agendamento retornar ok=true — senão a agenda fica no horário antigo e o lead aparece num horário inexistente.
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
  // Data de hoje em ISO (YYYY-MM-DD, fuso SP) — referência p/ o parâmetro
  // data_alvo do listar_horarios e para o agente nunca ofertar no passado.
  const todayIso = new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(now);

  const ld = ctx.leadData;
  const offeredSlotsText = (ld.offered_slots ?? [])
    .map((s) => `  • ${s.date_label} ${s.time_label} (iso=${s.iso}, dentist_person_id=${s.dentist_person_id ?? "?"})`)
    .join("\n");

  const channelCtx = { channel: ctx.channel, effectivePhone: ctx.effectivePhone };
  const bookingFields = getBookingFieldsForChannel(ctx.agentSettings, channelCtx);
  // fieldsBlock e phoneBlock vivem AQUI (bloco dinâmico, não cacheado) porque
  // mudam a cada turno — mantê-los fora do systemCached preserva o prefix-match
  // do prompt caching. Ver buildCachedSystemPrompt.
  const fieldsBlock = buildBookingFieldsPromptBlock(bookingFields, ctx.leadData);
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

- 📅 HOJE é ${dateStr} (São Paulo) — data de referência ISO: ${todayIso}. Localize-se SEMPRE por ela. NUNCA ofereça, confirme ou mencione horários no PASSADO. Só ofereça horários vindos de listar_horarios (que já começa a partir de hoje). Ao passar data_alvo, calcule "amanhã"/"sexta"/"dia 15" a partir de HOJE (${todayIso}).
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

${fieldsBlock ? `${fieldsBlock}\n\n` : ""}${(() => {
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
  }${
    ctx.stage === "CONFIRMED" && ld.booked_slot_iso && new Date(ld.booked_slot_iso).getTime() < now.getTime()
      ? `\n# ATENÇÃO: O AGENDAMENTO REGISTRADO JÁ PASSOU\nbooked_slot_iso=${ld.booked_slot_iso} é ANTERIOR a agora (${todayIso}) — essa visita JÁ ACONTECEU. Se o lead escreve de novo pedindo para "confirmar" uma consulta, é porque está falando de algo NOVO (ex.: um retorno/procedimento sugerido durante a visita anterior) que AINDA NÃO está registrado no sistema — NÃO existe outro appointment_id. NUNCA reafirme o horário antigo (ex.: "confirmado para ontem às Xh") como se respondesse à pergunta dele — isso não faz sentido e confunde o lead. Diga que vai verificar com a equipe os detalhes dessa nova consulta e use next_stage="ESCALATED" com lead_data_patch.escalation_reason explicando a situação (não há registro do novo agendamento sugerido).\n`
      : ""
  }
# RETORNO AGENDADO (NÃO confundir com agendar consulta)
Se o lead disser que não pode falar agora e pedir contato em outra data ("me chama
amanhã", "semana que vem"), preencha lead_data_patch.retomar_em com a data/hora ISO
8601 (fuso -03:00) calculada a partir de "Agora (BRT)", e retorno_motivo com o pedido.
Isso pausa os follow-ups até lá. NÃO use para marcar consulta (isso é o fluxo de slots).`;
}

function hasBookingIntegration(ctx: AgentContext): boolean {
  return (
    ctx.integrations.googleCalendar ||
    ctx.integrations.clinicorp ||
    ctx.integrations.clinup ||
    ctx.integrations.clinicExperts
  );
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
  // Sem dias_a_frente → usa a janela padrão (hoje + 3 dias, com ampliação
  // automática) para ofertar sempre os horários mais próximos.
  const outcome = await execListarHorarios(ctx);
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
  // SLOT_OFFER incluído: quando o lead escolhe o horário e os dados obrigatórios
  // já estão completos (ex.: nome coletado antes), agendamos NO MESMO turno —
  // sem "aguarde um instante". O isReadyForBooking/preflight ainda barram se
  // faltar algo. tryAutoSelectOfferedSlot já opera em SLOT_OFFER.
  if (
    ctx.stage !== "BOOKING" &&
    ctx.stage !== "NAME_COLLECT" &&
    ctx.stage !== "SLOT_OFFER"
  ) {
    return { patch: {}, toolsCalled: [] };
  }

  // Recusa explícita ("não, obrigado", "não quero", "desisti") NUNCA deve
  // auto-agendar, mesmo com os campos completos. Caso real: o lead disse "Não,
  // obrigado." e o sistema agendou sozinho (e ainda gravou a frase como nome).
  // Deixa o LLM responder à recusa no lugar.
  const lastUserMsg = [...ctx.history].reverse().find((m) => m.role === "user")?.content ?? "";
  if (looksLikeDecline(lastUserMsg)) {
    return { patch: {}, toolsCalled: [] };
  }

  const slotPatch = await autoSelectSlot(ctx);
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

  // Só re-lista horários quando o slot está REALMENTE ocupado (conflito). Falha
  // técnica (ex.: create do Clinicorp retornou erro, mas o horário segue livre)
  // NÃO é indisponibilidade — não mexemos nos horários aqui; a trava final trata
  // com mensagem honesta + retry/escala. Antes, um regex só de "indisponível"
  // deixava a falha técnica passar como se fosse conflito silencioso.
  const failure = parseBookingFailure(toolResult);
  if (failure?.kind === "conflict") {
    console.warn(
      `[scheduler] slot indisponível conv=${ctx.conversationId} — atualizando horários`,
    );
    // Poda o slot que falhou de offered_slots (nunca re-ofertá-lo) e limpa a escolha.
    const failedIso = ctx.leadData.selected_slot_iso;
    ctx.leadData.offered_slots = pruneOfferedSlot(ctx.leadData.offered_slots, failedIso);
    delete ctx.leadData.selected_slot_iso;
    extraPatch = { ...extraPatch, offered_slots: ctx.leadData.offered_slots };
    delete extraPatch.selected_slot_iso;
    // Re-lista a MESMA agenda (multi-agenda) — selected_agenda persiste no conflito.
    const refresh = await execListarHorarios(ctx, undefined, ctx.leadData.selected_agenda);
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
  const gateCost = { costUsd: 0, tokensIn: 0, tokensOut: 0 };
  if (lastUserMsg) {
    const gate = await decideRagNeed(ctx.orKey, ctx.ragGateModel, ctx.history, lastUserMsg);
    gateCost.costUsd = gate.costUsd;
    gateCost.tokensIn = gate.tokensIn;
    gateCost.tokensOut = gate.tokensOut;
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

  const slotAuto = await autoSelectSlot(ctx);
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
  // Nome rejeitado pelo validador (need_valid_name) — o turn NÃO deve agendar
  // nem ofertar horário: deve pedir o NOME COMPLETO do paciente.
  let invalidNameBlocked = !!autoBooking.toolResult?.includes('"need_valid_name":true');
  // Classificação da última falha de booking do turn (conflito x técnica). Guia a
  // trava final: conflito → reoferta OUTROS horários; técnica → mensagem honesta
  // + retry/escala (nunca "indisponível" com o slot ainda livre).
  let bookingFailureKind: BookingFailureKind | null =
    parseBookingFailure(autoBooking.toolResult)?.kind ?? null;
  // true quando a ÚLTIMA tentativa falhou por VALIDAÇÃO (campo obrigatório
  // faltando/inválido) — não é conflito nem falha técnica de create. A trava
  // final não deve mentir "horário indisponível" nesse caso (ver
  // isValidationOnlyFailure) — idem para os HOLDS de guard (intent_hold,
  // slot_not_offered, date_mismatch): o create nem chegou a ser tentado.
  let bookingValidationOnly =
    isValidationOnlyFailure(autoBooking.toolResult) || isGuardHoldFailure(autoBooking.toolResult);
  // Qual guard segurou o agendamento (intent_hold/slot_not_offered/date_mismatch),
  // para telemetria: distingue no banco um hold correto de uma falha real.
  let bookingGuardHold: string | undefined = isGuardHoldFailure(autoBooking.toolResult)
    ? (autoBooking.toolResult?.match(/"error_kind"\s*:\s*"([^"]+)"/)?.[1] ?? undefined)
    : undefined;
  // Guarda o resultado cru da última falha de booking p/ persistir o erro no meta
  // da mensagem (diagnóstico). Sem isto, a causa do "indisponível" ficava só no
  // log do servidor e invisível no banco.
  let lastBookingFailureResult: string | undefined = bookingFailureKind
    ? autoBooking.toolResult
    : undefined;
  if (autoBooking.toolResult) {
    baseDynamic += `\n\n# RESULTADO criar_agendamento (automático)\n${autoBooking.toolResult}\n` +
      (ctx.leadData.appointment_id
        ? "Evento criado na agenda. Confirme ao lead e use next_stage=CONFIRMED."
        : invalidNameBlocked
          ? "O nome informado NÃO é um nome de pessoa válido. NÃO agende e NÃO ofereça horários. Peça gentilmente o NOME COMPLETO do paciente (nome e sobrenome) para finalizar. next_stage=NAME_COLLECT."
          : isGuardHoldFailure(autoBooking.toolResult)
          ? "O agendamento foi SEGURADO de propósito (veja error_kind e a instrução no resultado acima). NÃO houve problema técnico e NÃO houve indisponibilidade — não diga nenhuma das duas coisas ao lead. Siga exatamente a instrução do resultado e responda ao que o lead realmente pediu."
          : 'Falha ao registrar o agendamento. NÃO confirme. Se o resultado indicar error_kind="conflict" (horário ocupado), peça desculpas e ofereça OUTRO horário (nunca o que falhou). Se error_kind="technical" (falha ao registrar, horário segue livre), NÃO diga que ficou indisponível: peça desculpas por um problema técnico momentâneo e diga que já vai tentar registrar de novo.');
  }

  const dynamic = extras ? baseDynamic + "\n\n" + extras : baseDynamic;

  // Histórico convertido para LlmMessage.
  const history: LlmMessage[] = ctx.history.map((m) => ({ role: m.role, content: m.content }));

  let workingMessages: LlmMessage[] = [...history];
  let totalTokensIn = gateCost.tokensIn;
  let totalTokensOut = gateCost.tokensOut;
  let totalCostUsd = gateCost.costUsd;
  // Telemetria: marca quando o LLM tentou criar agendamento DUPLICADO no mesmo
  // turn (apos o tryDeterministicBooking ja ter criado). O guard em
  // execCriarAgendamento retorna already_booked:true e a flag vai para
  // messages.meta para diagnostico.
  let doubleBookingBlocked = false;
  // tool_call_id de cada chamada listar_horarios* deste turn, na ordem em que
  // rodaram — usado para neutralizar resultados ANTIGOS antes da resposta
  // final (ver comentário logo após o loop de tools).
  const listarHorariosToolCallIds: string[] = [];

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
          case "buscar_paciente_clinic_experts":
            outcome = await execBuscarPaciente(ctx);
            break;
          case "listar_horarios":
          case "listar_horarios_clinicorp":
          case "listar_horarios_google_calendar":
          case "listar_horarios_clinup":
          case "clinup_buscar_horarios":
          case "listar_horarios_clinic_experts":
            listarHorariosToolCallIds.push(tc.id);
            outcome = await execListarHorarios(
              ctx,
              args.dias_a_frente as number | undefined,
              typeof args.agenda === "string" ? args.agenda : undefined,
              typeof args.data_alvo === "string" ? args.data_alvo : undefined,
              typeof args.periodo === "string" ? args.periodo : undefined,
            );
            break;
          case "criar_agendamento":
          case "agendar_clinicorp":
          case "agendar_google_calendar":
          case "agendar_clinup":
          case "agendar_clinic_experts":
            outcome = await execCriarAgendamento(
              ctx,
              typeof args.agenda === "string" ? args.agenda : undefined,
            );
            break;
          case "cancelar_agendamento":
          case "cancelar_clinicorp":
          case "cancelar_google_calendar":
          case "cancelar_clinic_experts":
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
      const isBookingTool =
        tc.function.name === "criar_agendamento" ||
        tc.function.name === "agendar_clinicorp" ||
        tc.function.name === "agendar_google_calendar" ||
        tc.function.name === "agendar_clinup" ||
        tc.function.name === "agendar_clinic_experts";
      if (isBookingTool && outcome.result.includes('"already_booked":true')) {
        doubleBookingBlocked = true;
      }
      if (isBookingTool) {
        // Validação pendente OU hold de guard: nos dois casos o create nunca foi
        // tentado. A trava de confirmação falsa não pode inventar "indisponível"
        // (default conflict) nem "problema técnico" — o LLM já recebeu no
        // resultado da tool a instrução do que fazer e responde ao lead.
        bookingValidationOnly =
          isValidationOnlyFailure(outcome.result) || isGuardHoldFailure(outcome.result);
        if (isGuardHoldFailure(outcome.result)) {
          bookingGuardHold =
            outcome.result.match(/"error_kind"\s*:\s*"([^"]+)"/)?.[1] ?? bookingGuardHold;
        }
        const f = parseBookingFailure(outcome.result);
        if (f) {
          bookingFailureKind = f.kind;
          lastBookingFailureResult = outcome.result;
        }
      }
      if (outcome.result.includes('"need_valid_name":true')) {
        invalidNameBlocked = true;
      }
      console.log(`[scheduler] tool ${tc.function.name} → ${outcome.result.slice(0, 200)}`);

      workingMessages.push({
        role: "tool",
        tool_call_id: tc.id,
        content: outcome.result,
      });
    }
  }

  // Quando o modelo do tool loop chama listar_horarios MAIS DE UMA VEZ no
  // mesmo turn (comum ao refinar por período/data), cada chamada SOBRESCREVE
  // offered_slots em lead_data — só a ÚLTIMA sobrevive no patch acumulado.
  // Só que a resposta final é gerada olhando TODO o histórico de tool calls
  // deste turn, incluindo os resultados ANTIGOS (já stale) — o modelo pode
  // narrar um horário que só existia numa chamada anterior e não está mais em
  // offered_slots. Caso real (MF Beauty BSB, Clinic Experts): 3 chamadas no
  // mesmo turn, a oferta ao lead citou um horário da 1ª/2ª chamada que sumiu
  // na 3ª — o lead aceitou esse horário "fantasma" e o sistema não achou
  // correspondência real (ou, antes do fix em tryAutoSelectOfferedSlot,
  // chegou a confirmar outro horário por engano). Neutraliza o CONTEÚDO dos
  // resultados antigos (mantém a tool call visível no histórico, só troca o
  // JSON por um aviso) — assim a resposta final só pode se basear na busca
  // mais recente, que é a que realmente está em offered_slots.
  if (listarHorariosToolCallIds.length > 1) {
    const staleIds = new Set(listarHorariosToolCallIds.slice(0, -1));
    for (const msg of workingMessages) {
      if (msg.role === "tool" && msg.tool_call_id && staleIds.has(msg.tool_call_id)) {
        msg.content =
          '{"note":"Resultado substituído por uma busca mais recente neste mesmo turn — NÃO use estes horários, use apenas os da ÚLTIMA chamada de listar_horarios."}';
      }
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
      modelTemperatures: ctx.modelTemperatures,
      enableCaching: ctx.model.startsWith("anthropic/"),
      toolChoice: "none",
    },
    (raw) => ResultSchema.parse(sanitizeStructuredAgentJson(raw)),
    ctx.fallbackModels,
  );

  totalTokensIn += finalResponse.tokensIn;
  totalTokensOut += finalResponse.tokensOut;
  totalCostUsd += finalResponse.costUsd;

  // Merge final do patch: o que o LLM declarou + o que veio de tools. O patch do
  // LLM é limpo de campos controlados pelo sistema (appointment_id etc.) — só
  // tools podem setá-los (impede agendamento/remarcação FORJADOS pelo modelo).
  const mergedPatch = mergeLeadDataPatch(
    accumulatedPatch as LeadData,
    stripNullishFields(
      stripLlmForbiddenFields((result.lead_data_patch ?? {}) as Record<string, unknown>),
    ) as Partial<LeadData>,
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
    (ctx.stage === "SLOT_OFFER" || ctx.stage === "NAME_COLLECT" || ctx.stage === "BOOKING")
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
      if (lateBooking.toolResult?.includes('"need_valid_name":true')) {
        invalidNameBlocked = true;
      }
      bookingValidationOnly =
        isValidationOnlyFailure(lateBooking.toolResult) || isGuardHoldFailure(lateBooking.toolResult);
      const lf = parseBookingFailure(lateBooking.toolResult);
      if (lf) {
        bookingFailureKind = lf.kind;
        lastBookingFailureResult = lateBooking.toolResult;
      }
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
            modelTemperatures: ctx.modelTemperatures,
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
          stripLlmForbiddenFields((cRes.lead_data_patch ?? {}) as Record<string, unknown>),
        ) as Partial<LeadData>,
      );
    }
  }

  // Persiste o MOTIVO da falha de agendamento no meta da mensagem, em QUALQUER
  // caminho (determinístico, tool-loop ou late booking) — não só no ramo de
  // confirmação falsa. Sem isto ficávamos cegos ao "por que" de uma falha
  // técnica: caso real (Costa Lima Recreio, Osiane 21 96678-6864) escalou por
  // falha técnica e nenhuma mensagem guardou o erro real da API.
  if (bookingGuardHold) mergedTelemetry.booking_guard_hold = bookingGuardHold;
  if (lastBookingFailureResult) {
    const em = lastBookingFailureResult.match(/"error"\s*:\s*"((?:[^"\\]|\\.)*)"/);
    const ek = lastBookingFailureResult.match(/"error_kind"\s*:\s*"([^"]+)"/);
    if (em && mergedTelemetry.booking_error == null) mergedTelemetry.booking_error = em[1].slice(0, 300);
    if (ek && mergedTelemetry.booking_error_kind == null) mergedTelemetry.booking_error_kind = ek[1];
    if (ctx.leadData.selected_slot_iso && mergedTelemetry.booking_failed_slot == null) {
      mergedTelemetry.booking_failed_slot = ctx.leadData.selected_slot_iso;
    }
  }

  // ── Nome inválido: pede o nome completo (nunca agenda com nome que não é nome) ──
  // O validador (LLM) rejeitou o "nome" (ex.: "Não, obrigado.", "Obrigado Deus
  // abençoe", apelido, frase). Substitui a resposta deterministicamente por um
  // pedido do nome completo — não agenda e não oferta horário.
  if (invalidNameBlocked && !ctx.leadData.appointment_id) {
    reply =
      "Só preciso confirmar o nome completo do paciente (nome e sobrenome) para finalizar o agendamento. Como devo registrar?";
    outStage = "NAME_COLLECT";
    // LIMPA o nome REJEITADO — senão ele persiste no lead_data e o nome real
    // nunca é recapturado (getMissingBookingFields o vê preenchido), travando o
    // NAME_COLLECT em loop. Caso real (21 97486-6018): name preso em "Tudo bem"
    // e a lead repetiu o nome dezenas de vezes sem efeito.
    const clearName = clearRejectedBookingName(ctx.leadData);
    ctx.leadData = mergeLeadDataPatch(ctx.leadData, clearName);
    outPatch = mergeLeadDataPatch(outPatch as LeadData, {
      ...clearName,
      appointment_id: undefined,
    });
    mergedTelemetry.invalid_name_blocked = true;
    if (Object.keys(clearName).length > 0) mergedTelemetry.rejected_name_cleared = true;
  }

  // ── Trava de confirmação falsa ────────────────────────────────────────────
  // Se houve tentativa de agendar NESTE turn mas NÃO há appointment_id, a criação
  // falhou. O modelo às vezes diz "agendado com sucesso" mesmo assim — aqui
  // sobrescrevemos deterministicamente. NUNCA confirmamos sem appointment_id.
  //
  // Distinção crítica (bug do caso 07/07): antes esta trava dizia SEMPRE "esse
  // horário acabou de ficar indisponível" e re-ofertava os offered_slots em cache
  // — que ainda continham o slot que ACABOU de falhar. Se a falha foi TÉCNICA (o
  // horário seguia livre, como validado na agenda), isso era mentira + auto-
  // contradição (re-ofertar as mesmas 10:00). Agora:
  //   conflict  → slot realmente ocupado: poda o slot ruim e reoferta OUTROS.
  //   technical → falha ao registrar: não mente; tenta de novo e, se persistir,
  //               escala para um humano concluir (sem loop de "já tento").
  const bookingAttempted = toolsCalled.some((t) =>
    [
      "criar_agendamento",
      "agendar_clinicorp",
      "agendar_google_calendar",
      "agendar_clinup",
      "agendar_clinic_experts",
    ].includes(t),
  );
  if (bookingAttempted && !ctx.leadData.appointment_id && !doubleBookingBlocked && !invalidNameBlocked) {
    // Falha de VALIDAÇÃO (campo obrigatório faltando/inválido, ex.:
    // child_birth_date rejeitado pelo preflight): não é conflito de horário
    // nem falha técnica de create — o horário nem chegou a ser tentado de
    // verdade. Caso real (08/07, Maple Bear Osasco, lead Ana Carolina): a
    // trava sobrescrevia SEMPRE com "esse horário acabou de ficar
    // indisponível", escondendo a causa real (data inválida) e reofertando
    // horários sem sentido — loop até precisar de humano. Aqui deixamos a
    // resposta do LLM (que já viu o motivo real no resultado da tool e foi
    // instruído a pedir o dado) em pé; só garante que ele não confirmou sem
    // appointment_id.
    if (bookingValidationOnly && !bookingFailureKind) {
      mergedTelemetry.booking_validation_only_blocked = true;
      if (outStage === "CONFIRMED") {
        outStage = "NAME_COLLECT";
        outPatch = { ...outPatch, appointment_id: undefined };
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

    const kind: BookingFailureKind = bookingFailureKind ?? "conflict";
    const failedIso = ctx.leadData.selected_slot_iso;
    mergedTelemetry.false_confirmation_blocked = true;
    mergedTelemetry.booking_failure_kind = kind;
    // Persiste o erro da tool no meta da mensagem (diagnóstico no banco).
    if (lastBookingFailureResult) {
      const em = lastBookingFailureResult.match(/"error"\s*:\s*"((?:[^"\\]|\\.)*)"/);
      if (em) mergedTelemetry.booking_error = em[1].slice(0, 300);
    }
    if (failedIso) mergedTelemetry.booking_failed_slot = failedIso;

    if (kind === "technical") {
      const techFailures = (ctx.leadData.booking_tech_failures ?? 0) + 1;
      if (techFailures >= MAX_BOOKING_TECH_RETRIES) {
        // Persistiu → escala para um humano finalizar (o slot segue reservável).
        reply = TECH_ESCALATE_REPLY;
        outStage = "ESCALATED";
        outPatch = {
          ...outPatch,
          appointment_id: undefined,
          escalation_reason: TECH_ESCALATION_REASON,
        };
        mergedTelemetry.booking_escalated_technical = true;
        console.error(
          `[scheduler] booking falhou (técnico x${techFailures}) conv=${ctx.conversationId} slot=${failedIso} — escalando p/ humano`,
        );
      } else {
        // Mantém o slot escolhido e os horários ofertados → retry no próximo turn.
        reply = TECH_RETRY_REPLY;
        outStage = "NAME_COLLECT";
        outPatch = {
          ...outPatch,
          appointment_id: undefined,
          booking_tech_failures: techFailures,
        };
        mergedTelemetry.booking_technical_retry = techFailures;
        console.warn(
          `[scheduler] booking falhou (técnico x${techFailures}) conv=${ctx.conversationId} slot=${failedIso} — retry no próximo turn`,
        );
      }
    } else {
      // CONFLITO real: poda o slot que falhou (nunca re-ofertá-lo) e oferece
      // OUTROS; se não sobrar nenhum, re-lista a agenda para trazer horários reais.
      let remaining = pruneOfferedSlot(ctx.leadData.offered_slots, failedIso);
      if (remaining.length === 0) {
        delete ctx.leadData.selected_slot_iso;
        ctx.leadData.offered_slots = [];
        const refresh = await execListarHorarios(ctx, undefined, ctx.leadData.selected_agenda);
        if (refresh.patch) {
          ctx.leadData = mergeLeadDataPatch(ctx.leadData, refresh.patch);
          outPatch = mergeLeadDataPatch(outPatch as LeadData, refresh.patch);
        }
        toolsCalled.push("listar_horarios");
        remaining = pruneOfferedSlot(ctx.leadData.offered_slots, failedIso);
      }
      reply = buildConflictReply(remaining);
      outStage = "SLOT_OFFER";
      outPatch = {
        ...outPatch,
        appointment_id: undefined,
        selected_slot_iso: CLEARED_SLOT,
        offered_slots: remaining,
      };
      console.warn(
        `[scheduler] confirmação falsa bloqueada (conflito) conv=${ctx.conversationId} slot=${failedIso}`,
      );
    }
  }

  // ── Trava de remarcação "fantasma" ────────────────────────────────────────
  // O guard acima só cobre criar_agendamento (família criar/agendar_*) tentado
  // E falho. Mas o LLM pode propor next_stage=CONFIRMED "fechando" uma NOVA
  // data/hora (selected_slot_iso ≠ booked_slot_iso) sem ter chamado
  // remarcar_agendamento NEM criar_agendamento neste turn — a agenda real
  // (Clinicorp/GCal) continua no horário ANTIGO e o lead acredita ter um
  // horário que não existe. Caso real (Clínica Bomfim, 09/07): o agente disse
  // "Fechado, reservado para quarta-feira 15/07 às 15h30!" com tools_called=[]
  // — o Clinicorp manteve o agendamento de hoje 15h, nunca cancelado/remarcado.
  const rescheduleAttempted = toolsCalled.some((t) =>
    ["remarcar_agendamento", "reagendar", "reagendar_agendamento"].includes(t),
  );
  const claimedSlot = (ctx.leadData.selected_slot_iso ?? "").trim();
  const bookedSlot = (ctx.leadData.booked_slot_iso ?? "").trim();
  const phantomReschedule =
    outStage === "CONFIRMED" &&
    !!ctx.leadData.appointment_id &&
    !!bookedSlot &&
    !!claimedSlot &&
    claimedSlot !== bookedSlot &&
    !bookingAttempted &&
    !rescheduleAttempted;
  if (phantomReschedule) {
    console.warn(
      `[scheduler] remarcação fantasma bloqueada conv=${ctx.conversationId} — agendado=${bookedSlot} confirmado_no_texto=${claimedSlot}`,
    );
    mergedTelemetry.phantom_reschedule_blocked = true;
    reply =
      "Pra eu garantir essa mudança certinho na agenda, me confirma de novo a nova data e horário que você prefere? Assim já registro a remarcação. 😊";
    outStage = "SLOT_OFFER";
    // "" (não undefined/booked_slot_iso): precisa ser um valor não-nulo pra
    // sobreviver ao stripNullishFields no merge do orquestrador (que descarta
    // null/undefined como "sem mudança") e realmente LIMPAR o campo — "" é
    // falsy, então nenhum override de stage-signals.ts (que testa apenas
    // truthiness de selected_slot_iso) volta a empurrar o stage pra CONFIRMED.
    // Resetar para booked_slot_iso (valor "verdadeiro") reabria esse caminho.
    outPatch = { ...outPatch, selected_slot_iso: "" };
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
