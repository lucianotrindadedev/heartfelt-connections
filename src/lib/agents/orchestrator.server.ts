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
  getBookingFields,
  getMissingBookingFields,
  isReadyForBooking,
  isSlotAcceptanceMessage,
  looksLikeSchedulingPreference,
  mergeLeadDataPatch,
  normalizeLeadDataForBooking,
  sanitizeLeadDataPatch,
  tryAutoCaptureBookingAnswer,
  tryAutoSelectOfferedSlot,
} from "@/lib/booking-template";
import { DEFAULT_LLM_MODEL, DEFAULT_TOOL_FALLBACK_MODELS, DEFAULT_TOOL_MODEL } from "@/lib/llm-defaults";
import {
  loadHelenaAccount,
  loadHelenaContactFromSession,
  sendHelenaText,
  type HelenaContact,
} from "@/lib/helena.server";
import {
  clearStaleConversationLock,
  releaseConversationLock,
  tryAcquireConversationLock,
} from "@/lib/conversation-lock.server";
import { conversationNeedsAgentReply } from "@/lib/conversation-reply.server";
import {
  MIN_INTER_PART_DELAY_MS,
  splitMessage,
  typingDelayMs,
} from "@/lib/message-splitter.server";
import { escalateToHuman } from "@/lib/tools/escalate-human.server";
import type { AgentContext, AgentResult } from "./context";
import { stripNullishFields } from "./parse-llm-json.server";
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
  const parts = await splitMessage(reply, accountId);
  console.log(
    `[orch] split ${parts.length} parte(s) — ${parts.map((p) => p.length).join("+")} chars (total ${reply.length})`,
  );

  const helena = await loadHelenaAccount(accountId);
  const multiPart = parts.length > 1;

  let sentCount = 0;
  for (let i = 0; i < parts.length; i++) {
    if (i > 0) {
      const pauseMs = Math.max(typingDelayMs(parts[i], i), MIN_INTER_PART_DELAY_MS);
      await delay(pauseMs);
    }
    let sendRes = await sendHelenaText(helena, {
      phone,
      text: parts[i],
      sessionId,
      viaWhatsApp: multiPart,
    });
    if (!sendRes.ok) {
      await delay(500);
      sendRes = await sendHelenaText(helena, {
        phone,
        text: parts[i],
        sessionId,
        viaWhatsApp: multiPart,
      });
    }
    if (!sendRes.ok) {
      console.error(
        `[orch] helena parte ${i + 1}/${parts.length} falhou ${sendRes.status}: ${sendRes.body.slice(0, 200)}`,
      );
      continue;
    }
    sentCount++;
  }
  if (sentCount === 0) {
    console.error(`[orch] Helena: nenhuma parte enviada para ${conversationId}`);
    throw new Error("Falha ao enviar resposta pelo Helena");
  }
  if (parts.length > 1 && sentCount < parts.length) {
    console.error(`[orch] envio parcial ${sentCount}/${parts.length} para ${conversationId}`);
  }

  await sb.from("messages").insert({
    conversation_id: conversationId,
    role: "assistant",
    content: reply,
    meta: {
      origem: "agente",
      delivery_status: sentCount === parts.length ? "delivered" : "partial",
      delivered_parts: sentCount,
      split_parts: parts.length,
      split_preview: parts.map((p) => p.slice(0, 80)),
      ...meta,
    },
  });

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
    cost_usd_estimate: meta.cost_usd_estimate ?? 0,
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

  // 2. Lock atômico (evita dois turnos em paralelo na mesma conversa)
  await clearStaleConversationLock(conversationId);
  const lockAcquired = await tryAcquireConversationLock(conversationId);
  if (!lockAcquired) {
    console.log(`[orch] lock ocupado ${conversationId} — turno duplicado ignorado`);
    throw new ConversationLockedError(conversationId);
  }

  if (!(await conversationNeedsAgentReply(conversationId))) {
    console.log(`[orch] ${conversationId} já respondida — turno ignorado`);
    await releaseConversationLock(conversationId);
    return;
  }

  // 3. LLM config + secret
  const llm = await sb
    .from("account_llm_config")
    .select("default_model, max_tokens, temperature, fallback_models, rag_gate_model, tool_model")
    .eq("account_id", accountId)
    .single();
  const secrets = await sb
    .from("account_secrets")
    .select("openrouter_api_key_enc")
    .eq("account_id", accountId)
    .single();
  if (!secrets.data?.openrouter_api_key_enc) {
    console.warn(`[orch] sem chave OpenRouter para ${accountId}`);
    await releaseConversationLock(conversationId);
    return;
  }
  const orKey = await decryptValue(secrets.data.openrouter_api_key_enc as unknown as string);
  if (!orKey) throw new Error("Falha ao descriptografar OpenRouter key");

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
    let leadData = readLeadDataFromMeta(meta);
    const agentSettings = (agent.data.settings as Record<string, string> | null) ?? {};

    if (leadData.custom_fields) {
      const cleaned: Record<string, string> = {};
      let removedInvalid = false;
      for (const [k, v] of Object.entries(leadData.custom_fields)) {
        if (typeof v === "string" && looksLikeSchedulingPreference(v)) {
          removedInvalid = true;
          continue;
        }
        cleaned[k] = v;
      }
      if (removedInvalid) {
        leadData = { ...leadData, custom_fields: cleaned };
        console.log(
          `[orch] limpando custom_fields inválidos conv=${conversationId} (preferência de horário)`,
        );
      }
    }

    leadData = normalizeLeadDataForBooking(leadData, {
      fallbackGuardianName: helenaContact?.name,
    });

    const lastUserMsg = [...history].reverse().find((m) => m.role === "user")?.content?.trim() ?? "";
    const slotSelectionTurn =
      isSlotAcceptanceMessage(lastUserMsg) || looksLikeSchedulingPreference(lastUserMsg);

    if (stage === "SLOT_OFFER" || stage === "NAME_COLLECT" || stage === "BOOKING") {
      const slotPatch = tryAutoSelectOfferedSlot(stage, leadData, history);
      if (Object.keys(slotPatch).length > 0) {
        leadData = mergeLeadDataPatch(leadData, slotPatch);
        console.log(
          `[orch] auto-selecao slot conv=${conversationId} iso=${slotPatch.selected_slot_iso}`,
        );
      }
    }

    if (stage === "NAME_COLLECT" && !slotSelectionTurn) {
      const autoPatch = tryAutoCaptureBookingAnswer(stage, leadData, history, agentSettings);
      if (Object.keys(autoPatch).length > 0) {
        leadData = mergeLeadDataPatch(leadData, autoPatch);
        console.log(
          `[orch] auto-captura NAME_COLLECT conv=${conversationId} patch=${JSON.stringify(autoPatch)}`,
        );
      }
    }

    // 8. Integrações habilitadas
    const [clinicorpCfg, clinupCfg, gcalCfg, escCfg] = await Promise.all([
      sb.from("clinicorp_config").select("ativo").eq("account_id", accountId).maybeSingle(),
      sb.from("clinup_config").select("ativo").eq("account_id", accountId).maybeSingle(),
      sb.from("google_calendar_tokens").select("ativo").eq("account_id", accountId).maybeSingle(),
      sb.from("agent_escalation").select("ativo").eq("agent_id", agentId).maybeSingle(),
    ]);

    const hasBookingIntegration =
      !!clinicorpCfg.data?.ativo || !!clinupCfg.data?.ativo || !!gcalCfg.data?.ativo;

    let effectiveStage = stage;
    if (stage === "SLOT_OFFER" && leadData.selected_slot_iso) {
      effectiveStage = "NAME_COLLECT";
      console.log(
        `[orch] slot escolhido conv=${conversationId} — scheduler em NAME_COLLECT (era SLOT_OFFER)`,
      );
    }
    if (stage === "NAME_COLLECT" && !leadData.selected_slot_iso) {
      effectiveStage = "SLOT_OFFER";
      console.log(
        `[orch] NAME_COLLECT sem slot conv=${conversationId} — scheduler em SLOT_OFFER`,
      );
    }
    if (
      (stage === "NAME_COLLECT" || stage === "BOOKING") &&
      hasBookingIntegration &&
      !leadData.appointment_id &&
      isReadyForBooking(leadData, agentSettings, {
        hasPhone: !!effectivePhone,
        hasBookingIntegration,
      })
    ) {
      effectiveStage = "BOOKING";
      console.log(`[orch] campos completos conv=${conversationId} — scheduler em BOOKING`);
    }

    // 9. Monta AgentContext
    const ctx: AgentContext = {
      accountId,
      agentId,
      conversationId,
      sessionId,
      stage: effectiveStage,
      leadData,
      conversationPhone,
      effectivePhone,
      channel,
      helenaContact,
      agentSettings,
      basePrompt: (agent.data.system_prompt as string) || "",
      model:
        (agent.data.llm_model_override as string | null) ||
        (llm.data?.default_model as string | undefined) ||
        DEFAULT_LLM_MODEL,
      toolModel:
        (llm.data?.tool_model as string | undefined) ?? DEFAULT_TOOL_MODEL,
      toolFallbackModels: [...DEFAULT_TOOL_FALLBACK_MODELS],
      fallbackModels:
        (llm.data?.fallback_models as string[] | undefined) ??
        ["openai/gpt-4o-mini", "anthropic/claude-haiku-4.5"],
      ragGateModel:
        (llm.data?.rag_gate_model as string | undefined) ?? DEFAULT_LLM_MODEL,
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
    const wallMs = Date.now() - new Date(turnStartedAt).getTime();
    console.log(
      `[orch] turn ok conv=${conversationId} route=${route} llm=${latencyMs}ms wall=${wallMs}ms tools=${result.tools_called?.join(",") ?? "none"}`,
    );

    // 11. Aplica transição validada + merge de lead_data
    const patch = stripNullishFields(
      sanitizeLeadDataPatch(
        (result.lead_data_patch ?? {}) as Partial<LeadData>,
      ) as Record<string, unknown>,
    ) as Partial<LeadData>;
    const newLeadData: LeadData = normalizeLeadDataForBooking(
      mergeLeadDataPatch(leadData, patch as Partial<LeadData>),
      { fallbackGuardianName: helenaContact?.name },
    );

    let newStage = resolveNextStage(stage, result.next_stage, {
      requireAppointmentForConfirmed: hasBookingIntegration,
      hasAppointmentId: !!newLeadData.appointment_id,
      leadData: newLeadData,
    });

    if (
      stage === "SLOT_OFFER" &&
      newLeadData.selected_slot_iso &&
      newStage === "SLOT_OFFER"
    ) {
      newStage = "NAME_COLLECT";
      console.log(
        `[orch] slot selecionado conv=${conversationId} — avancando SLOT_OFFER → NAME_COLLECT`,
      );
    }

    if (
      newLeadData.appointment_id &&
      (newStage === "NAME_COLLECT" || newStage === "BOOKING")
    ) {
      console.log(
        `[orch] agendamento criado conv=${conversationId} — avancando ${newStage} → CONFIRMED`,
      );
      newStage = "CONFIRMED";
    }

    let reply = result.reply;
    if (
      hasBookingIntegration &&
      !newLeadData.appointment_id &&
      /\b(agendei|agendado|marquei|confirmad[oa]|visita guiada para)\b/i.test(reply)
    ) {
      console.warn(
        `[orch] reply afirma agendamento sem appointment_id conv=${conversationId} — bloqueando confirmação falsa`,
      );
      const missingFields = getMissingBookingFields(
        getBookingFields(agentSettings),
        newLeadData,
      );
      if (newLeadData.selected_slot_iso && missingFields.length > 0) {
        const nextField = missingFields[0]!;
        reply = `Perfeito! Anotei esse horário para você.\n\n${nextField.question}`;
        newStage = "NAME_COLLECT";
      } else if (newLeadData.selected_slot_iso) {
        reply =
          "Perfeito! Anotei esse horário. Estou finalizando o registro na agenda e já te confirmo.";
        newStage = "BOOKING";
      } else {
        reply =
          "Desculpe, tive um problema ao registrar sua visita na agenda agora. Pode me confirmar o horário que você prefere? Vou tentar registrar de novo.";
        if (newStage === "CONFIRMED" || stage === "NAME_COLLECT" || stage === "BOOKING") {
          newStage = newLeadData.selected_slot_iso ? "BOOKING" : "SLOT_OFFER";
        }
      }
    }

    if (newStage === "NAME_COLLECT" && !newLeadData.selected_slot_iso) {
      newStage = "SLOT_OFFER";
    }

    // 12. Persiste e entrega
    await persistStageAndLeadData(conversationId, meta, newStage, newLeadData, route);

    await deliverReply(
      accountId,
      agentId,
      conversationId,
      reply,
      {
        model: ctx.model,
        latency_ms: latencyMs,
        tokens_in: result.tokens_in ?? null,
        tokens_out: result.tokens_out ?? null,
        cost_usd_estimate: result.cost_usd ?? null,
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
    await releaseConversationLock(conversationId);

    // Re-run se nova mensagem chegou durante o turn
    const newer = await sb
      .from("messages")
      .select("id")
      .eq("conversation_id", conversationId)
      .eq("role", "user")
      .gt("criado_em", turnStartedAt)
      .limit(1);
    if (newer.data && newer.data.length > 0) {
      const debounceSec = Math.min(
        5,
        (agent.data.debounce_segundos as number | null) ?? 20,
      );
      console.log(
        `[orch] nova mensagem durante turn — reagendando em ${debounceSec}s ${conversationId}`,
      );
      const { scheduleConversationAgentTurn } = await import(
        "@/lib/schedule-agent-turn.server"
      );
      scheduleConversationAgentTurn(conversationId, debounceSec, 0);
    }
  }
}
