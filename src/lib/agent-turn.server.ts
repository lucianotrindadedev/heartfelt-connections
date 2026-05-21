// Executa um turno do agente com tool use loop + message splitting.
import { getSelfhost } from "@/integrations/selfhost/client.server";
import { decryptValue } from "@/lib/crypto.server";
import { loadHelenaAccount, sendHelenaText } from "@/lib/helena.server";
import { splitMessage, typingDelayMs } from "@/lib/message-splitter.server";
import { buildToolsForAccount, type ToolDefinition } from "@/lib/tools/tool-registry.server";
import { listGoogleCalendarSlots, createGoogleCalendarEvent } from "@/lib/tools/google-calendar.server";
import { listClinicorpSlots, createClinicorpAppointment } from "@/lib/tools/clinicorp.server";
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

async function executeTool(
  toolName: string,
  args: Record<string, unknown>,
  context: { accountId: string; agentId: string; phone: string; sessionId?: string },
): Promise<string> {
  try {
    switch (toolName) {
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
        const event = await createGoogleCalendarEvent(context.accountId, {
          summary: args.titulo as string,
          description: args.descricao as string | undefined,
          phone: context.phone,
          start: args.inicio as string,
          end: args.fim as string,
        });
        return `Agendamento criado com sucesso! ID: ${event.id}`;
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
            .map((s) => `- ${new Date(s.start).toLocaleString("pt-BR")}`)
            .join("\n")
        );
      }

      case "agendar_clinicorp": {
        const appt = await createClinicorpAppointment(context.accountId, {
          phone: args.telefone as string,
          name: args.nome as string,
          email: args.email as string | undefined,
          datetime: args.horario as string,
        });
        return `Consulta agendada com sucesso para ${appt.patientName} em ${new Date(appt.datetime).toLocaleString("pt-BR")}!`;
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
        const appt = await createClinupAppointment(context.accountId, {
          phone: args.telefone as string,
          name: args.nome as string,
          datetime: args.horario as string,
          notes: args.observacao as string | undefined,
        });
        return `Consulta agendada com sucesso para ${appt.patientName} em ${appt.datetime}!`;
      }

      case "clinup_buscar_consultas": {
        const patient = await findClinupPatient(context.accountId, args.telefone as string);
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
        // Busca id do contato via telefone
        const contactRes = await fetch(
          `${helena.baseUrl.replace(/\/$/, "")}/core/v1/contact?phone=${encodeURIComponent(context.phone)}`,
          { headers: { Authorization: `Bearer ${helena.token}`, accept: "application/json" } },
        );
        if (!contactRes.ok) return `Erro ao buscar contato: ${contactRes.status}`;
        const contactJson = (await contactRes.json()) as { id?: string | number } | { data?: { id?: string | number }[] } | null;
        const contactId = (contactJson as { id?: string | number })?.id
          ?? (contactJson as { data?: { id?: string | number }[] })?.data?.[0]?.id;
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
          phone: context.phone,
          sessionId: context.sessionId,
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
    .select("id, phone, helena_session_id, agent_id")
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
  const phone = conv.data.phone as string;
  const sessionId = (conv.data.helena_session_id as string | null) ?? undefined;

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

  // 2. Lock
  await sb
    .from("conversation_state")
    .upsert({ conversation_id: conversationId, lock_conversa: true }, { onConflict: "conversation_id" });

  try {
    // 3. Histórico
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

    // Injeta contexto de data/hora atual (America/Sao_Paulo) no topo do system prompt
    const systemPrompt = buildDateContext() + "\n\n" + basePrompt;

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

          const toolResult = await executeTool(tc.function.name, toolArgs, {
            accountId,
            agentId,
            phone,
            sessionId,
          });

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
      const sendRes = await sendHelenaText(helena, { phone, text: part, sessionId });
      if (!sendRes.ok) {
        console.error(`[helena] envio falhou ${sendRes.status}: ${sendRes.body.slice(0, 200)}`);
      }
    }
  } finally {
    await sb
      .from("conversation_state")
      .upsert({ conversation_id: conversationId, lock_conversa: false }, { onConflict: "conversation_id" });
  }
}
