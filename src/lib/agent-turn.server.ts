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
          "Horários disponíveis no Clinicorp:\n" +
          slots
            .slice(0, 10)
            .map((s) => {
              const dt = new Date(s.start).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" });
              // Inclui dentistPersonId para ser usado ao agendar (obrigatório pela API)
              const dentPart = s.dentistPersonId ? ` | dentist_person_id=${s.dentistPersonId}` : "";
              return `- ${s.start} (${dt})${dentPart}`;
            })
            .join("\n") +
          "\n\nIMPORTANTE: Ao chamar agendar_clinicorp, use o campo horario com o valor ISO exato acima e informe o dentist_person_id do horário escolhido."
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

  // 2. Verifica lock — se já há um turn em andamento, re-enfileira com delay curto e sai.
  //    Isso evita turns concorrentes que causam race conditions e respostas duplicadas.
  const stateCheck = await sb
    .from("conversation_state")
    .select("lock_conversa")
    .eq("conversation_id", conversationId)
    .maybeSingle();

  if (stateCheck.data?.lock_conversa) {
    // Já existe um turn em andamento.
    // O finally do turn ativo verificará se chegaram mensagens novas APÓS o início
    // do turn e disparará um re-run automaticamente — não precisamos fazer nada aqui.
    console.log(`[agent] Conversa ${conversationId} bloqueada — turn ativo fará re-run se necessário`);
    return;
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

  // 3. Registra o timestamp do início do turn ANTES de adquirir o lock.
  //    Qualquer mensagem do usuário com criado_em > turnStartedAt chegou durante este turn.
  const turnStartedAt = new Date().toISOString();

  // 4. Adquire lock
  await sb
    .from("conversation_state")
    .upsert({ conversation_id: conversationId, lock_conversa: true }, { onConflict: "conversation_id" });

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
      "x-ai/grok-3-fast";

    const basePrompt =
      (agent.data.system_prompt as string) || "Você é um assistente prestativo.";

    const leadBlock = buildLeadContext(contact, channel, effectivePhone);
    const systemPrompt = buildDateContext() + "\n" + leadBlock + "\n\n" + basePrompt;

    // 4. Carrega ferramentas disponíveis
    const tools = await buildToolsForAccount(accountId, agentId);

    const messages: OpenRouterMessage[] = [{ role: "system", content: systemPrompt }];
    for (const m of ordered) {
      if (m.role === "user") messages.push({ role: "user", content: m.content ?? "" });
      else if (m.role === "assistant") messages.push({ role: "assistant", content: m.content ?? "" });
    }

    let finalReply = "";
    let totalTokensIn = 0;
    let totalTokensOut = 0;
    let t0 = Date.now();
    let latencyMs = 0;

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
        body.tool_choice = "auto";
      }

      const orRes = await fetch(OPENROUTER_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${orKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });
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

      if (!assistantMsg) throw new Error("OpenRouter retornou resposta vazia");

      // Adiciona resposta ao histórico local
      messages.push({
        role: "assistant",
        content: assistantMsg.content ?? null,
        tool_calls: assistantMsg.tool_calls,
      });

      // Se tem tool_calls → executa ferramentas
      if (assistantMsg.tool_calls && assistantMsg.tool_calls.length > 0) {
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
      finalReply = assistantMsg.content?.trim() ?? "";
      break;
    }

    if (!finalReply) throw new Error("Agente não gerou resposta final");

    // 6. Loga agent_run
    await sb.from("agent_runs").insert({
      account_id: accountId,
      agent_id: agentId,
      conversation_id: conversationId,
      provider: "openrouter",
      model,
      latency_ms: latencyMs,
      tokens_in: totalTokensIn,
      tokens_out: totalTokensOut,
    });

    // 7. Persiste resposta no DB
    await sb.from("messages").insert({
      conversation_id: conversationId,
      role: "assistant",
      content: finalReply,
      meta: { origem: "agente", model },
    });

    // 8. Divide em partes e envia com delay de digitação
    const helena = await loadHelenaAccount(accountId);
    const parts = await splitMessage(finalReply, accountId);

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      // Delay de digitação antes de enviar (exceto na primeira parte)
      if (i > 0) {
        await delay(typingDelayMs(part));
      }
      const sendRes = await sendHelenaText(helena, {
        phone: effectivePhone ?? conversationPhone,
        text: part,
        sessionId,
      });
      if (!sendRes.ok) {
        console.error(`[helena] envio falhou ${sendRes.status}: ${sendRes.body.slice(0, 200)}`);
      }
    }
  } finally {
    // Libera o lock
    await sb
      .from("conversation_state")
      .upsert({ conversation_id: conversationId, lock_conversa: false }, { onConflict: "conversation_id" });

    // Re-run se chegaram novas mensagens do usuário DURANTE o processamento deste turn.
    // Isso garante que mensagens enviadas enquanto o agente processava a mensagem anterior
    // não se percam (mesmo com debounce=0).
    const newUserMsg = await sb
      .from("messages")
      .select("id")
      .eq("conversation_id", conversationId)
      .eq("role", "user")
      .gt("criado_em", turnStartedAt)
      .limit(1);

    if (newUserMsg.data && newUserMsg.data.length > 0) {
      console.log(`[agent] Nova mensagem detectada durante o turn — re-executando para ${conversationId}`);
      // Não await para não bloquear a resposta do webhook
      void runAgentTurn(conversationId).catch((e) =>
        console.error(`[agent] re-run falhou para ${conversationId}:`, e),
      );
    }
  }
}
