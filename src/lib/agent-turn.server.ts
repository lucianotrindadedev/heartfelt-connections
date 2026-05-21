// Executa um turno do agente com tool use loop + message splitting.
import { getSelfhost } from "@/integrations/selfhost/client.server";
import { decryptValue } from "@/lib/crypto.server";
import {
  normalizeBrazilPhone,
  resolveEffectivePhone,
  type ConversationChannel,
} from "@/lib/conversation-channel.server";
import {
  loadHelenaAccount,
  loadHelenaContactFromSession,
  sendHelenaText,
  updateHelenaContactPhone,
  type HelenaContact,
} from "@/lib/helena.server";
import { enqueueMessage } from "@/lib/message-queue.server";
import { splitMessage, typingDelayMs } from "@/lib/message-splitter.server";
import { buildToolsForAccount, type ToolDefinition } from "@/lib/tools/tool-registry.server";
import { listGoogleCalendarSlots, createGoogleCalendarEvent } from "@/lib/tools/google-calendar.server";
import {
  listClinicorpSlots,
  createClinicorpAppointment,
  findClinicorpPatient,
  listClinicorpPatientAppointments,
  cancelClinicorpAppointment,
} from "@/lib/tools/clinicorp.server";
import {
  listClinupSlotsRange,
  createClinupAppointment,
  findClinupPatient,
  getClinupAppointments,
  manageClinupAppointment,
} from "@/lib/tools/clinup.server";
import { escalateToHuman } from "@/lib/tools/escalate-human.server";

const MAX_HISTORY = 50;
const MAX_TOOL_LOOPS = 8;
const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const OPENROUTER_TIMEOUT_MS = 90_000;
/** Lock preso após crash/timeout da função serverless. */
const STALE_LOCK_MS = 4 * 60 * 1000;

export class ConversationLockedError extends Error {
  constructor(conversationId: string) {
    super(`Conversa ${conversationId} com turno em andamento`);
    this.name = "ConversationLockedError";
  }
}

function fetchOpenRouter(
  orKey: string,
  body: Record<string, unknown>,
): Promise<Response> {
  return fetch(OPENROUTER_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${orKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(OPENROUTER_TIMEOUT_MS),
  });
}

async function clearStaleConversationLock(conversationId: string): Promise<void> {
  const sb = getSelfhost();
  const { data } = await sb
    .from("conversation_state")
    .select("lock_conversa, atualizado_em")
    .eq("conversation_id", conversationId)
    .maybeSingle();

  if (!data?.lock_conversa) return;

  const updatedAt = data.atualizado_em
    ? new Date(data.atualizado_em as string).getTime()
    : 0;
  if (Date.now() - updatedAt < STALE_LOCK_MS) return;

  console.warn(
    `[agent] lock obsoleto em ${conversationId} (>${STALE_LOCK_MS / 1000}s) — liberando`,
  );
  await sb
    .from("conversation_state")
    .upsert({ conversation_id: conversationId, lock_conversa: false }, { onConflict: "conversation_id" });
}

interface MsgRow {
  role: string;
  content: string | null;
  meta: Record<string, unknown> | null;
}

interface OpenRouterMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

interface OpenRouterResponse {
  choices?: {
    message?: {
      content?: string | null;
      tool_calls?: ToolCall[];
    };
    finish_reason?: string;
  }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

async function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

const TURN_ERROR_USER_MESSAGE =
  "Desculpe, tive uma instabilidade ao consultar os horários. Pode me enviar \"ok\" de novo em alguns segundos?";

// Mensagens em que o modelo "promete" verificar algo SEM ter chamado nenhuma
// ferramenta — sintoma de hallucination em vez de tool calling real.
const STALL_PATTERNS: RegExp[] = [
  /\bestou verificando\b/i,
  /\bvou verificar\b/i,
  /\bvou conferir\b/i,
  /\bvou checar\b/i,
  /\bdeixa eu (?:verificar|conferir|checar|olhar)\b/i,
  /\bj[áa] (?:te |lhe )?retorno\b/i,
  /\bj[áa] j[áa] (?:te |lhe )?(?:respondo|retorno)\b/i,
  /\bum momento(?:,| -)? (?:vou|estou)/i,
  /\baguarde um (?:instante|momento)/i,
  /\best[aá]?(?:rei)? consultando\b/i,
  /\best[aá]?(?:rei)? buscando\b/i,
];

function isStallResponse(text: string): boolean {
  if (!text || text.length < 6) return false;
  return STALL_PATTERNS.some((re) => re.test(text));
}

function collectToolContents(messages: OpenRouterMessage[]): string[] {
  return messages
    .filter((m) => m.role === "tool" && m.content)
    .map((m) => m.content as string);
}

function formatSlotLine(line: string): string {
  const dt = line.match(/\(([^)]+)\)/)?.[1];
  if (dt) return dt;
  const date = line.match(/data=([^\s|]+)/)?.[1] ?? "";
  const from = line.match(/fromTime=([^\s|]+)/)?.[1] ?? "";
  return `${date} às ${from}`.trim();
}

/** Resposta determinística quando o LLM não finaliza após tools. */
function buildReplyFromToolResults(toolContents: string[]): string | null {
  if (!toolContents.length) return null;

  for (let i = toolContents.length - 1; i >= 0; i--) {
    const t = toolContents[i];
    if (t.startsWith("Erro ao executar listar_horarios")) {
      return "Não consegui consultar a agenda online neste momento. Pode me dizer qual dia da semana prefere? Assim tento de novo para você.";
    }
    if (t.startsWith("Erro ao executar agendar_clinicorp")) {
      return "O horário escolhido pode ter sido preenchido agora. Quer que eu consulte a agenda de novo e te passe outras opções?";
    }
    if (t.startsWith("Erro ao executar")) {
      return "Tive um problema técnico ao acessar o sistema da clínica. Pode me confirmar seu nome completo para eu tentar novamente?";
    }
  }

  const apptOk = [...toolContents]
    .reverse()
    .find((t) => t.includes("Consulta agendada com sucesso") || t.includes("Agendamento criado com sucesso"));
  if (apptOk) return apptOk;

  const slotsMsg = [...toolContents]
    .reverse()
    .find(
      (t) =>
        t.includes("Horários disponíveis no Clinicorp") ||
        t.includes("Horários disponíveis no Clinup") ||
        t.includes("Horários disponíveis no Google Calendar"),
    );

  if (slotsMsg) {
    if (slotsMsg.includes("Nenhum horário disponível")) {
      return "Consultei a agenda e, neste período, não há horários livres. Qual outro dia da semana ficaria melhor para você?";
    }
    const lines = slotsMsg.split("\n").filter((l) => l.trim().startsWith("- "));
    if (!lines.length) {
      return "Consultei a agenda, mas não encontrei horários livres para oferecer agora. Qual outro dia ficaria melhor?";
    }
    const a = formatSlotLine(lines[0]);
    const b = lines[1] ? formatSlotLine(lines[1]) : null;
    if (b && b !== a) {
      return `Consultei a agenda e tenho estas opções para sua consulta:\n\n• ${a}\n• ${b}\n\nQual horário prefere?`;
    }
    return `Consultei a agenda e tenho disponível: ${a}. Posso reservar esse horário para você?`;
  }

  const patientMsg = [...toolContents]
    .reverse()
    .find((t) => t.includes("Paciente encontrado") || t.includes("Paciente não encontrado"));
  if (patientMsg?.includes("Paciente encontrado")) {
    const name = patientMsg.match(/Nome:\s*([^|]+)/)?.[1]?.trim();
    if (name) {
      return `Encontrei seu cadastro como ${name}. Vou consultar os horários disponíveis — qual dia da semana fica melhor para você?`;
    }
  }

  return null;
}

async function forceFinalReplyAfterTools(
  orKey: string,
  model: string,
  messages: OpenRouterMessage[],
  maxTokens: number,
  temperature: number,
): Promise<string> {
  const res = await fetchOpenRouter(orKey, {
    model,
    messages: [
      ...messages,
      {
        role: "user",
        content:
          "Com base SOMENTE nos resultados das ferramentas já executadas acima, escreva a resposta final ao paciente em português. " +
          "Se a ferramenta listou horários, ofereça no máximo 2 opções com data e hora exatos do retorno. " +
          "NÃO diga que vai verificar, conferir ou retornar depois — a agenda já foi consultada.",
      },
    ],
    max_tokens: maxTokens,
    temperature,
    tool_choice: "none",
  });
  if (!res.ok) return "";
  const json = (await res.json()) as OpenRouterResponse;
  return json.choices?.[0]?.message?.content?.trim() ?? "";
}

async function deliverAgentReply(params: {
  accountId: string;
  agentId: string;
  conversationId: string;
  model: string;
  text: string;
  sessionId?: string;
  phone?: string;
  tokensIn?: number;
  tokensOut?: number;
  latencyMs?: number;
  /** true se a mensagem veio de buildReplyFromToolResults (fallback determinístico). */
  fallback?: boolean;
}): Promise<void> {
  const sb = getSelfhost();
  await sb.from("agent_runs").insert({
    account_id: params.accountId,
    agent_id: params.agentId,
    conversation_id: params.conversationId,
    provider: "openrouter",
    model: params.model,
    latency_ms: params.latencyMs ?? null,
    tokens_in: params.tokensIn ?? null,
    tokens_out: params.tokensOut ?? null,
  });

  const meta: Record<string, unknown> = { origem: "agente", model: params.model };
  if (params.fallback) meta.fallback = true;

  await sb.from("messages").insert({
    conversation_id: params.conversationId,
    role: "assistant",
    content: params.text,
    meta,
  });

  const helena = await loadHelenaAccount(params.accountId);
  const parts = await splitMessage(params.text, params.accountId);
  for (let i = 0; i < parts.length; i++) {
    if (i > 0) await delay(typingDelayMs(parts[i]));
    const sendRes = await sendHelenaText(helena, {
      phone: params.phone,
      text: parts[i],
      sessionId: params.sessionId,
    });
    if (!sendRes.ok) {
      console.error(`[helena] envio falhou ${sendRes.status}: ${sendRes.body.slice(0, 200)}`);
    }
  }
}

// ── Contexto de data/hora (America/Sao_Paulo, pt-BR) ───────────────────────

function buildDateContext(): string {
  const TZ = "America/Sao_Paulo";
  const now = new Date();
  const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const tomorrow  = new Date(now.getTime() + 24 * 60 * 60 * 1000);

  function fmt(date: Date, includeTime: boolean): string {
    const p = new Intl.DateTimeFormat("pt-BR", {
      weekday: "long",
      day:     "2-digit",
      month:   "2-digit",
      year:    "numeric",
      ...(includeTime
        ? { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }
        : {}),
      timeZone: TZ,
    }).formatToParts(date);

    const get = (type: string) => p.find((x) => x.type === type)?.value ?? "";

    const weekday   = get("weekday");
    const day       = get("day");
    const monthNum  = get("month");
    const year      = get("year");
    const monthName = new Intl.DateTimeFormat("pt-BR", {
      month: "long",
      timeZone: TZ,
    }).format(date);

    let out = `${weekday} - ${day}/${monthNum}/${year} - ${day} de ${monthName} de ${year}`;
    if (includeTime) {
      out += ` - ${get("hour")}:${get("minute")}:${get("second")}`;
    }
    return out;
  }

  return [
    "<informacoes-sistema>",
    `Ontem foi ${fmt(yesterday, false)}`,
    `Hoje é ${fmt(now, true)}`,
    `Amanhã é ${fmt(tomorrow, false)}`,
    "</informacoes-sistema>",
  ].join("\n");
}

// ── Contexto do lead (Helena contact) ─────────────────────────────

const CHANNEL_LABELS: Record<ConversationChannel, string> = {
  whatsapp: "WhatsApp",
  instagram: "Instagram",
  messenger: "Messenger",
  unknown: "Canal desconhecido",
};

function buildLeadContext(
  contact: HelenaContact | null,
  channel: ConversationChannel,
  effectivePhone: string | null,
): string {
  const lines: string[] = [`Canal de atendimento: ${CHANNEL_LABELS[channel]}`];

  if (effectivePhone) {
    lines.push(`Telefone para agendamento (WhatsApp): ${effectivePhone}`);
  } else if (channel === "instagram" || channel === "messenger") {
    lines.push(
      "Telefone para agendamento: PENDENTE — peça o WhatsApp com DDD antes de usar ferramentas de agendamento no Clinicorp/Clinup.",
    );
  } else {
    lines.push("Telefone para agendamento: não identificado");
  }

  if (contact) {
    lines.push(`Nome: ${contact.name || "Desconhecido"}`);
    if (contact.instagram) lines.push(`Instagram ID: ${contact.instagram}`);
    if (contact.messengerId) lines.push(`Messenger ID: ${contact.messengerId}`);

    const utmContent = contact.utm.content?.trim();
    if (utmContent) lines.push(`UTM Content (interesse principal): ${utmContent}`);
    if (contact.utm.source) lines.push(`UTM Source: ${contact.utm.source}`);
    if (contact.utm.medium) lines.push(`UTM Medium: ${contact.utm.medium}`);
    if (contact.utm.campaign) lines.push(`UTM Campaign: ${contact.utm.campaign}`);

    if (contact.tagNames.length > 0) {
      lines.push(`Tags atuais: ${contact.tagNames.join(", ")}`);
    }
  }

  return `<informacoes-lead>\n${lines.join("\n")}\n</informacoes-lead>`;
}

function schedulingPhoneError(channel: ConversationChannel): string {
  if (channel === "instagram" || channel === "messenger") {
    return "Telefone WhatsApp ainda não informado. Peça o número com DDD ao paciente e use salvar_telefone_lead antes de agendar.";
  }
  return "Telefone do paciente não disponível para agendamento.";
}

function pickToolPhone(
  args: Record<string, unknown>,
  effectivePhone: string | null,
): string | null {
  const fromArg = normalizeBrazilPhone(args.telefone as string | undefined);
  return fromArg ?? effectivePhone;
}

interface ToolContext {
  accountId: string;
  agentId: string;
  conversationId: string;
  conversationPhone: string;
  /** Mutável — atualizado por salvar_telefone_lead no mesmo turno. */
  effectivePhone: string | null;
  channel: ConversationChannel;
  sessionId?: string;
  helenaContactId?: string;
  contactName?: string;
}

async function executeTool(
  toolName: string,
  args: Record<string, unknown>,
  context: ToolContext,
): Promise<string> {
  try {
    switch (toolName) {
      case "salvar_telefone_lead": {
        const phone = normalizeBrazilPhone(args.telefone as string);
        if (!phone) {
          return "Telefone inválido. Informe DDD + número com 10 ou 11 dígitos (ex: 11988776655).";
        }
        const sb = getSelfhost();
        await sb
          .from("conversations")
          .update({ lead_phone: phone })
          .eq("id", context.conversationId);

        if (context.helenaContactId) {
          const helena = await loadHelenaAccount(context.accountId);
          const nome = (args.nome as string | undefined) ?? context.contactName;
          const upd = await updateHelenaContactPhone(
            helena,
            context.helenaContactId,
            phone,
            nome,
          );
          if (!upd.ok) {
            console.warn(`[helena] atualizar telefone contato: ${upd.status} ${upd.body.slice(0, 200)}`);
          }
        }

        context.effectivePhone = phone;
        return `Telefone ${phone} salvo com sucesso. Pode usar as ferramentas de agendamento com este número.`;
      }
      case "listar_horarios_google_calendar": {
        const slots = await listGoogleCalendarSlots(
          context.accountId,
          args.de as string,
          args.ate as string,
        );
        if (!slots.length) return "Nenhum horário disponível no período informado.";
        return (
          "Horários disponíveis:\n" +
          slots
            .slice(0, 10)
            .map((s) => `- ${new Date(s.start).toLocaleString("pt-BR")}`)
            .join("\n")
        );
      }

      case "agendar_google_calendar": {
        const phone = pickToolPhone(args, context.effectivePhone);
        if (!phone) return schedulingPhoneError(context.channel);
        const event = await createGoogleCalendarEvent(context.accountId, {
          summary: args.titulo as string,
          description: args.descricao as string | undefined,
          phone,
          start: args.inicio as string,
          end: args.fim as string,
        });
        return `Agendamento criado com sucesso! ID: ${event.id}`;
      }

      case "buscar_paciente_clinicorp": {
        const phone = pickToolPhone(args, context.effectivePhone);
        if (!phone) return schedulingPhoneError(context.channel);
        const patient = await findClinicorpPatient(context.accountId, phone);
        if (!patient?.id) {
          return "Paciente não encontrado no Clinicorp. Um novo cadastro será criado automaticamente ao agendar.";
        }
        return `Paciente encontrado: Nome: ${patient.name} | ID: ${patient.id} | Telefone: ${patient.phone}`;
      }

      case "listar_horarios_clinicorp": {
        const slots = await listClinicorpSlots(
          context.accountId,
          args.de as string,
          args.ate as string,
        );
        if (!slots.length) return "Nenhum horário disponível no Clinicorp no período informado.";
        return (
          "Horários disponíveis no Clinicorp (agenda online):\n" +
          slots
            .slice(0, 10)
            .map((s) => {
              const dt = new Date(s.start).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" });
              const dentPart = s.dentistPersonId
                ? ` | dentist_person_id=${s.dentistPersonId}`
                : "";
              return (
                `- data=${s.localDate} | fromTime=${s.fromTime} | toTime=${s.toTime}` +
                ` | horario_iso=${s.start} (${dt})${dentPart}`
              );
            })
            .join("\n") +
          "\n\nIMPORTANTE: Ao chamar agendar_clinicorp, use horario com horario_iso exato e dentist_person_id do slot. Os campos data/fromTime/toTime devem corresponder ao slot escolhido."
        );
      }

      case "agendar_clinicorp": {
        const phone = pickToolPhone(args, context.effectivePhone);
        if (!phone) return schedulingPhoneError(context.channel);
        const appt = await createClinicorpAppointment(context.accountId, {
          phone,
          name: args.nome as string,
          datetime: args.horario as string,
          dentistPersonId: args.dentist_person_id ? Number(args.dentist_person_id) : undefined,
        });
        return `Consulta agendada com sucesso para ${appt.patientName} em ${new Date(appt.datetime).toLocaleString("pt-BR")}!`;
      }

      case "buscar_agendamentos_clinicorp": {
        const phone = pickToolPhone(args, context.effectivePhone);
        if (!phone) return schedulingPhoneError(context.channel);
        const appts = await listClinicorpPatientAppointments(context.accountId, phone);
        if (!appts.length) {
          return "Nenhum agendamento encontrado para este paciente no Clinicorp.";
        }
        return (
          "Agendamentos encontrados:\n" +
          appts
            .map(
              (a) =>
                `- ID: ${a.id} | Data/hora: ${a.datetime ? new Date(a.datetime).toLocaleString("pt-BR") : "—"} | Status: ${a.status}${a.dentistName ? ` | Profissional: ${a.dentistName}` : ""}`,
            )
            .join("\n")
        );
      }

      case "cancelar_agendamento_clinicorp": {
        const result = await cancelClinicorpAppointment(
          context.accountId,
          args.agendamento_id as string,
          args.motivo as string | undefined,
        );
        return result.message;
      }

      case "clinup_buscar_horarios": {
        const slots = await listClinupSlotsRange(
          context.accountId,
          args.de as string,
          args.ate as string,
        );
        if (!slots.length) return "Nenhum horário disponível no Clinup no período informado.";
        return (
          "Horários disponíveis no Clinup:\n" +
          slots
            .slice(0, 10)
            .map((s) => `- ${new Date(s.start).toLocaleString("pt-BR")}`)
            .join("\n")
        );
      }

      case "clinup_agendar": {
        const phone = pickToolPhone(args, context.effectivePhone);
        if (!phone) return schedulingPhoneError(context.channel);
        const appt = await createClinupAppointment(context.accountId, {
          phone,
          name: args.nome as string,
          datetime: args.horario as string,
          notes: args.observacao as string | undefined,
        });
        return `Consulta agendada com sucesso para ${appt.patientName} em ${appt.datetime}!`;
      }

      case "clinup_buscar_consultas": {
        const phone = pickToolPhone(args, context.effectivePhone);
        if (!phone) return schedulingPhoneError(context.channel);
        const patient = await findClinupPatient(context.accountId, phone);
        if (!patient?.id) return "Paciente não encontrado no Clinup.";
        const consultas = await getClinupAppointments(context.accountId, patient.id);
        if (!consultas.length) return "Nenhuma consulta encontrada para este paciente.";
        return (
          "Consultas encontradas:\n" +
          consultas.map((c) => `- ID ${c.id}: ${c.date} ${c.time} — ${c.status}`).join("\n")
        );
      }

      case "clinup_gerir_consulta": {
        const ok = await manageClinupAppointment(context.accountId, {
          consultaId: args.consultaId as number,
          confirmada: args.confirmada as boolean,
          motivo: args.motivo as string | undefined,
        });
        if (ok) {
          return args.confirmada
            ? "Consulta confirmada com sucesso."
            : "Consulta cancelada/desmarcada com sucesso.";
        }
        return "Falha ao atualizar consulta. Tente novamente.";
      }

      case "helena_listar_tags": {
        const helena = await loadHelenaAccount(context.accountId);
        const res = await fetch(
          `${helena.baseUrl.replace(/\/$/, "")}/core/v1/tag`,
          { headers: { Authorization: `Bearer ${helena.token}`, accept: "application/json" } },
        );
        if (!res.ok) return `Erro ao listar tags: ${res.status}`;
        const json = (await res.json()) as unknown;
        return `Tags disponíveis: ${JSON.stringify(json).slice(0, 1000)}`;
      }

      case "helena_add_tags": {
        const helena = await loadHelenaAccount(context.accountId);
        let contactId = context.helenaContactId;
        if (!contactId && context.effectivePhone) {
          const contactRes = await fetch(
            `${helena.baseUrl.replace(/\/$/, "")}/core/v1/contact?phone=${encodeURIComponent(context.effectivePhone)}`,
            { headers: { Authorization: `Bearer ${helena.token}`, accept: "application/json" } },
          );
          if (!contactRes.ok) return `Erro ao buscar contato: ${contactRes.status}`;
          const contactJson = (await contactRes.json()) as
            | { id?: string | number }
            | { data?: { id?: string | number }[] }
            | null;
          contactId = String(
            (contactJson as { id?: string | number })?.id ??
              (contactJson as { data?: { id?: string | number }[] })?.data?.[0]?.id ??
              "",
          );
        }
        if (!contactId) return "Contato não encontrado no Helena para adicionar tags.";

        const tagRes = await fetch(
          `${helena.baseUrl.replace(/\/$/, "")}/core/v1/contact/${contactId}/tags`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${helena.token}`,
              accept: "application/json",
              "content-type": "application/*+json",
            },
            body: JSON.stringify({
              tagNames: args.tagNames as string[],
              operation: (args.operation as string) ?? "InsertIfNotExists",
            }),
          },
        );
        if (!tagRes.ok) return `Erro ao adicionar tags: ${tagRes.status}`;
        return `Tags aplicadas com sucesso: ${(args.tagNames as string[]).join(", ")}`;
      }

      case "escalar_humano": {
        const motivo = args.motivo as string | undefined;
        const resumo = args.resumo_conversa as string | undefined;
        await escalateToHuman({
          agentId: context.agentId,
          accountId: context.accountId,
          phone: context.effectivePhone ?? context.conversationPhone,
          sessionId: context.sessionId,
          helenaContactId: context.helenaContactId,
          reason: resumo ? `${motivo ?? ""}\n\nResumo: ${resumo}` : motivo,
        });
        return "Atendimento transferido para humano com sucesso.";
      }

      default:
        return `Ferramenta "${toolName}" não reconhecida.`;
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return `Erro ao executar ${toolName}: ${msg}`;
  }
}

export async function runAgentTurn(conversationId: string): Promise<void> {
  const sb = getSelfhost();

  // 1. Carrega contexto
  const conv = await sb
    .from("conversations")
    .select(
      "id, phone, helena_session_id, helena_contact_id, agent_id, channel, lead_phone",
    )
    .eq("id", conversationId)
    .single();
  if (conv.error || !conv.data) throw new Error("Conversa não encontrada");

  const agent = await sb
    .from("agents")
    .select("id, account_id, ativo, system_prompt, llm_model_override, debounce_segundos")
    .eq("id", conv.data.agent_id)
    .single();
  if (agent.error || !agent.data) throw new Error("Agente não encontrado");
  if (!agent.data.ativo) return;

  const accountId = agent.data.account_id as string;
  const agentId = agent.data.id as string;
  const conversationPhone = conv.data.phone as string;
  const sessionId = (conv.data.helena_session_id as string | null) ?? undefined;
  const channel = ((conv.data.channel as string) || "whatsapp") as ConversationChannel;
  const leadPhone = (conv.data.lead_phone as string | null) ?? null;
  let helenaContactId = (conv.data.helena_contact_id as string | null) ?? undefined;

  let contact: HelenaContact | null = null;
  if (sessionId) {
    try {
      const helena = await loadHelenaAccount(accountId);
      contact = await loadHelenaContactFromSession(helena, sessionId);
      if (contact?.id) helenaContactId = contact.id;
    } catch (e) {
      console.warn("[agent] falha ao carregar contato Helena:", e);
    }
  }

  const phoneResolved = resolveEffectivePhone({
    leadPhone,
    contactPhone: contact?.phoneNumber,
    conversationPhone,
  });
  let effectivePhone = phoneResolved.phone;

  await clearStaleConversationLock(conversationId);

  // 2. Verifica lock — turn concorrente: falha para a fila/agendador tentar de novo
  const stateCheck = await sb
    .from("conversation_state")
    .select("lock_conversa")
    .eq("conversation_id", conversationId)
    .maybeSingle();

  if (stateCheck.data?.lock_conversa) {
    const debounce = (agent.data.debounce_segundos as number | null) ?? 20;
    await enqueueMessage(conversationId, Math.min(5, debounce));
    console.log(`[agent] Conversa ${conversationId} bloqueada — reagendado em 5s`);
    throw new ConversationLockedError(conversationId);
  }

  const llm = await sb
    .from("account_llm_config")
    .select("default_model, max_tokens, temperature")
    .eq("account_id", accountId)
    .single();

  const secrets = await sb
    .from("account_secrets")
    .select("openrouter_api_key_enc")
    .eq("account_id", accountId)
    .single();
  if (!secrets.data?.openrouter_api_key_enc) {
    console.warn(`[agent] Sem chave OpenRouter para ${accountId}`);
    return;
  }

  const orKey = await decryptValue(secrets.data.openrouter_api_key_enc as unknown as string);
  if (!orKey) throw new Error("Falha ao descriptografar OpenRouter key");

  // 3. Adquire lock
  await sb
    .from("conversation_state")
    .upsert({ conversation_id: conversationId, lock_conversa: true }, { onConflict: "conversation_id" });

  // Marca o início do turno — usado para detectar mensagens novas durante o processamento.
  const turnStartedAt = new Date().toISOString();

  try {
    // 5. Histórico
    const msgs = await sb
      .from("messages")
      .select("role, content, meta")
      .eq("conversation_id", conversationId)
      .order("criado_em", { ascending: false })
      .limit(MAX_HISTORY);
    if (msgs.error) throw new Error(msgs.error.message);

    const ordered = (msgs.data ?? []).slice().reverse() as MsgRow[];

    const model =
      (agent.data.llm_model_override as string | null) ||
      (llm.data?.default_model as string | undefined) ||
      "google/gemini-2.5-flash";

    const basePrompt =
      (agent.data.system_prompt as string) || "Você é um assistente prestativo.";

    const leadBlock = buildLeadContext(contact, channel, effectivePhone);
    const systemPrompt = buildDateContext() + "\n" + leadBlock + "\n\n" + basePrompt;

    // 4. Carrega ferramentas disponíveis
    const tools = await buildToolsForAccount(accountId, agentId);

    const messages: OpenRouterMessage[] = [{ role: "system", content: systemPrompt }];
    for (const m of ordered) {
      // Filtra fallbacks determinísticos do histórico — eles foram entregues ao
      // usuário mas não devem ser vistos pela LLM (o modelo aprende a copiá-los
      // em vez de chamar a ferramenta real).
      if (m.meta && (m.meta as Record<string, unknown>).fallback === true) continue;
      if (m.role === "user") messages.push({ role: "user", content: m.content ?? "" });
      else if (m.role === "assistant") messages.push({ role: "assistant", content: m.content ?? "" });
    }

    let finalReply = "";
    let totalTokensIn = 0;
    let totalTokensOut = 0;
    let t0 = Date.now();
    let latencyMs = 0;
    let anyToolCalled = false;
    let forceToolNext = false;
    let emptyReplyFromTools = false;

    // 5. Tool use loop
    for (let loop = 0; loop < MAX_TOOL_LOOPS; loop++) {
      t0 = Date.now();

      const body: Record<string, unknown> = {
        model,
        messages,
        max_tokens: llm.data?.max_tokens ?? 1024,
        temperature: llm.data?.temperature ?? 0.7,
      };
      if (tools.length > 0) {
        body.tools = tools as unknown as ToolDefinition[];
        // Quando detectamos stall, força o modelo a chamar uma ferramenta.
        body.tool_choice = forceToolNext ? "required" : "auto";
      }
      forceToolNext = false;

      const orRes = await fetchOpenRouter(orKey, body);
      latencyMs = Date.now() - t0;

      if (!orRes.ok) {
        const errBody = await orRes.text();
        await sb.from("agent_runs").insert({
          account_id: accountId,
          agent_id: agentId,
          conversation_id: conversationId,
          provider: "openrouter",
          model,
          latency_ms: latencyMs,
          error: `${orRes.status}: ${errBody.slice(0, 500)}`,
        });
        throw new Error(`OpenRouter ${orRes.status}: ${errBody.slice(0, 200)}`);
      }

      const orJson = (await orRes.json()) as OpenRouterResponse;
      totalTokensIn += orJson.usage?.prompt_tokens ?? 0;
      totalTokensOut += orJson.usage?.completion_tokens ?? 0;

      const choice = orJson.choices?.[0];
      const assistantMsg = choice?.message;
      const finishReason = choice?.finish_reason;

      // Resposta vazia (sem message OU message vazio sem tool_calls) — comum
      // em modelos de reasoning (o1/o3/o4-mini) que estouram max_tokens na
      // fase de raciocínio interno antes de gerar o texto final.
      const hasContent =
        !!assistantMsg &&
        (!!(assistantMsg.content && assistantMsg.content.trim()) ||
          !!(assistantMsg.tool_calls && assistantMsg.tool_calls.length > 0));

      if (!hasContent) {
        console.warn(
          `[agent] resposta vazia do OpenRouter (model=${model}, finish_reason=${finishReason}, tokens_out=${orJson.usage?.completion_tokens})`,
        );
        // Se já executamos ferramentas neste turn, monta resposta determinística
        // a partir dos resultados — assim o lead recebe algo útil.
        if (anyToolCalled) {
          const toolContents = collectToolContents(messages);
          const fromTools = buildReplyFromToolResults(toolContents);
          if (fromTools) {
            console.log("[agent] usando resposta determinística após tools (LLM vazio)");
            finalReply = fromTools;
            emptyReplyFromTools = true;
            break;
          }
        }
        // Nenhuma tool executada e LLM vazio: tenta UMA vez forçando tool_choice
        // antes de desistir. Útil quando o reasoning consumiu todos os tokens.
        if (tools.length > 0 && !anyToolCalled && loop < MAX_TOOL_LOOPS - 1) {
          console.log("[agent] retry com tool_choice=required após resposta vazia");
          forceToolNext = true;
          continue;
        }
        throw new Error(
          `OpenRouter retornou resposta vazia (finish_reason=${finishReason})`,
        );
      }

      // Adiciona resposta ao histórico local
      messages.push({
        role: "assistant",
        content: assistantMsg.content ?? null,
        tool_calls: assistantMsg.tool_calls,
      });

      // Se tem tool_calls → executa ferramentas
      if (assistantMsg.tool_calls && assistantMsg.tool_calls.length > 0) {
        anyToolCalled = true;
        for (const tc of assistantMsg.tool_calls) {
          let toolArgs: Record<string, unknown> = {};
          try {
            toolArgs = JSON.parse(tc.function.arguments) as Record<string, unknown>;
          } catch {
            toolArgs = {};
          }

          const toolCtx: ToolContext = {
            accountId,
            agentId,
            conversationId,
            conversationPhone,
            effectivePhone,
            channel,
            sessionId,
            helenaContactId,
            contactName: contact?.name,
          };

          const toolResult = await executeTool(tc.function.name, toolArgs, toolCtx);
          effectivePhone = toolCtx.effectivePhone;
          console.log(
            `[agent] tool ${tc.function.name} → ${toolResult.slice(0, 180).replace(/\n/g, " ")}`,
          );

          messages.push({
            role: "tool",
            tool_call_id: tc.id,
            content: toolResult,
          });
        }
        // Continua o loop para obter resposta final
        continue;
      }

      // Resposta final (sem tool_calls)
      const candidate = assistantMsg.content?.trim() ?? "";

      // Stall sem tools: força tool_choice=required.
      // Stall COM tools já executadas: não entregar "vou verificar" — reabre o loop.
      if (tools.length > 0 && loop < MAX_TOOL_LOOPS - 1 && isStallResponse(candidate)) {
        if (!anyToolCalled) {
          console.log(
            `[agent] stall sem tools ("${candidate.slice(0, 60)}…") — tool_choice=required`,
          );
          messages.pop();
          forceToolNext = true;
          continue;
        }
        console.log(
          `[agent] stall após tools ("${candidate.slice(0, 60)}…") — ignorando e forçando resposta final`,
        );
        messages.pop();
        finalReply = "";
        break;
      }

      finalReply = candidate;
      break;
    }

    const maxTokens = llm.data?.max_tokens ?? 1024;
    const temperature = llm.data?.temperature ?? 0.7;
    const toolContents = collectToolContents(messages);
    let replyIsFallback = false;

    if (finalReply && anyToolCalled && isStallResponse(finalReply)) {
      finalReply = "";
    }

    if (!finalReply) {
      finalReply = buildReplyFromToolResults(toolContents) ?? "";
      if (finalReply) replyIsFallback = true;
    } else if (emptyReplyFromTools) {
      replyIsFallback = true;
    }

    if (!finalReply) {
      finalReply = await forceFinalReplyAfterTools(
        orKey,
        model,
        messages,
        maxTokens,
        temperature,
      );
    }

    if (!finalReply) {
      const toolSummary = toolContents.map((t) => t.slice(0, 100)).join(" || ");
      throw new Error(
        `Agente não gerou resposta final após ferramentas${toolSummary ? ` | tools: ${toolSummary.slice(0, 400)}` : ""}`,
      );
    }

    await deliverAgentReply({
      accountId,
      agentId,
      conversationId,
      model,
      text: finalReply,
      sessionId,
      phone: effectivePhone ?? conversationPhone,
      tokensIn: totalTokensIn,
      tokensOut: totalTokensOut,
      latencyMs,
      fallback: replyIsFallback,
    });
  } catch (turnError) {
    if (turnError instanceof ConversationLockedError) {
      throw turnError;
    }

    const errMsg = turnError instanceof Error ? turnError.message : String(turnError);
    console.error(`[agent] turn falhou ${conversationId}:`, errMsg);

    await sb.from("agent_runs").insert({
      account_id: accountId,
      agent_id: agentId,
      conversation_id: conversationId,
      provider: "openrouter",
      model:
        (agent.data.llm_model_override as string | null) ||
        "unknown",
      error: errMsg.slice(0, 500),
    });

    try {
      await deliverAgentReply({
        accountId,
        agentId,
        conversationId,
        model: "error-fallback",
        text: TURN_ERROR_USER_MESSAGE,
        sessionId,
        phone: effectivePhone ?? conversationPhone,
      });
    } catch (sendErr) {
      console.error("[agent] falha ao enviar mensagem de erro ao usuário:", sendErr);
    }
  } finally {
    // Libera o lock
    await sb
      .from("conversation_state")
      .upsert({ conversation_id: conversationId, lock_conversa: false }, { onConflict: "conversation_id" });

    // Re-run somente se chegou uma NOVA mensagem do usuário DURANTE o turno atual.
    // Verifica criado_em > turnStartedAt para evitar re-runs em loop por mensagens antigas
    // ou por mensagens duplicadas (retries do Helena).
    const newerUserMsg = await sb
      .from("messages")
      .select("id")
      .eq("conversation_id", conversationId)
      .eq("role", "user")
      .gt("criado_em", turnStartedAt)
      .limit(1);

    if (newerUserMsg.data && newerUserMsg.data.length > 0) {
      console.log(`[agent] Nova mensagem detectada durante o turn — re-executando ${conversationId}`);
      void runAgentTurn(conversationId).catch((e) =>
        console.error(`[agent] re-run falhou para ${conversationId}:`, e),
      );
    }
  }
}
