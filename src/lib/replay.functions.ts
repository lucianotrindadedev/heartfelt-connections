// Replay determinístico de conversas reais.
//
// Pega uma conversa do banco (todas as mensagens em ordem) e reexecuta cada
// turn do USER com a versão atual do código, em dry-run (sem efeitos colaterais:
// nada vai para Helena/Calendar/Clinicorp/CRM). Permite responder:
//
//   "Se esse lead voltasse hoje com a mesma sequência de mensagens, a IA
//    cometeria o mesmo erro?"
//
// Cada turn devolve:
//   - input do user
//   - reply original (do banco, gerada em produção quando o turn aconteceu)
//   - reply do replay (gerada agora pelo código atual)
//   - stage_before / stage_after_replay
//   - lead_data_after_replay
//   - telemetria (preflight_blocked, dirty_fields etc)

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { getSelfhost } from "@/integrations/selfhost/client.server";
import { decryptValue } from "@/lib/crypto.server";
import {
  DEFAULT_LLM_MODEL,
  DEFAULT_QUALIFIER_FALLBACK_MODELS,
  DEFAULT_QUALIFIER_MODEL,
  DEFAULT_TOOL_FALLBACK_MODELS,
  DEFAULT_TOOL_MODEL,
} from "@/lib/llm-defaults";
import type { AgentContext } from "@/lib/agents/context";
import { runQualifierAgent } from "@/lib/agents/qualifier.server";
import { runSchedulerAgent } from "@/lib/agents/scheduler.server";
import { routeForStage, type LeadData, type Stage } from "@/lib/agents/stage";
import { mergeLeadDataPatch } from "@/lib/booking-template";

interface ReplayMessage {
  role: "user" | "assistant";
  content: string;
  criado_em: string;
  meta?: Record<string, unknown> | null;
}

export interface ReplayTelemetry {
  preflight_blocked?: boolean;
  dirty_fields?: string[];
}

export type ReplayRoute = "qualifier" | "scheduler" | "escalation";

export interface ReplayTurn {
  index: number;
  userMessage: string;
  originalAssistantReply: string | null;
  stageBefore: Stage;
  /** Stage que o REPLAY proporia (com o codigo atual). */
  stageAfter: Stage;
  leadDataAfter: LeadData;
  replayReply: string;
  /** Telemetria estruturada (preflight_blocked, dirty_fields etc). */
  telemetry?: ReplayTelemetry;
  toolsCalled: string[];
  model: string;
  route: ReplayRoute;
}

export interface ReplayResult {
  conversationId: string;
  accountId: string;
  agentId: string;
  totalTurns: number;
  turns: ReplayTurn[];
}

export const replayConversation = createServerFn({ method: "POST" })
  .inputValidator((d) =>
    z
      .object({
        conversationId: z.string().uuid(),
      })
      .parse(d),
  )
  .handler(async ({ data }): Promise<ReplayResult> => {
    const sb = getSelfhost();

    const conv = await sb
      .from("conversations")
      .select("id, agent_id, channel, lead_phone, channel_identifier, phone")
      .eq("id", data.conversationId)
      .single();
    if (conv.error || !conv.data) throw new Error("Conversa não encontrada");

    const agent = await sb
      .from("agents")
      .select("id, account_id, system_prompt, settings, llm_model_override")
      .eq("id", conv.data.agent_id)
      .single();
    if (agent.error || !agent.data) throw new Error("Agente não encontrado");
    const accountId = agent.data.account_id as string;
    const agentId = agent.data.id as string;

    const [llm, secrets, clinicorpCfg, clinupCfg, gcalCfg, escCfg] = await Promise.all([
      sb
        .from("account_llm_config")
        .select(
          "default_model, max_tokens, temperature, fallback_models, rag_gate_model, tool_model",
        )
        .eq("account_id", accountId)
        .single(),
      sb
        .from("account_secrets")
        .select("openrouter_api_key_enc")
        .eq("account_id", accountId)
        .single(),
      sb.from("clinicorp_config").select("ativo").eq("account_id", accountId).maybeSingle(),
      sb.from("clinup_config").select("ativo").eq("account_id", accountId).maybeSingle(),
      sb.from("google_calendar_tokens").select("ativo").eq("account_id", accountId).maybeSingle(),
      sb.from("agent_escalation").select("ativo").eq("agent_id", agentId).maybeSingle(),
    ]);
    if (!secrets.data?.openrouter_api_key_enc) {
      throw new Error("Conta sem chave OpenRouter configurada.");
    }
    const orKey = await decryptValue(secrets.data.openrouter_api_key_enc as unknown as string);
    if (!orKey) throw new Error("Falha ao descriptografar OpenRouter key");

    const msgs = await sb
      .from("messages")
      .select("role, content, meta, criado_em")
      .eq("conversation_id", data.conversationId)
      .order("criado_em", { ascending: true });
    if (msgs.error) throw new Error(msgs.error.message);

    const messages = (msgs.data ?? []).filter((m) => {
      const meta = m.meta as Record<string, unknown> | null;
      if (meta?.fallback === true) return false;
      return m.role === "user" || m.role === "assistant";
    }) as ReplayMessage[];

    const model =
      (agent.data.llm_model_override as string | null) ||
      (llm.data?.default_model as string | undefined) ||
      DEFAULT_LLM_MODEL;
    const maxTokens = (llm.data?.max_tokens as number | undefined) ?? 2048;
    const temperature = (llm.data?.temperature as number | undefined) ?? 0.5;
    const channel =
      ((conv.data.channel as string | null) ?? "whatsapp") as AgentContext["channel"];
    const effectivePhone =
      (conv.data.lead_phone as string | null) ??
      (conv.data.channel_identifier as string | null) ??
      (conv.data.phone as string | null) ??
      null;

    const buildCtx = (
      history: { role: "user" | "assistant"; content: string }[],
      stage: Stage,
      leadData: LeadData,
    ): AgentContext => ({
      accountId,
      agentId,
      conversationId: `replay-${data.conversationId}`,
      sessionId: undefined,
      stage,
      leadData,
      conversationPhone: (conv.data.phone as string | null) ?? "5500000000000",
      effectivePhone,
      channel,
      helenaContact: null,
      agentSettings: (agent.data.settings as Record<string, string> | null) ?? {},
      basePrompt: (agent.data.system_prompt as string) || "",
      model,
      qualifierModel:
        ((llm.data as Record<string, unknown> | null)?.qualifier_model as string | undefined) ??
        DEFAULT_QUALIFIER_MODEL,
      qualifierFallbackModels: [...DEFAULT_QUALIFIER_FALLBACK_MODELS],
      toolModel: (llm.data?.tool_model as string | undefined) ?? DEFAULT_TOOL_MODEL,
      toolFallbackModels: [...DEFAULT_TOOL_FALLBACK_MODELS],
      fallbackModels:
        (llm.data?.fallback_models as string[] | undefined) ??
        ["openai/gpt-4o-mini", "anthropic/claude-haiku-4.5"],
      ragGateModel:
        (llm.data?.rag_gate_model as string | undefined) ?? DEFAULT_LLM_MODEL,
      maxTokens,
      temperature,
      orKey,
      integrations: {
        clinicorp: !!clinicorpCfg.data?.ativo,
        clinup: !!clinupCfg.data?.ativo,
        googleCalendar: !!gcalCfg.data?.ativo,
        escalation: !!escCfg.data?.ativo,
      },
      history,
      dryRun: true,
    });

    const turns: ReplayTurn[] = [];
    const accumulatedHistory: { role: "user" | "assistant"; content: string }[] = [];
    let stage: Stage = "RECEPTION";
    let leadData: LeadData = {};

    for (let i = 0; i < messages.length; i++) {
      const m = messages[i]!;
      if (m.role !== "user") {
        accumulatedHistory.push({ role: "assistant", content: m.content });
        continue;
      }

      const historyBefore = [...accumulatedHistory, { role: "user" as const, content: m.content }];
      const ctx = buildCtx(historyBefore, stage, leadData);
      const route = routeForStage(stage);

      if (route === "escalation") {
        turns.push({
          index: turns.length,
          userMessage: m.content,
          originalAssistantReply: nextAssistantContent(messages, i),
          stageBefore: stage,
          stageAfter: stage,
          leadDataAfter: leadData,
          replayReply: "(ESCALATED — agente silencia em produção)",
          toolsCalled: [],
          model,
          route: "escalation",
        });
        accumulatedHistory.push({ role: "user", content: m.content });
        continue;
      }

      try {
        const result = route === "qualifier"
          ? await runQualifierAgent(ctx)
          : await runSchedulerAgent(ctx);

        const newLead = mergeLeadDataPatch(leadData, result.lead_data_patch ?? {});
        const rawTelemetry = (result.telemetry ?? undefined) as
          | Record<string, unknown>
          | undefined;
        const telemetry: ReplayTelemetry | undefined = rawTelemetry
          ? {
              preflight_blocked: rawTelemetry.preflight_blocked === true || undefined,
              dirty_fields: Array.isArray(rawTelemetry.dirty_fields)
                ? (rawTelemetry.dirty_fields as string[])
                : undefined,
            }
          : undefined;

        turns.push({
          index: turns.length,
          userMessage: m.content,
          originalAssistantReply: nextAssistantContent(messages, i),
          stageBefore: stage,
          stageAfter: result.next_stage,
          leadDataAfter: newLead,
          replayReply: result.reply,
          telemetry,
          toolsCalled: result.tools_called ?? [],
          model,
          route,
        });

        stage = result.next_stage;
        leadData = newLead;
        accumulatedHistory.push({ role: "user", content: m.content });
        accumulatedHistory.push({ role: "assistant", content: result.reply });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        turns.push({
          index: turns.length,
          userMessage: m.content,
          originalAssistantReply: nextAssistantContent(messages, i),
          stageBefore: stage,
          stageAfter: stage,
          leadDataAfter: leadData,
          replayReply: `(ERRO no replay: ${msg.slice(0, 200)})`,
          toolsCalled: [],
          model,
          route,
        });
        accumulatedHistory.push({ role: "user", content: m.content });
      }
    }

    return {
      conversationId: data.conversationId,
      accountId,
      agentId,
      totalTurns: turns.length,
      turns,
    };
  });

function nextAssistantContent(messages: ReplayMessage[], userIdx: number): string | null {
  for (let j = userIdx + 1; j < messages.length; j++) {
    const m = messages[j]!;
    if (m.role === "assistant") return m.content;
    if (m.role === "user") return null;
  }
  return null;
}
