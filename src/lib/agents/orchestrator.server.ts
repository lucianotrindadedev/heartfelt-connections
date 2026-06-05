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
  backfillBookingFieldsFromHistory,
  getBookingFieldsForChannel,
  getMissingBookingFields,
  isReadyForBooking,
  type BookingChannelContext,
  looksLikeSchedulingPreference,
  mergeLeadDataPatch,
  normalizeLeadDataForBooking,
  resolveBookingLeadName,
  sanitizeLeadDataPatch,
  tryAutoCaptureBookingAnswer,
  tryAutoSelectOfferedSlot,
} from "@/lib/booking-template";
import {
  DEFAULT_LLM_MODEL,
  DEFAULT_QUALIFIER_FALLBACK_MODELS,
  DEFAULT_QUALIFIER_MODEL,
  DEFAULT_TOOL_FALLBACK_MODELS,
  DEFAULT_TOOL_MODEL,
} from "@/lib/llm-defaults";
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
import { listAccountAgendas } from "@/lib/tools/google-calendar.server";
import {
  notifyBooking,
  summarizeConversationForNotification,
} from "@/lib/agents/notify-booking.server";
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
import {
  applyDeterministicStageOverrides,
  detectSignals,
  inferEffectiveStage,
} from "./stage-signals";

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

/** Normaliza texto para comparação (lowercase, sem pontuação/emoji/espaços extras). */
function normalizeForSimilarity(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Compara reply atual com a última mensagem do assistente. Considera duplicado
 *  quando >70% das palavras de uma estão contidas na outra (mesmo splitada em bolhas). */
function isReplyTooSimilar(current: string, previous: string): boolean {
  const a = normalizeForSimilarity(current);
  const b = normalizeForSimilarity(previous);
  if (!a || !b) return false;
  if (a === b) return true;

  const wordsA = new Set(a.split(" ").filter((w) => w.length >= 3));
  const wordsB = new Set(b.split(" ").filter((w) => w.length >= 3));
  if (wordsA.size < 4) return false; // muito curto pra avaliar

  let matches = 0;
  for (const w of wordsA) if (wordsB.has(w)) matches++;
  const overlap = matches / wordsA.size;
  return overlap >= 0.7;
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
    .select("id, account_id, ativo, nome, system_prompt, llm_model_override, debounce_segundos, settings")
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
  const channelCtx: BookingChannelContext = { channel, effectivePhone };

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
    // Captura ANTES de qualquer mutação — usado para detectar transições de
    // agendamento (sem→com = agendou; com→sem = cancelou) e disparar a
    // notificação 1x só. slotIsoBefore guarda o horário antigo (para a msg de
    // cancelamento, já que o appointment_id/slot são limpos ao cancelar).
    const hadAppointmentBefore = !!leadData.appointment_id;
    const slotIsoBefore = (leadData.selected_slot_iso as string | undefined) ?? "";
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

    if (stage === "NAME_COLLECT" || stage === "BOOKING") {
      const backfill = backfillBookingFieldsFromHistory(
        leadData,
        history,
        agentSettings,
        channelCtx,
      );
      if (Object.keys(backfill).length > 0) {
        leadData = mergeLeadDataPatch(leadData, backfill);
        console.log(
          `[orch] backfill campos conv=${conversationId} patch=${JSON.stringify(backfill)}`,
        );
      }
    }

    // Integracoes precisam ser carregadas para os signals (hasBookingIntegration).
    const [clinicorpCfg, clinupCfg, gcalCfg, escCfg] = await Promise.all([
      sb.from("clinicorp_config").select("ativo").eq("account_id", accountId).maybeSingle(),
      sb.from("clinup_config").select("ativo").eq("account_id", accountId).maybeSingle(),
      sb.from("google_calendar_tokens").select("ativo").eq("account_id", accountId).maybeSingle(),
      sb.from("agent_escalation").select("ativo").eq("agent_id", agentId).maybeSingle(),
    ]);
    const hasBookingIntegration =
      !!clinicorpCfg.data?.ativo || !!clinupCfg.data?.ativo || !!gcalCfg.data?.ativo;

    // Agendas Google (multi-agenda). Só consulta quando o GCal está ativo.
    // Vazio = agenda única (comportamento atual). 2+ = agente escolhe via prompt.
    const googleAgendas = gcalCfg.data?.ativo ? await listAccountAgendas(accountId) : [];

    // Sinais deterministicos extraidos do historico + lead_data.
    const signals = detectSignals({
      stage,
      leadData,
      history,
      hasBookingIntegration,
    });
    const { lastUserMsg, lastAssistantMsg, slotSelectionTurn, userAcceptedSchedulingProposal } = signals;

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
      const autoPatch = tryAutoCaptureBookingAnswer(
        stage,
        leadData,
        history,
        agentSettings,
        channelCtx,
      );
      if (Object.keys(autoPatch).length > 0) {
        leadData = mergeLeadDataPatch(leadData, autoPatch);
        console.log(
          `[orch] auto-captura NAME_COLLECT conv=${conversationId} patch=${JSON.stringify(autoPatch)}`,
        );
      }
    }

    if (stage === "BOOKING" && !slotSelectionTurn) {
      const autoPatch = tryAutoCaptureBookingAnswer(
        stage,
        leadData,
        history,
        agentSettings,
        channelCtx,
      );
      if (Object.keys(autoPatch).length > 0) {
        leadData = mergeLeadDataPatch(leadData, autoPatch);
      }
    }

    // 8. Stage deterministico (effectiveStage) — calculado por stage-signals.
    const isReady = isReadyForBooking(leadData, agentSettings, {
      hasPhone: !!effectivePhone,
      hasBookingIntegration,
      channel,
      effectivePhone,
    });
    const { effectiveStage, reason: effectiveReason } = inferEffectiveStage(
      { stage, leadData, history, hasBookingIntegration },
      signals,
      isReady,
    );
    if (effectiveStage !== stage) {
      console.log(
        `[orch] effectiveStage conv=${conversationId} ${stage} → ${effectiveStage} (${effectiveReason})`,
      );
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
      qualifierModel:
        ((llm.data as Record<string, unknown> | null)?.qualifier_model as string | undefined) ??
        DEFAULT_QUALIFIER_MODEL,
      qualifierFallbackModels: [...DEFAULT_QUALIFIER_FALLBACK_MODELS],
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
      googleAgendas,
      // Modo teste: não escreve tags no CRM (tools seguem vivas).
      disableTags: agentSettings.test_mode === "true",
      history,
    };

    // 10. Roteamento por stage (usa effectiveStage para evitar qualifier preso quando lead já aceitou agendar)
    const route = routeForStage(effectiveStage);
    console.log(
      `[orch] conv=${conversationId} stage=${stage}${effectiveStage !== stage ? ` (effective=${effectiveStage})` : ""} route=${route}`,
    );

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
    const rawPatch = (result.lead_data_patch ?? {}) as Partial<LeadData>;
    const sanitized = sanitizeLeadDataPatch(rawPatch);
    // Telemetria: detecta quando o LLM tentou gravar campo invalido (lixo)
    // que o sanitizer rejeitou. Util para mapear quais modelos alucinam mais.
    const rejectedCustomFields: string[] = [];
    const rawCf = rawPatch.custom_fields ?? {};
    const sanitizedCf = sanitized.custom_fields ?? {};
    for (const k of Object.keys(rawCf)) {
      if (rawCf[k] !== sanitizedCf[k]) rejectedCustomFields.push(k);
    }
    if (rejectedCustomFields.length > 0) {
      console.warn(
        `[orch:telemetry] ${JSON.stringify({
          event: "llm_patch_sanitized",
          conv: conversationId,
          account: accountId,
          agent: agentId,
          route,
          stage_from: stage,
          model: route === "qualifier" ? ctx.qualifierModel : ctx.model,
          rejected_fields: rejectedCustomFields,
          raw_preview: JSON.stringify(rawCf).slice(0, 200),
        })}`,
      );
    }
    const patch = stripNullishFields(
      sanitized as Record<string, unknown>,
    ) as Partial<LeadData>;
    const newLeadData: LeadData = normalizeLeadDataForBooking(
      mergeLeadDataPatch(leadData, patch as Partial<LeadData>),
      { fallbackGuardianName: helenaContact?.name },
    );
    const backfillFinal = backfillBookingFieldsFromHistory(
      newLeadData,
      history,
      agentSettings,
      channelCtx,
    );
    let finalLeadData =
      Object.keys(backfillFinal).length > 0
        ? mergeLeadDataPatch(newLeadData, backfillFinal)
        : newLeadData;
    if (Object.keys(backfillFinal).length > 0) {
      console.log(
        `[orch] backfill pos-turn conv=${conversationId} patch=${JSON.stringify(backfillFinal)}`,
      );
    }

    // Cancelamento: a tool sinaliza appointment_cancelled (truthy, sobrevive ao
    // stripNullishFields). Aqui limpamos o appointment_id de fato (e, em
    // remarcação, o slot) e removemos os sinais transitórios antes de persistir.
    if (finalLeadData.appointment_cancelled) {
      const reoffer = !!finalLeadData.reoffer_after_cancel;
      finalLeadData = { ...finalLeadData };
      delete finalLeadData.appointment_id;
      delete finalLeadData.booked_tag_applied;
      delete finalLeadData.commitment_confirmed;
      if (reoffer) {
        delete finalLeadData.selected_slot_iso;
        delete finalLeadData.dentist_person_id;
        delete finalLeadData.offered_slots;
      }
      delete finalLeadData.appointment_cancelled;
      delete finalLeadData.reoffer_after_cancel;
      console.log(
        `[orch] agendamento cancelado conv=${conversationId} reoffer=${reoffer} — appointment_id limpo`,
      );
    }

    // Transição com→sem appointment_id = cancelamento efetivado neste turn.
    const appointmentJustCancelled =
      hadAppointmentBefore && !finalLeadData.appointment_id;

    const resolvedStage = resolveNextStage(stage, result.next_stage, {
      requireAppointmentForConfirmed: hasBookingIntegration,
      hasAppointmentId: !!finalLeadData.appointment_id,
      leadData: finalLeadData,
    });

    // Overrides deterministicos pos-LLM (stage-signals).
    const overrideOut = applyDeterministicStageOverrides({
      proposedNextStage: resolvedStage,
      originalStage: stage,
      effectiveStage,
      leadData: finalLeadData,
      hasBookingIntegration,
      signals,
    });
    let newStage = overrideOut.stage;
    if (overrideOut.reason) {
      console.log(
        `[orch] stage override conv=${conversationId} ${resolvedStage} → ${newStage} (${overrideOut.reason})`,
      );
    }

    let reply = result.reply;
    // Flags de telemetria do turn (vao para meta da mensagem + agent_runs).
    let duplicateReplyBlocked = false;
    let falseBookingClaimBlocked = false;
    let forcedSchedulingAdvance = userAcceptedSchedulingProposal;

    if (
      hasBookingIntegration &&
      !finalLeadData.appointment_id &&
      !appointmentJustCancelled &&
      /\b(agendei|agendado|marquei|confirmad[oa]|visita guiada para)\b/i.test(reply)
    ) {
      falseBookingClaimBlocked = true;
      console.warn(
        `[orch] reply afirma agendamento sem appointment_id conv=${conversationId} — bloqueando confirmação falsa`,
      );
      const missingFields = getMissingBookingFields(
        getBookingFieldsForChannel(agentSettings, channelCtx),
        finalLeadData,
      );
      if (finalLeadData.selected_slot_iso && missingFields.length > 0) {
        const nextField = missingFields[0]!;
        reply = `Perfeito! Anotei esse horário para você.\n\n${nextField.question}`;
        newStage = "NAME_COLLECT";
      } else if (finalLeadData.selected_slot_iso) {
        reply =
          "Perfeito! Anotei esse horário. Estou finalizando o registro na agenda e já te confirmo.";
        newStage = "BOOKING";
      } else {
        reply =
          "Desculpe, tive um problema ao registrar sua visita na agenda agora. Pode me confirmar o horário que você prefere? Vou tentar registrar de novo.";
        if (newStage === "CONFIRMED" || stage === "NAME_COLLECT" || stage === "BOOKING") {
          newStage = finalLeadData.selected_slot_iso ? "BOOKING" : "SLOT_OFFER";
        }
      }
    }

    // Guarda anti-loop: se o reply é praticamente idêntico à última msg do assistente,
    // o LLM está alucinando ao repetir conteúdo. Substitui por um avanço de proposta.
    if (lastAssistantMsg && isReplyTooSimilar(reply, lastAssistantMsg)) {
      duplicateReplyBlocked = true;
      // Log estruturado (JSON em uma linha) — facil de filtrar em Coolify/Datadog
      // para mapear quais modelos alucinam mais e em quais stages.
      console.warn(
        `[orch:telemetry] ${JSON.stringify({
          event: "duplicate_reply_blocked",
          conv: conversationId,
          account: accountId,
          agent: agentId,
          route,
          stage_from: stage,
          stage_effective: effectiveStage,
          model: route === "qualifier" ? ctx.qualifierModel : ctx.model,
          reply_preview: reply.slice(0, 120),
          prev_preview: lastAssistantMsg.slice(0, 120),
        })}`,
      );
      if (hasBookingIntegration && (stage === "QUALIFICATION" || stage === "RECEPTION")) {
        reply =
          "Vou te mostrar os horários disponíveis pra você escolher o melhor, ok? 😊";
        newStage = "SLOT_OFFER";
      } else {
        reply =
          "Me confirma só por favor: você quer seguir com o agendamento agora? Posso te mostrar os horários disponíveis.";
      }
    }

    const cfKeys = Object.keys(finalLeadData.custom_fields ?? {}).join(",");
    console.log(
      `[orch] persist conv=${conversationId} stage=${newStage} custom_fields=${cfKeys || "(vazio)"}`,
    );

    // 12. Persiste e entrega
    await persistStageAndLeadData(conversationId, meta, newStage, finalLeadData, route);

    await deliverReply(
      accountId,
      agentId,
      conversationId,
      reply,
      {
        model: route === "qualifier" ? ctx.qualifierModel : ctx.model,
        reply_model_kind: route === "qualifier" ? "qualifier" : "reply",
        latency_ms: latencyMs,
        tokens_in: result.tokens_in ?? null,
        tokens_out: result.tokens_out ?? null,
        cost_usd_estimate: result.cost_usd ?? null,
        stage_from: stage,
        stage_effective: effectiveStage,
        stage_to: newStage,
        agent: route,
        tools_called: result.tools_called,
        // Telemetria: marcadores de intervencoes deterministicas.
        duplicate_reply_blocked: duplicateReplyBlocked || undefined,
        false_booking_claim_blocked: falseBookingClaimBlocked || undefined,
        forced_scheduling_advance: forcedSchedulingAdvance || undefined,
        preflight_blocked: (result.telemetry?.preflight_blocked as boolean) || undefined,
        preflight_dirty_fields: (result.telemetry?.dirty_fields as string[]) || undefined,
        double_booking_blocked:
          (result.telemetry?.double_booking_blocked as boolean) || undefined,
      },
      sessionId,
      effectivePhone ?? conversationPhone,
    );

    // 13. Se transitou para ESCALATED, dispara escalação humana
    if (newStage === "ESCALATED" && stage !== "ESCALATED") {
      console.log(`[orch] disparando escalateToHuman — motivo: ${finalLeadData.escalation_reason}`);
      try {
        await escalateToHuman({
          accountId,
          agentId,
          phone: effectivePhone ?? conversationPhone,
          sessionId,
          helenaContactId: helenaContact?.id,
          reason: finalLeadData.escalation_reason,
          agentName: (agent.data.nome as string | undefined) ?? undefined,
          stage, // estágio em que estava antes do ESCALATED
          leadData: finalLeadData,
          history,
          orKey,
          summaryModel: ctx.ragGateModel,
          disableTags: ctx.disableTags,
        });
      } catch (e) {
        console.error("[orch] escalateToHuman falhou:", e);
      }
    }

    // 14. Notificações de agendamento — disparam na transição do appointment_id:
    //   sem→com  = agendou   → notifica "created"
    //   com→sem  = cancelou  → notifica "cancelled"
    // (Remarcar = cancela o antigo + reoferta → gera naturalmente cancelled e,
    //  depois, created quando o novo for marcado.) Reusa a config da escalada
    // (instância + grupo) com toggle próprio (notificar_agendamentos).
    const justBooked = !hadAppointmentBefore && !!finalLeadData.appointment_id;
    if (justBooked || appointmentJustCancelled) {
      try {
        const event = justBooked ? "created" : "cancelled";
        let summary = await summarizeConversationForNotification(
          ctx.orKey,
          ctx.ragGateModel,
          history,
        );
        if (!summary) summary = (finalLeadData.notes as string | undefined) ?? "";
        await notifyBooking({
          agentId,
          accountId,
          event,
          patientName:
            resolveBookingLeadName(finalLeadData) ||
            (finalLeadData.name as string | undefined) ||
            "(sem nome)",
          phone: effectivePhone ?? conversationPhone,
          datetimeIso: justBooked
            ? (finalLeadData.selected_slot_iso as string | undefined) ?? ""
            : slotIsoBefore,
          appointmentLabel: agentSettings.appointment_type_label || "Consulta",
          summary,
        });
      } catch (e) {
        console.error("[orch] notifyBooking falhou:", e);
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
