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
  findClinicorpPatient,
  type ClinicorpSlot,
} from "@/lib/tools/clinicorp.server";
import {
  listGoogleCalendarSlots,
  createGoogleCalendarEvent,
  findGoogleCalendarEventsByPhone,
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
import {
  callLlmWithFallback,
  callLlmStructuredWithFallback,
  type LlmMessage,
  type LlmTool,
} from "./llm.server";
import { decideRagNeed } from "./rag-gate.server";
import { buildOwnerStylePromptBlock } from "./owner-style-prompt.server";
import {
  buildBookingFieldsPromptBlock,
  defaultCommitmentQuestion,
  getBookingFields,
  getMissingBookingFields,
  isCommitmentRequired,
  isReadyForBooking,
  mergeLeadDataPatch,
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
  if (ctx.dryRun) return;
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

const ResultSchema = z.object({
  reply: z.string().min(1, "Reply não pode ser vazio"),
  // next_stage opcional — fallback aplicado no runSchedulerAgent (mantém stage atual).
  next_stage: z.enum(VALID_STAGES).optional(),
  lead_data_patch: z
    .object({
      name: z.string().nullish(),
      selected_slot_iso: z.string().nullish(),
      dentist_person_id: z.number().nullish(),
      commitment_confirmed: z.boolean().nullish(),
      patient_id: z.number().nullish(),
      appointment_id: z.union([z.number(), z.string()]).nullish(),
      notes: z.string().nullish(),
      escalation_reason: z.string().nullish(),
      custom_fields: z.record(z.string()).nullish(),
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
        "Lista horários disponíveis para os próximos 7 dias na agenda da clínica (Clinicorp OU Google Calendar, conforme integração ativa da conta). " +
        "Use quando precisar oferecer slots ao lead (stage SLOT_OFFER). " +
        "Retorna lista com no máximo 6 horários alinhados à duração da consulta configurada. " +
        "Aliases reconhecidos (caso o prompt mencione): listar_horarios_clinicorp, listar_horarios_google_calendar, listar_horarios_clinup.",
      parameters: {
        type: "object",
        properties: {
          dias_a_frente: {
            type: "integer",
            description: "Número de dias à frente para buscar (default 7).",
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

// ── Execução das tools ─────────────────────────────────────────────────────

interface ToolOutcome {
  result: string;
  patch?: Partial<LeadData>;
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
        }),
        patch: { appointment_id: next.id },
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

async function execListarHorarios(
  ctx: AgentContext,
  diasAFrente?: number,
): Promise<ToolOutcome> {
  const today = new Date();
  const end = new Date(today.getTime() + (diasAFrente ?? 7) * 24 * 60 * 60 * 1000);

  // Google Calendar: usa lógica de janelas com expediente da clínica
  if (ctx.integrations.googleCalendar) {
    const duracao = Number(ctx.agentSettings.duracao_consulta_minutos ?? "40") || 40;
    // Granularidade IGUAL à duração → slots não sobrepostos. Ex: duração 30 min
    // gera 08:00, 08:30, 09:00, 09:30... Duração 40 min gera 08:00, 08:40, 09:20...
    const slots = await listGoogleCalendarSlots(ctx.accountId, {
      periodoInicio: today.toISOString(),
      periodoFim: end.toISOString(),
      tamanhoJanelaMinutos: duracao,
      granularidade: duracao,
      amostras: 6,
      businessHoursJson: ctx.agentSettings.business_hours_json,
    });
    const formatted = slots.map(formatGCalSlot);

    // Quando vier vazio, devolve diagnostico p/ o LLM decidir bem
    // (ex: pedir pra suporte, sugerir janela maior, etc.) e nao alucinar.
    if (formatted.length === 0) {
      const hasBusinessHours = !!(ctx.agentSettings.business_hours_json?.trim());
      const diag = {
        count: 0,
        slots: [],
        debug: {
          duracao_consulta_min: duracao,
          dias_consultados: diasAFrente ?? 7,
          tem_horario_funcionamento: hasBusinessHours,
          possivel_causa: !hasBusinessHours
            ? "Horario de funcionamento da clinica nao esta configurado nas Settings."
            : "Todos os horarios no periodo consultado estao ocupados na agenda Google. Tente um periodo maior OU verifique se a clinica realmente tem disponibilidade.",
        },
      };
      console.warn("[scheduler] listar_horarios retornou 0 slots:", diag.debug);
      return {
        result: JSON.stringify(diag),
        patch: { offered_slots: [] },
      };
    }

    return {
      result: JSON.stringify({ count: formatted.length, slots: formatted }),
      patch: { offered_slots: formatted },
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

async function execCriarAgendamento(ctx: AgentContext): Promise<ToolOutcome> {
  const ld = ctx.leadData;
  const bookingFields = getBookingFields(ctx.agentSettings);
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
  if (!ctx.effectivePhone) {
    return { result: JSON.stringify({ ok: false, error: "telefone ausente" }) };
  }

  const bookingCtx: AgentContext = {
    ...ctx,
    leadData: { ...ld, name: leadName },
  };

  // Google Calendar
  if (ctx.integrations.googleCalendar) {
    try {
      const duracao = Number(ctx.agentSettings.duracao_consulta_minutos ?? "40") || 40;
      const { titulo, descricao } = resolveGcalEventTemplates(bookingCtx);
      const ev = await createGoogleCalendarEvent(ctx.accountId, {
        eventoInicio: ld.selected_slot_iso,
        duracaoMinutos: duracao,
        titulo,
        descricao,
        telefone: ctx.effectivePhone,
      });
      await applyBookedTagSwap(ctx);
      return {
        result: JSON.stringify({
          ok: true,
          appointment_id: ev.id,
          datetime: ev.start,
          calendar_event_link: ev.htmlLink,
        }),
        patch: { appointment_id: ev.id, name: leadName, booked_tag_applied: true },
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
      phone: ctx.effectivePhone,
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

// ── Prompts (separados em cached + dynamic) ───────────────────────────────

function buildCachedSystemPrompt(ctx: AgentContext): string {
  const s = ctx.agentSettings;
  const orgLabel = s.company_name?.trim() || "empresa";
  const appointmentLabel = s.appointment_type_label?.trim() || "Consulta";
  const commitmentQ = defaultCommitmentQuestion(s);
  const commitmentEnabled = isCommitmentRequired(s) && !!commitmentQ;
  const bookingFields = getBookingFields(s);
  const fieldsBlock = buildBookingFieldsPromptBlock(bookingFields, ctx.leadData);

  return `Você é ${s.assistant_name || "a assistente"}, ${s.assistant_role || "atendente virtual"} da ${orgLabel}.

Você está no MÓDULO DE AGENDAMENTO. Seu objetivo é converter um lead já qualificado em um ${appointmentLabel.toLowerCase()} agendado — com o mínimo de fricção.

# ESTÁGIOS QUE VOCÊ OPERA

- **SLOT_OFFER**: ofereça no máximo 2 horários ao lead. SEMPRE use a tool listar_horarios primeiro. Nunca invente horários.
- **NAME_COLLECT**: confirme o slot escolhido. Colete os campos obrigatórios abaixo (UM por mensagem).${commitmentEnabled ? ` Depois de todos os campos, pergunte compromisso: "${commitmentQ}"` : " Não pergunte sobre dentista/médico — use linguagem do negócio (visita, reunião, etc.)."}
- **BOOKING**: o sistema tenta criar o agendamento automaticamente. Se criar_agendamento retornar ok=true, confirme ao lead e use next_stage="CONFIRMED". Se ok=false, NÃO diga que agendou — peça desculpas e ofereça outro horário.
- **CONFIRMED**: só após appointment_id em lead_data (evento criado na agenda). Agradeça e encerre.

${fieldsBlock}

# REGRAS ABSOLUTAS

1. NUNCA diga "vou verificar", "estou consultando", "já te retorno" — chame a tool de verdade.
2. NUNCA invente horários, IDs ou nomes. Use APENAS valores das tools.
3. UMA pergunta por vez. Mensagens curtas. Use \\n\\n no reply para separar bolhas no WhatsApp.
4. NUNCA use "dentista" ou "consulta odontológica" se o contexto for escola/educação — use "${appointmentLabel}" e linguagem do prompt do proprietário.
5. Se o lead pedir explicitamente para falar com humano → next_stage="ESCALATED".
6. **NUNCA diga "agendei", "marquei" ou "está confirmado" sem appointment_id em lead_data** (ok=true de criar_agendamento).
7. Se o lead já tem appointment_id em lead_data → next_stage="CONFIRMED" e agradeça.
8. Se buscar_paciente retornar found=true e name combinar, confirme o nome com o lead ANTES de prosseguir.

# FORMATO DE SAÍDA OBRIGATÓRIO

Responda APENAS em JSON válido:
{
  "reply": "mensagem a enviar ao lead (emojis permitidos se o proprietário pedir)",
  "next_stage": "SLOT_OFFER" | "NAME_COLLECT" | "BOOKING" | "CONFIRMED" | "ESCALATED",
  "lead_data_patch": { ...campos aprendidos neste turn... },
  "reasoning": "1 frase explicando sua decisão (não vai para o lead)"
}

Campos válidos em lead_data_patch:
- name (string): nome do responsável / lead
- custom_fields (object): campos extras { "child_name": "...", "child_birth_date": "...", "guardians": "..." }
- selected_slot_iso (string): ISO do slot escolhido (copie do offered_slots)
- dentist_person_id (number): copie do offered_slots correspondente (Clinicorp)
- commitment_confirmed (boolean): true quando o lead confirma compromisso
- patient_id (number): do retorno de buscar_paciente
- appointment_id (string|number): do retorno de criar_agendamento
- notes (string): observações relevantes para a agenda

# DADOS DO NEGÓCIO

- Endereço: ${s.company_address || "(não informado)"}
- Horário de funcionamento: ${s.business_hours || "(não informado)"}
- Profissional / referência: ${s.doctor_name || s.contact_person_name || "(não informado)"}

${buildOwnerStylePromptBlock()}

${ctx.basePrompt ? `\n# INSTRUÇÕES ADICIONAIS DO PROPRIETÁRIO\n\n${ctx.basePrompt}` : ""}`;
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

  return `# ESTADO ATUAL

- Agora (BRT): ${dateStr}
- Stage corrente: ${ctx.stage}
- Telefone do lead: ${ctx.effectivePhone ?? "(sem telefone WhatsApp confirmado)"}
- Canal: ${ctx.channel}
${ctx.helenaContact?.utm.content ? `- UTM Content: ${ctx.helenaContact.utm.content}` : ""}

# LEAD_DATA ACUMULADO

${JSON.stringify(
  {
    name: ld.name ?? null,
    custom_fields: ld.custom_fields ?? null,
    interest: ld.interest ?? null,
    selected_slot_iso: ld.selected_slot_iso ?? null,
    dentist_person_id: ld.dentist_person_id ?? null,
    commitment_confirmed: ld.commitment_confirmed ?? false,
    patient_id: ld.patient_id ?? null,
    appointment_id: ld.appointment_id ?? null,
  },
  null,
  2,
)}

${(() => {
  const missing = getMissingBookingFields(getBookingFields(ctx.agentSettings), ld);
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

${offeredSlotsText ? `# SLOTS JÁ OFERECIDOS NESTE CICLO\n${offeredSlotsText}\n` : ""}`;
}

function hasBookingIntegration(ctx: AgentContext): boolean {
  return ctx.integrations.googleCalendar || ctx.integrations.clinicorp || ctx.integrations.clinup;
}

async function tryDeterministicBooking(ctx: AgentContext): Promise<{
  patch: Partial<LeadData>;
  toolResult?: string;
  toolsCalled: string[];
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

  const ready = isReadyForBooking(ctx.leadData, ctx.agentSettings, {
    hasPhone: !!ctx.effectivePhone,
    hasBookingIntegration: hasBookingIntegration(ctx),
  });
  if (!ready) return { patch: slotPatch, toolsCalled: [] };

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
    const refresh = await execListarHorarios(ctx, 14);
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

  const autoBooking = await tryDeterministicBooking(ctx);
  let accumulatedPatch: Partial<LeadData> = autoBooking.patch;
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
  const toolsCalled: string[] = [...autoBooking.toolsCalled];
  let totalTokensIn = 0;
  let totalTokensOut = 0;
  let totalCostUsd = 0;

  // Loop de tools: GPT-4.1 mini (toolModel) — Gemini costuma falhar em function calling.
  // Resposta final ao lead continua em ctx.model (Gemini Flash Lite).
  for (let loop = 0; loop < MAX_TOOL_LOOPS; loop++) {
    const turn = await callLlmWithFallback(ctx.orKey, {
      model: ctx.toolModel,
      systemCached: cached,
      systemDynamic: dynamic,
      messages: workingMessages,
      tools: SCHEDULER_TOOLS,
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
            outcome = await execListarHorarios(ctx, args.dias_a_frente as number | undefined);
            break;
          case "criar_agendamento":
          case "agendar_clinicorp":
          case "agendar_google_calendar":
          case "agendar_clinup":
            outcome = await execCriarAgendamento(ctx);
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

  return {
    reply: result.reply,
    next_stage: finalStage,
    lead_data_patch: mergedPatch,
    reasoning: result.reasoning,
    tools_called: toolsCalled,
    tokens_in: totalTokensIn,
    tokens_out: totalTokensOut,
    cost_usd: totalCostUsd,
  };
}
