// ORCHESTRATOR
// Substitui o loop monolítico de agent-turn.server.ts.
//
// Responsabilidades:
// 1. Carregar contexto (conv, agente, settings, histórico filtrado, lead_data, stage).
// 2. Decidir qual sub-agente roda (routeForStage).
// 3. Validar a transição proposta pelo agente (resolveNextStage).
// 4. Persistir lead_data + stage atualizados em conversations.meta.
// 5. Entregar reply via Helena (splitMessage + sendHelenaText).
// 6. Lock + re-run + escalação humana.

import { getSelfhost } from "@/integrations/selfhost/client.server";
import { decryptValue } from "@/lib/crypto.server";
import {
  resolveEffectivePhone,
  type ConversationChannel,
} from "@/lib/conversation-channel.server";
import {
  loadHelenaAccount,
  loadHelenaContactFromSession,
  sendHelenaText,
  type HelenaContact,
} from "@/lib/helena.server";
import { enqueueMessage } from "@/lib/message-queue.server";
import { splitMessage, typingDelayMs } from "@/lib/message-splitter.server";
import { escalateToHuman } from "@/lib/tools/escalate-human.server";
import type { AgentContext, AgentResult } from "./context";
import { runQualifierAgent } from "./qualifier.server";
import { runSchedulerAgent } from "./scheduler.server";
import {
  INITIAL_STAGE,
  isStage,
  resolveNextStage,
  routeForStage,
  type LeadData,
  type Stage,
} from "./stage";

const MAX_HISTORY = 50;
const STALE_LOCK_MS = 4 * 60 * 1000;

export class ConversationLockedError extends Error {
  constructor(conversationId: string) {
    super(`Conversa ${conversationId} com turno em andamento`);
    this.name = "ConversationLockedError";
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

interface MsgRow {
  role: string;
  content: string | null;
  meta: Record<string, unknown> | null;
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

  console.warn(`[orch] lock obsoleto em ${conversationId} — liberando`);
  await sb
    .from("conversation_state")
    .upsert({ conversation_id: conversationId, lock_conversa: false }, { onConflict: "conversation_id" });
}

// ── Persistência stage/lead_data em conversations.meta ────────────────────

interface ConversationMeta {
  stage?: string;
  lead_data?: Record<string, unknown>;
  current_agent?: string;
  [k: string]: unknown;
}

function readStageFromMeta(meta: ConversationMeta | null): Stage {
  const s = meta?.stage;
  return isStage(s) ? s : INITIAL_STAGE;
}

function readLeadDataFromMeta(meta: ConversationMeta | null): LeadData {
  const ld = meta?.lead_data;
  if (!ld || typeof ld !== "object") return {};
  return ld as LeadData;
}

async function persistStageAndLeadData(
  conversationId: string,
  currentMeta: ConversationMeta | null,
  stage: Stage,
  leadData: LeadData,
  currentAgent: string,
): Promise<void> {
  const sb = getSelfhost();
  const meta: ConversationMeta = {
    ...(currentMeta ?? {}),
    stage,
    lead_data: leadData as Record<string, unknown>,
    current_agent: currentAgent,
  };
  await sb.from("conversations").update({ meta }).eq("id", conversationId);
}

// ── Entrega de reply (helena + DB) ────────────────────────────────────────

async function deliverReply(
  accountId: string,
  agentId: string,
  conversationId: string,
  reply: string,
  meta: Record<string, unknown>,
  sessionId: string | undefined,
  phone: string | undefined,
): Promise<void> {
  const sb = getSelfhost();
  await sb.from("messages").insert({
    conversation_id: conversationId,
    role: "assistant",
    content: reply,
    meta: { origem: "agente", ...meta },
  });

  const helena = await loadHelenaAccount(accountId);
  const parts = await splitMessage(reply, accountId);
  for (let i = 0; i < parts.length; i++) {
    if (i > 0) await delay(typingDelayMs(parts[i]));
    const sendRes = await sendHelenaText(helena, {
      phone,
      text: parts[i],
      sessionId,
    });
    if (!sendRes.ok) {
      console.error(`[orch] helena send falhou ${sendRes.status}: ${sendRes.body.slice(0, 200)}`);
    }
  }
  // Mantém agentId/agent_run para retrocompat (UI mostra esse insight).
  await sb.from("agent_runs").insert({
    account_id: accountId,
    agent_id: agentId,
    conversation_id: conversationId,
    provider: "openrouter",
    model: meta.model ?? "unknown",
    latency_ms: meta.latency_ms ?? null,
    tokens_in: meta.tokens_in ?? null,
    tokens_out: meta.tokens_out ?? null,
  });
}

// ── runAgentTurn refatorado ───────────────────────────────────────────────

export async function runAgentTurn(conversationId: string): Promise<void> {
  const sb = getSelfhost();

  // 1. Conversa + agente
  const conv = await sb
    .from("conversations")
    .select("id, phone, helena_session_id, agent_id, meta, lead_phone, channel, channel_identifier, helena_contact_id")
    .eq("id", conversationId)
    .single();
  if (conv.error || !conv.data) throw new Error("Conversa não encontrada");

  const agent = await sb
    .from("agents")
    .select("id, account_id, ativo, system_prompt, llm_model_override, debounce_segundos, settings")
    .eq("id", conv.data.agent_id)
    .single();
  if (agent.error || !agent.data) throw new Error("Agente não encontrado");
  if (!agent.data.ativo) return;

  const accountId = agent.data.account_id as string;
  const agentId = agent.data.id as string;
  const sessionId = (conv.data.helena_session_id as string | null) ?? undefined;
  const channel = (conv.data.channel as ConversationChannel | null) ?? "whatsapp";
  const conversationPhone = conv.data.phone as string;
  const leadPhone = conv.data.lead_phone as string | null;
  const channelIdentifier = conv.data.channel_identifier as string | null;
  const effectivePhone =
    resolveEffectivePhone({
      leadPhone,
      contactPhone: channelIdentifier,
      conversationPhone,
    }).phone ?? null;

  // 2. Lock (com stale recovery)
  await clearStaleConversationLock(conversationId);
  const stateCheck = await sb
    .from("conversation_state")
    .select("lock_conversa")
    .eq("conversation_id", conversationId)
    .maybeSingle();
  if (stateCheck.data?.lock_conversa) {
    const debounce = (agent.data.debounce_segundos as number | null) ?? 20;
    await enqueueMessage(conversationId, Math.min(5, debounce));
    throw new ConversationLockedError(conversationId);
  }

  // 3. LLM config + secret
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
    console.warn(`[orch] sem chave OpenRouter para ${accountId}`);
    return;
  }
  const orKey = await decryptValue(secrets.data.openrouter_api_key_enc as unknown as string);
  if (!orKey) throw new Error("Falha ao descriptografar OpenRouter key");

  // 4. Adquire lock + marca início
  await sb
    .from("conversation_state")
    .upsert({ conversation_id: conversationId, lock_conversa: true }, { onConflict: "conversation_id" });
  const turnStartedAt = new Date().toISOString();

  try {
    // 5. Histórico (filtra fallbacks)
    const msgs = await sb
      .from("messages")
      .select("role, content, meta")
      .eq("conversation_id", conversationId)
      .order("criado_em", { ascending: false })
      .limit(MAX_HISTORY);
    if (msgs.error) throw new Error(msgs.error.message);

    const ordered = (msgs.data ?? []).slice().reverse() as MsgRow[];
    const history: { role: "user" | "assistant"; content: string }[] = [];
    for (const m of ordered) {
      if (m.meta && (m.meta as Record<string, unknown>).fallback === true) continue;
      if (m.role === "user") history.push({ role: "user", content: m.content ?? "" });
      else if (m.role === "assistant") history.push({ role: "assistant", content: m.content ?? "" });
    }

    // 6. Carrega contato Helena (uma vez — reaproveita em qualifier/scheduler)
    let helenaContact: HelenaContact | null = null;
    if (sessionId) {
      try {
        const helena = await loadHelenaAccount(accountId);
        helenaContact = await loadHelenaContactFromSession(helena, sessionId);
      } catch (e) {
        console.warn("[orch] falha ao carregar contato Helena:", e);
      }
    }

    // 7. Stage + lead_data a partir de conversations.meta
    const meta = (conv.data.meta as ConversationMeta | null) ?? null;
    const stage = readStageFromMeta(meta);
    const leadData = readLeadDataFromMeta(meta);

    // 8. Integrações habilitadas
    const [clinicorpCfg, clinupCfg, gcalCfg, escCfg] = await Promise.all([
      sb.from("clinicorp_config").select("ativo").eq("account_id", accountId).maybeSingle(),
      sb.from("clinup_config").select("ativo").eq("account_id", accountId).maybeSingle(),
      sb.from("google_calendar_tokens").select("ativo").eq("account_id", accountId).maybeSingle(),
      sb.from("agent_escalation").select("ativo").eq("agent_id", agentId).maybeSingle(),
    ]);

    // 9. Monta AgentContext
    const ctx: AgentContext = {
      accountId,
      agentId,
      conversationId,
      sessionId,
      stage,
      leadData,
      conversationPhone,
      effectivePhone,
      channel,
      helenaContact,
      agentSettings: (agent.data.settings as Record<string, string> | null) ?? {},
      basePrompt: (agent.data.system_prompt as string) || "",
      model:
        (agent.data.llm_model_override as string | null) ||
        (llm.data?.default_model as string | undefined) ||
        "anthropic/claude-sonnet-4.5",
      maxTokens: (llm.data?.max_tokens as number | undefined) ?? 1024,
      temperature: (llm.data?.temperature as number | undefined) ?? 0.5,
      orKey,
      integrations: {
        clinicorp: !!clinicorpCfg.data?.ativo,
        clinup: !!clinupCfg.data?.ativo,
        googleCalendar: !!gcalCfg.data?.ativo,
        escalation: !!escCfg.data?.ativo,
      },
      history,
    };

    // 10. Roteamento por stage
    const route = routeForStage(stage);
    console.log(`[orch] conv=${conversationId} stage=${stage} route=${route}`);

    let result: AgentResult;
    const t0 = Date.now();
    try {
      if (route === "qualifier") {
        result = await runQualifierAgent(ctx);
      } else if (route === "scheduler") {
        result = await runSchedulerAgent(ctx);
      } else {
        // ESCALATED — não roda agente, só silencia
        return;
      }
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);
      console.error(`[orch] sub-agente ${route} falhou: ${errMsg}`);
      // Fallback educado, marcado como fallback para não poluir histórico
      const fallbackReply =
        "Desculpe, tive uma instabilidade técnica. Pode me enviar a mensagem de novo em alguns segundos?";
      await deliverReply(
        accountId,
        agentId,
        conversationId,
        fallbackReply,
        { fallback: true, model: ctx.model, error: errMsg.slice(0, 300) },
        sessionId,
        effectivePhone ?? conversationPhone,
      );
      return;
    }

    const latencyMs = Date.now() - t0;

    // 11. Aplica transição validada + merge de lead_data
    const newStage = resolveNextStage(stage, result.next_stage);
    const newLeadData: LeadData = { ...leadData, ...(result.lead_data_patch ?? {}) };

    // 12. Persiste e entrega
    await persistStageAndLeadData(conversationId, meta, newStage, newLeadData, route);

    await deliverReply(
      accountId,
      agentId,
      conversationId,
      result.reply,
      {
        model: ctx.model,
        latency_ms: latencyMs,
        stage_from: stage,
        stage_to: newStage,
        agent: route,
        tools_called: result.tools_called,
      },
      sessionId,
      effectivePhone ?? conversationPhone,
    );

    // 13. Se transitou para ESCALATED, dispara escalação humana
    if (newStage === "ESCALATED" && stage !== "ESCALATED") {
      console.log(`[orch] disparando escalateToHuman — motivo: ${newLeadData.escalation_reason}`);
      try {
        await escalateToHuman({
          accountId,
          agentId,
          phone: effectivePhone ?? conversationPhone,
          sessionId,
          reason: newLeadData.escalation_reason,
        });
      } catch (e) {
        console.error("[orch] escalateToHuman falhou:", e);
      }
    }
  } finally {
    // Libera lock
    await sb
      .from("conversation_state")
      .upsert({ conversation_id: conversationId, lock_conversa: false }, { onConflict: "conversation_id" });

    // Re-run se nova mensagem chegou durante o turn
    const newer = await sb
      .from("messages")
      .select("id")
      .eq("conversation_id", conversationId)
      .eq("role", "user")
      .gt("criado_em", turnStartedAt)
      .limit(1);
    if (newer.data && newer.data.length > 0) {
      console.log(`[orch] nova mensagem durante turn — re-executando ${conversationId}`);
      void runAgentTurn(conversationId).catch((e) =>
        console.error(`[orch] re-run falhou: ${e instanceof Error ? e.message : e}`),
      );
    }
  }
}
