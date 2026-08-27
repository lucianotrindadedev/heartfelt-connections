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
import { buildSlotOfferFallback } from "./slot-offer-fallback";
import { claimsBookingWithoutAppointment, noBookingYetReply } from "./false-booking-claim";
import { closedAgendaSafeReply, unfoundedClosedAgendaClaim } from "./closed-agenda-claim";
import { activeWeekdayKeys } from "@/lib/tools/google-calendar.server";
import {
  normalizeBrazilPhone,
  resolveEffectivePhone,
  type ConversationChannel,
} from "@/lib/conversation-channel.server";
import {
  agentUsesTurmaClassifier,
  backfillBookingFieldsFromHistory,
  bookingFieldQuestion,
  captureLeadPhoneFromHistory,
  hasBookingPhone,
  resolveLeadPhone,
  defaultCommitmentQuestion,
  getBookingFieldsForChannel,
  getMissingBookingFields,
  isCommitmentRequired,
  isPointingGesture,
  isReadyForBooking,
  pointingConfirmationReply,
  slotsOfferedInLastTurn,
  type BookingChannelContext,
  looksLikeSchedulingPreference,
  looksLikeSentenceNotName,
  mergeLeadDataPatch,
  nameIsAttendantSelfIntroduction,
  normalizeLeadDataForBooking,
  resolveBookingLeadName,
  sanitizeLeadDataPatch,
  signalsCannotAttendOrChange,
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
import { leadSkippedOptionsQuestion } from "@/lib/agents/pending-question";
import {
  resolveLeads360Config,
  sendLeads360Lead,
  sendLeads360Interest,
  sendLeads360Scheduled,
  sendLeads360Transfer,
} from "@/lib/integrations/leads360.server";
import {
  MIN_INTER_PART_DELAY_MS,
  splitMessage,
  stripProtectedMarkers,
  typingDelayMs,
} from "@/lib/message-splitter.server";
import { haltConversationForNoCredits } from "@/lib/credits.server";
import { isInsufficientCreditsError } from "@/lib/agents/llm.server";
import { escalateToHuman } from "@/lib/tools/escalate-human.server";
import { listAccountAgendas } from "@/lib/tools/google-calendar.server";
import { notifyBooking } from "@/lib/agents/notify-booking.server";
import { isAgentMutedNow, scheduleMuteReason } from "@/lib/agent-schedule";
import type { AgentContext, AgentResult } from "./context";
import { stripNullishFields } from "./parse-llm-json.server";
import { runQualifierAgent } from "./qualifier.server";
import { runSchedulerAgent } from "./scheduler.server";
import {
  INITIAL_STAGE,
  isStage,
  resolveNextStage,
  routeForStage,
  clampStageForBooking,
  stageAfterResume,
  type LeadData,
  type Stage,
} from "./stage";
import { AI_DISABLED_TAG, findBlockingTag } from "@/lib/agent-block.server";
import {
  applyDeterministicStageOverrides,
  detectSignals,
  inferEffectiveStage,
  looksLikeStallReply,
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

/**
 * Remove horários JÁ PASSADOS de offered_slots e limpa selected_slot_iso quando
 * ele aponta para o passado. Necessário porque offered_slots persiste em
 * lead_data por toda a conversa: se o lead some por dias e volta, o agente
 * reofertava os slots antigos (ex.: hoje 30/06 oferecendo 26/06) em vez de
 * consultar a agenda de novo. Ao esvaziar os slots, o scheduler é forçado a
 * chamar listar_horarios antes de ofertar.
 */
function pruneStalePastSlots(
  leadData: LeadData,
  now: Date,
): { leadData: LeadData; changed: boolean } {
  const nowMs = now.getTime();
  const isFuture = (iso?: string): boolean => {
    if (!iso) return false;
    const t = new Date(iso).getTime();
    return !isNaN(t) && t > nowMs;
  };

  let changed = false;
  const next: LeadData = { ...leadData };

  if (Array.isArray(next.offered_slots) && next.offered_slots.length > 0) {
    const future = next.offered_slots.filter((s) => isFuture(s.iso));
    if (future.length !== next.offered_slots.length) {
      changed = true;
      if (future.length > 0) next.offered_slots = future;
      else delete next.offered_slots;
    }
  }

  // selected_slot_iso no passado nunca deve virar agendamento — limpa para o
  // agente reofertar. (Só quando ainda NÃO há appointment_id: um agendamento já
  // criado é tratado pelo fluxo de cancelamento/remarcação, não aqui.)
  if (!next.appointment_id && next.selected_slot_iso && !isFuture(next.selected_slot_iso)) {
    delete next.selected_slot_iso;
    delete next.dentist_person_id;
    changed = true;
  }

  return { leadData: next, changed };
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
  // Custo do splitter LLM (quando as regras não dividem e cai no modelo): soma-se
  // ao cost_usd_estimate do turn. Sem isto ele rodava "de graça" na telemetria —
  // era uma das lacunas do custo real por conversa.
  const splitCost = { costUsd: 0, tokensIn: 0, tokensOut: 0 };
  const parts = await splitMessage(reply, accountId, (c) => {
    splitCost.costUsd += c.costUsd;
    splitCost.tokensIn += c.tokensIn;
    splitCost.tokensOut += c.tokensOut;
  });
  console.log(
    `[orch] split ${parts.length} parte(s) — ${parts.map((p) => p.length).join("+")} chars (total ${reply.length})`,
  );
  const metaCostUsd = (Number(meta.cost_usd_estimate) || 0) + splitCost.costUsd;
  const metaTokensIn = (Number(meta.tokens_in) || 0) + splitCost.tokensIn;
  const metaTokensOut = (Number(meta.tokens_out) || 0) + splitCost.tokensOut;

  const helena = await loadHelenaAccount(accountId);

  // Entrega bolha por bolha pelo endpoint PADRÃO /chat/v1/session/{id}/message
  // (o MESMO do follow-up, que entrega de verdade). O /message/sync (viaWhatsApp)
  // retornava 200 mas NÃO entregava ao WhatsApp em respostas multi-bolha — a
  // resposta do agente "sumia" enquanto o follow-up chegava. As pausas entre
  // partes (>=1,2s) já mantêm as bolhas separadas sem precisar do /sync.
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
    });
    if (!sendRes.ok) {
      await delay(500);
      sendRes = await sendHelenaText(helena, {
        phone,
        text: parts[i],
        sessionId,
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
    // Sem os marcadores [[NOSPLIT]] — não devem aparecer no histórico/CRM.
    content: stripProtectedMarkers(reply),
    meta: {
      origem: "agente",
      delivery_status: sentCount === parts.length ? "delivered" : "partial",
      delivered_parts: sentCount,
      split_parts: parts.length,
      split_preview: parts.map((p) => p.slice(0, 80)),
      ...meta,
      // Sobrescreve os campos de custo de `meta` com o total que inclui o
      // splitter (o spread acima traz os valores pré-splitter).
      cost_usd_estimate: metaCostUsd,
      tokens_in: metaTokensIn,
      tokens_out: metaTokensOut,
      split_cost_usd: splitCost.costUsd || undefined,
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
    tokens_in: metaTokensIn,
    tokens_out: metaTokensOut,
    cost_usd_estimate: metaCostUsd,
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

  // Atendimento programado: dentro da janela da equipe humana o agente fica
  // calado. O webhook já barra o disparo, mas repetimos aqui porque este turn
  // também é chamado pela fila (pg_cron/Redis), pelo cron de retomada e pelo
  // diag — e a janela pode ter começado DEPOIS do enfileiramento (msg às 07:59
  // com debounce de 20s executaria 08:00, já dentro do silêncio).
  // NÃO apaga nem ignora mensagem: o histórico já foi gravado pelo webhook.
  if (isAgentMutedNow((agent.data.settings as Record<string, string> | null) ?? {})) {
    console.log(
      `[orch] turn ignorado conv=${conversationId} — ${scheduleMuteReason()} (histórico preservado)`,
    );
    return;
  }

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
    .select("default_model, max_tokens, temperature, model_temperatures, fallback_models, rag_gate_model, tool_model")
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
      // Desempate por id: em rajadas com mesmo criado_em a ordem fica estável.
      .order("criado_em", { ascending: false })
      .order("id", { ascending: false })
      .limit(MAX_HISTORY);
    if (msgs.error) throw new Error(msgs.error.message);

    const ordered = (msgs.data ?? []).slice().reverse() as MsgRow[];
    const history: { role: "user" | "assistant"; content: string }[] = [];
    // Respostas que ESTE agente de fato gerou (origem="agente"), em ordem.
    //
    // O guard anti-loop comparava com a última mensagem `assistant` do
    // histórico — mas a Helena reentrega cada envio quebrado em partes, e essas
    // partes chegam como assistant/origem="humano" SEM is_echo. Resultado: a
    // referência de comparação virava um fragmento ("Como devo registrar?") em
    // vez da resposta inteira, a similaridade não batia e o guard NUNCA
    // disparava. Caso real (Odonto Carioca Campo Grande, 21 97558-2703, 03/08):
    // a mesma pergunta de nome saiu 4x seguidas, ignorando 3 perguntas diretas
    // do lead, sem nenhum duplicate_reply_blocked no meta.
    const agentReplies: string[] = [];
    for (const m of ordered) {
      if (m.meta && (m.meta as Record<string, unknown>).fallback === true) continue;
      // Eco/loopback da Helena (mensagem que a própria plataforma enviou e voltou
      // pelo webhook). Marcado is_echo=true no webhook e na limpeza — nunca entra
      // no histórico do LLM (poluía o contexto e misturava leads).
      if (m.meta && (m.meta as Record<string, unknown>).is_echo === true) continue;
      // Eventos vazios (TRACK/status, mídia sem legenda) só confundem o LLM.
      if (!(m.content ?? "").trim()) continue;
      if (m.role === "user") history.push({ role: "user", content: m.content ?? "" });
      else if (m.role === "assistant") {
        history.push({ role: "assistant", content: m.content ?? "" });
        if ((m.meta as Record<string, unknown> | null)?.origem === "agente") {
          agentReplies.push(m.content ?? "");
        }
      }
    }

    // Última fala do agente — é a ela que o lead está respondendo. Usada para
    // saber se ACABAMOS de pedir o sobrenome: nesse caso a resposta ("Souza")
    // completa o nome que já temos em vez de substituí-lo.
    const lastAssistantText =
      [...history].reverse().find((m) => m.role === "assistant")?.content ?? "";

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
    let stage = readStageFromMeta(meta);
    let leadData = readLeadDataFromMeta(meta);
    // Poda horários já passados (offered_slots/selected_slot_iso) ANTES de
    // qualquer lógica de slot — evita reofertar horário no passado quando a
    // conversa reativa depois de dias.
    {
      const pruned = pruneStalePastSlots(leadData, new Date());
      if (pruned.changed) {
        leadData = pruned.leadData;
        console.log(`[orch] slots passados removidos conv=${conversationId}`);
      }
    }

    // ── Retomada de conversa escalada ──────────────────────────────────────
    // ESCALATED é terminal na máquina de estados: o orquestrador se cala e
    // NENHUMA mensagem posterior é respondida. A saída era o humano "reativar"
    // — só que reativar (comando /ativar ou tirar a etiqueta na mão no CRM)
    // mexia APENAS na etiqueta "IA Desligada" e deixava o stage em ESCALATED.
    // Resultado: etiqueta limpa, lead escrevendo, IA muda para sempre. Caso
    // real (Dental Clinic Corcovado, 21 99818-0091): escalada em 21/08 porque
    // o assunto não era odontológico, etiqueta já removida, e as mensagens de
    // 27/08 — inclusive o "Teste IA" da própria clínica — não tiveram resposta.
    //
    // A etiqueta é a fonte da verdade do pause em todo o resto do código
    // (webhook, follow-up, warm-up); aqui também é. Chegar neste ponto já
    // significa que o webhook não viu etiqueta bloqueadora (senão nem teria
    // disparado o turn), mas confirmamos no contato carregado antes de voltar
    // a falar. Contato ilegível → silêncio, o mesmo fail-safe do webhook.
    if (stage === "ESCALATED") {
      if (!helenaContact) {
        console.log(
          `[orch] conv=${conversationId} ESCALATED e contato do CRM não carregou — mantendo silêncio`,
        );
        return;
      }
      const stillPaused = findBlockingTag(helenaContact.tagNames, [AI_DISABLED_TAG]);
      if (stillPaused) {
        console.log(
          `[orch] conv=${conversationId} ESCALATED com etiqueta "${stillPaused}" — mantendo silêncio`,
        );
        return;
      }
      const resumedStage = stageAfterResume(leadData);
      console.log(
        `[orch] conv=${conversationId} retomada após escalada — etiqueta "${AI_DISABLED_TAG}" ausente, ESCALATED → ${resumedStage}`,
      );
      stage = resumedStage;
      // Motivo da escalada some junto: ele descreve um atendimento que o humano
      // já assumiu e encerrou. Mantê-lo faria o agente responder o lead ainda
      // sob o contexto de "isto aqui precisa de humano". String vazia, não
      // undefined — stripNullishFields apaga a chave em vez de zerar o valor
      // (o campo ficava grudento e voltava no turn seguinte).
      leadData = { ...leadData, escalation_reason: "" };
    }
    // Captura ANTES de qualquer mutação — usado para detectar transições de
    // agendamento (sem→com = agendou; com→sem = cancelou) e disparar a
    // notificação 1x só. slotIsoBefore guarda o horário antigo (para a msg de
    // cancelamento, já que o appointment_id/slot são limpos ao cancelar).
    const hadAppointmentBefore = !!leadData.appointment_id;
    const slotIsoBefore = (leadData.selected_slot_iso as string | undefined) ?? "";
    // Interesse ANTES do turn — para enviar ao Leads360 só quando muda/é definido.
    const interestBefore = (leadData.interest ?? "").trim();
    const leads360Synced = !!leadData.leads360_lead_sent;
    const agentSettings = (agent.data.settings as Record<string, string> | null) ?? {};

    // Telefone para REGISTRO/AVISO (equipe da clínica, escalação, Leads360) —
    // NÃO para entrega (o Helena entrega por sessionId, ignora o phone).
    // Prefere um telefone de verdade: o do canal ou o que o lead digitou. Em
    // Instagram/Messenger `conversationPhone` é a CHAVE da conversa ("ig:fulano"),
    // que a clínica não consegue ligar de volta — só cai nela como último recurso.
    const recordPhone = (ld: LeadData): string =>
      resolveLeadPhone(ld, agentSettings, effectivePhone, normalizeBrazilPhone) ??
      conversationPhone;

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
    const [clinicorpCfg, clinupCfg, gcalCfg, clinicExpertsCfg, escCfg, gsheetsCfg] =
      await Promise.all([
        sb.from("clinicorp_config").select("ativo").eq("account_id", accountId).maybeSingle(),
        sb
          .from("clinup_config")
          .select("ativo, professionals")
          .eq("account_id", accountId)
          .maybeSingle(),
        sb.from("google_calendar_tokens").select("ativo").eq("account_id", accountId).maybeSingle(),
        sb
          .from("clinic_experts_config")
          .select("ativo, professionals, unidades")
          .eq("account_id", accountId)
          .maybeSingle(),
        sb.from("agent_escalation").select("ativo").eq("agent_id", agentId).maybeSingle(),
        sb
          .from("google_sheets_config")
          .select("ativo, planilhas")
          .eq("account_id", accountId)
          .maybeSingle(),
      ]);
    const hasBookingIntegration =
      !!clinicorpCfg.data?.ativo ||
      !!clinupCfg.data?.ativo ||
      !!gcalCfg.data?.ativo ||
      !!clinicExpertsCfg.data?.ativo;

    // Agendas Google (multi-agenda). Só consulta quando o GCal está ativo.
    // Vazio = agenda única (comportamento atual). 2+ = agente escolhe via prompt.
    const googleAgendas = gcalCfg.data?.ativo ? await listAccountAgendas(accountId) : [];

    // Profissionais do Clinic Experts (a API não expõe expediente próprio — a
    // config já guarda uuid/name/duracao/business_hours_json de cada um).
    const clinicExpertsProfessionals = clinicExpertsCfg.data?.ativo
      ? (
          (Array.isArray(clinicExpertsCfg.data.professionals)
            ? (clinicExpertsCfg.data.professionals as Record<string, unknown>[])
            : []
          )
            .map((p) => ({
              uuid: String(p.uuid ?? ""),
              name: String(p.name ?? ""),
              duracaoMinutos: typeof p.duracao_minutos === "number" ? p.duracao_minutos : undefined,
              businessHoursJson:
                typeof p.business_hours_json === "string" ? p.business_hours_json : undefined,
            }))
            .filter((p) => p.uuid)
        )
      : [];

    // Unidades do Clinic Experts (multi-unidade). Vazio = unidade única
    // (config top-level). Com 2+ o scheduler injeta o parâmetro `agenda` (enum
    // dos labels) nas tools — mesmo contrato do multi-agenda Google. Sem
    // tokens aqui: só metadados pra prompt/diagnóstico.
    const clinicExpertsUnidades = clinicExpertsCfg.data?.ativo
      ? (
          (Array.isArray((clinicExpertsCfg.data as { unidades?: unknown }).unidades)
            ? ((clinicExpertsCfg.data as { unidades: Record<string, unknown>[] }).unidades)
            : []
          )
            .map((u) => ({
              label: String(u.label ?? "").trim(),
              descricao: typeof u.descricao === "string" && u.descricao ? u.descricao : undefined,
              professionalsCount: Array.isArray(u.professionals) ? u.professionals.length : 0,
            }))
            .filter((u) => u.label)
        )
      : [];

    // Profissionais habilitados no Clinup. Só é usado para diagnosticar
    // "0 horários" (nenhum habilitado vs agenda cheia) — o id do profissional
    // viaja no próprio slot ofertado, o LLM nunca escolhe.
    const clinupProfessionals = clinupCfg.data?.ativo
      ? (
          (Array.isArray((clinupCfg.data as { professionals?: unknown }).professionals)
            ? ((clinupCfg.data as { professionals: Record<string, unknown>[] }).professionals)
            : []
          )
            .map((p) => ({
              id: String(p.id ?? ""),
              name: String(p.name ?? ""),
              duracaoMinutos: typeof p.duracao_minutos === "number" ? p.duracao_minutos : undefined,
              businessHoursJson:
                typeof p.business_hours_json === "string" ? p.business_hours_json : undefined,
            }))
            .filter((p) => p.id)
        )
      : [];

    // Planilhas Google consultáveis. Conectar sem cadastrar planilha não vale
    // como integração ativa — a tool ficaria sem fonte de dado.
    const googleSheets = gsheetsCfg.data?.ativo
      ? (Array.isArray((gsheetsCfg.data as { planilhas?: unknown }).planilhas)
          ? (gsheetsCfg.data as { planilhas: Record<string, unknown>[] }).planilhas
          : []
        )
          .map((p) => ({
            label: String(p.label ?? ""),
            spreadsheetId: String(p.spreadsheet_id ?? ""),
            aba: typeof p.aba === "string" ? p.aba : undefined,
            descricao: typeof p.descricao === "string" ? p.descricao : undefined,
          }))
          .filter((p) => p.label && p.spreadsheetId)
      : [];

    // Sinais deterministicos extraidos do historico + lead_data.
    const signals = detectSignals({
      stage,
      leadData,
      history,
      hasBookingIntegration,
    });
    const { lastUserMsg, lastAssistantMsg, slotSelectionTurn, userAcceptedSchedulingProposal } = signals;

    // RECEPTION/QUALIFICATION incluídos — o qualifier também oferta horários
    // (ver tryAutoSelectOfferedSlot). A função é no-op sem offered_slots.
    if (
      stage === "RECEPTION" ||
      stage === "QUALIFICATION" ||
      stage === "SLOT_OFFER" ||
      stage === "NAME_COLLECT" ||
      stage === "BOOKING"
    ) {
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

    // Telefone digitado pelo lead em canal SEM telefone no contexto
    // (Instagram/Messenger). Não é um booking_field declarado, então gravá-lo
    // dependia do LLM lembrar — quando não lembrava, criar_agendamento
    // respondia "telefone ausente" e o agente repetia a pergunta em loop.
    if (stage === "SLOT_OFFER" || stage === "NAME_COLLECT" || stage === "BOOKING") {
      const phonePatch = captureLeadPhoneFromHistory(
        leadData,
        history,
        agentSettings,
        channelCtx,
        normalizeBrazilPhone,
      );
      if (Object.keys(phonePatch).length > 0) {
        leadData = mergeLeadDataPatch(leadData, phonePatch);
        console.log(`[orch] telefone do lead capturado conv=${conversationId} canal=${channel}`);
      }
    }

    // 8. Stage deterministico (effectiveStage) — calculado por stage-signals.
    const isReady = isReadyForBooking(leadData, agentSettings, {
      // Inclui o telefone coletado na conversa — sem isso, Instagram/Messenger
      // nunca chegavam a BOOKING (ver captureLeadPhoneFromHistory).
      hasPhone: hasBookingPhone(leadData, agentSettings, effectivePhone, normalizeBrazilPhone),
      hasBookingIntegration,
      channel,
      effectivePhone,
    });
    const { effectiveStage: effectiveStageRaw, reason: effectiveReason } = inferEffectiveStage(
      { stage, leadData, history, hasBookingIntegration },
      signals,
      isReady,
    );
    // Agente sem agenda nunca opera em estágio de agendamento → mantém o
    // qualifier (prompt do agente) no comando, em vez de cair no scheduler.
    const effectiveStage = clampStageForBooking(effectiveStageRaw, hasBookingIntegration);
    if (effectiveStage !== effectiveStageRaw) {
      console.log(
        `[orch] sem agenda — estágio rebaixado conv=${conversationId} ${effectiveStageRaw} → ${effectiveStage}`,
      );
    }
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
      // O qualifier é quem responde o lead nas fases RECEPTION/QUALIFICATION
      // (ver routeForStage). Deve usar EXATAMENTE o modelo/fallback que a conta
      // configurou (default_model + fallback_models), não um modelo fixo. A
      // coluna opcional qualifier_model, se existir e estiver preenchida, ainda
      // sobrescreve — mas o padrão é o modelo principal configurado.
      qualifierModel:
        ((llm.data as Record<string, unknown> | null)?.qualifier_model as string | undefined) ??
        (llm.data?.default_model as string | undefined) ??
        DEFAULT_QUALIFIER_MODEL,
      qualifierFallbackModels:
        (llm.data?.fallback_models as string[] | undefined) ??
        [...DEFAULT_QUALIFIER_FALLBACK_MODELS],
      toolModel:
        (llm.data?.tool_model as string | undefined) ?? DEFAULT_TOOL_MODEL,
      toolFallbackModels:
        (llm.data?.fallback_models as string[] | undefined) ??
        [...DEFAULT_TOOL_FALLBACK_MODELS],
      fallbackModels:
        (llm.data?.fallback_models as string[] | undefined) ??
        ["openai/gpt-4o-mini", "anthropic/claude-haiku-4.5"],
      ragGateModel:
        (llm.data?.rag_gate_model as string | undefined) ?? DEFAULT_LLM_MODEL,
      maxTokens: (llm.data?.max_tokens as number | undefined) ?? 1024,
      temperature: (llm.data?.temperature as number | undefined) ?? 0.5,
      modelTemperatures:
        (llm.data?.model_temperatures as Record<string, number> | undefined) ?? {},
      orKey,
      integrations: {
        clinicorp: !!clinicorpCfg.data?.ativo,
        clinup: !!clinupCfg.data?.ativo,
        googleCalendar: !!gcalCfg.data?.ativo,
        clinicExperts: !!clinicExpertsCfg.data?.ativo,
        escalation: !!escCfg.data?.ativo,
        googleSheets: googleSheets.length > 0,
      },
      googleAgendas,
      googleSheets,
      clinicExpertsProfessionals,
      clinicExpertsUnidades,
      clinupProfessionals,
      // Modo teste: não escreve tags no CRM (tools seguem vivas).
      disableTags: agentSettings.test_mode === "true",
      history,
    };

    // 10. Roteamento por stage (usa effectiveStage para evitar qualifier preso quando lead já aceitou agendar)
    let route = routeForStage(effectiveStage);
    // Segurança extra: agente sem agenda nunca usa o scheduler (prompt de
    // agendamento). O clamp de effectiveStage acima já garante isso, mas
    // mantemos o guard caso algum estágio futuro escape do clamp.
    if (route === "scheduler" && !hasBookingIntegration) {
      route = "qualifier";
    }
    // ── MODO UNIFICADO (Fase 2) ────────────────────────────────────────────
    // `agents.settings.agent_mode = "unified"`: um agente só conduz tudo. Não
    // há repasse porque não há para quem repassar — a classe inteira de bug de
    // transição desaparece. Exige agenda ativa: sem tools de agendamento o
    // prompt unificado viraria o mesmo "agente sem agenda inventando fluxo de
    // agendamento" que o clampStageForBooking existe para evitar.
    //
    // Contas com classificador de turma ficam de FORA: a tag de turma é
    // aplicada de forma determinística dentro do qualifier
    // (applyTurmaTagDeterministic, calculada a partir da data de nascimento).
    // Em modo unificado o qualifier nunca roda e a turma jamais seria
    // etiquetada — o lead entraria no CRM sem turma e o guard de idempotência
    // reaplicaria tag errada. Portar isso para o modo unificado é trabalho
    // próprio; até lá, essas contas seguem no fluxo dividido.
    const unifiedRequested =
      (agentSettings.agent_mode ?? "").trim().toLowerCase() === "unified";
    const unifiedBlockedByTurma =
      unifiedRequested && agentUsesTurmaClassifier(agentSettings);
    const unifiedMode = unifiedRequested && hasBookingIntegration && !unifiedBlockedByTurma;
    if (unifiedRequested && !unifiedMode) {
      console.warn(
        `[orch] agent_mode=unified IGNORADO conv=${conversationId} — ${
          unifiedBlockedByTurma ? "conta usa classificador de turma" : "conta sem agenda ativa"
        }`,
      );
    }
    if (unifiedMode && route === "qualifier") {
      route = "scheduler";
    }
    console.log(
      `[orch] conv=${conversationId} stage=${stage}${effectiveStage !== stage ? ` (effective=${effectiveStage})` : ""} route=${route}${unifiedMode ? " mode=unified" : ""}`,
    );

    let result: AgentResult;
    let sameTurnHandoff = false;
    // Stage sob o qual o SCHEDULER rodou no repasse em cascata. A tabela de
    // transições é validada a partir dele, não do stage persistido: com
    // stage=QUALIFICATION, um next_stage="NAME_COLLECT" vindo do scheduler
    // seria barrado como pulo ilegal e a conversa voltaria pro qualifier no
    // turno seguinte — desfazendo o repasse que acabou de acontecer.
    let handoffStage: Stage | null = null;
    const t0 = Date.now();
    try {
      if (route === "qualifier") {
        result = await runQualifierAgent(ctx);

        // ── REPASSE NO MESMO TURN (qualifier → scheduler) ──────────────────
        // Antes, quando o qualifier decidia "hora de agendar", o turn ACABAVA
        // ali: o lead recebia a resposta do qualifier (sem horário) e só via
        // horário na mensagem SEGUINTE — quando via. Todo o custo dessa espera
        // caía no lead, e se ele desistisse no meio, a conversa morria na
        // promessa. Aqui o scheduler roda em cascata NO MESMO turn e a resposta
        // dele é a que vai pro lead.
        //
        // Só dispara quando o qualifier NÃO trouxe horário real: se ele já
        // chamou listar_horarios e ofertou (caminho comum agora que ele tem a
        // tool), a resposta dele já serve e não gastamos uma segunda chamada.
        const proposedStage = isStage(result.next_stage) ? result.next_stage : ctx.stage;
        const handsOffToScheduler =
          routeForStage(clampStageForBooking(proposedStage, hasBookingIntegration)) ===
          "scheduler";
        const qualifierOfferedRealSlots =
          (result.tools_called ?? []).includes("listar_horarios") &&
          ((result.lead_data_patch?.offered_slots?.length ?? 0) > 0);
        // Enrolação ("vou verificar a agenda") sem repasse proposto: o guard
        // anti-stall lá embaixo salvaria com um texto genérico. Melhor deixar o
        // scheduler responder de verdade.
        const stalledOnAgenda = !handsOffToScheduler && looksLikeStallReply(result.reply);

        if (
          hasBookingIntegration &&
          (handsOffToScheduler || stalledOnAgenda) &&
          !qualifierOfferedRealSlots &&
          proposedStage !== "ESCALATED"
        ) {
          handoffStage = handsOffToScheduler ? proposedStage : "SLOT_OFFER";
          const qualifierPatch = sanitizeLeadDataPatch(
            (result.lead_data_patch ?? {}) as Partial<LeadData>,
            { current: leadData, lastAssistantText },
          );
          const schedulerCtx: AgentContext = {
            ...ctx,
            stage: handoffStage,
            leadData: normalizeLeadDataForBooking(
              mergeLeadDataPatch(leadData, qualifierPatch as Partial<LeadData>),
              { fallbackGuardianName: helenaContact?.name },
            ),
          };
          console.log(
            `[orch] repasse no mesmo turn conv=${conversationId} qualifier → scheduler (stage=${handoffStage}, motivo=${handsOffToScheduler ? "next_stage" : "stall"})`,
          );
          // Try PRÓPRIO: a cascata é um BÔNUS (responder melhor no mesmo turn).
          // Se ela falhar — API de agenda fora do ar, token revogado, timeout do
          // LLM —, o certo é entregar a resposta que o qualifier JÁ produziu, não
          // deixar o erro subir para o catch externo e trocar tudo por "tive uma
          // instabilidade técnica". Sem isto, uma falha transitória da agenda
          // (vista de verdade no diagnóstico de 28/07: um 400 isolado do Google)
          // apagaria uma resposta perfeitamente boa.
          let schedulerResult: AgentResult | null = null;
          try {
            schedulerResult = await runSchedulerAgent(schedulerCtx);
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            console.error(
              `[orch] repasse no mesmo turn FALHOU conv=${conversationId} — mantendo a resposta do qualifier: ${msg.slice(0, 200)}`,
            );
            handoffStage = null; // a transição volta a partir do stage original
          }

          if (schedulerResult) {
            sameTurnHandoff = true;
            route = "scheduler";
            // A reply do qualifier é DESCARTADA de propósito — quem fala com o
            // lead é o scheduler, que tem os horários reais. O que o qualifier
            // APRENDEU (nome, interesse, notes, tags) é preservado no patch.
            result = {
              ...schedulerResult,
              lead_data_patch: {
                ...qualifierPatch,
                ...(schedulerResult.lead_data_patch ?? {}),
              },
              tools_called: [
                ...(result.tools_called ?? []),
                ...(schedulerResult.tools_called ?? []),
              ],
              tokens_in: (result.tokens_in ?? 0) + (schedulerResult.tokens_in ?? 0),
              tokens_out: (result.tokens_out ?? 0) + (schedulerResult.tokens_out ?? 0),
              cost_usd: (result.cost_usd ?? 0) + (schedulerResult.cost_usd ?? 0),
              telemetry: {
                ...(result.telemetry ?? {}),
                ...(schedulerResult.telemetry ?? {}),
                same_turn_handoff: handsOffToScheduler ? "next_stage" : "stall",
              },
            };
          }
        }
      } else if (route === "scheduler") {
        result = await runSchedulerAgent(ctx);
      } else {
        // ESCALATED — inalcançável: a retomada acima ou devolve um stage vivo
        // ou já deu return. Fica como rede de segurança para não falar com o
        // lead num estado que ninguém previu.
        console.warn(`[orch] conv=${conversationId} route=escalation inesperado — silêncio`);
        return;
      }
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);
      console.error(`[orch] sub-agente ${route} falhou: ${errMsg}`);

      // SALDO ZERADO NA OPENROUTER — não é instabilidade e o lead não pode
      // pagar por isso. Antes, o 402 caía no fallback educado abaixo: o lead
      // recebia "tive uma instabilidade técnica, manda de novo", reenviava,
      // falhava de novo — e ninguém era avisado de que o problema era saldo.
      // Agora a IA fica em SILÊNCIO neste contato (etiqueta "IA Desligada", que
      // o webhook/follow-up/warm-up já respeitam) e o grupo de notificações
      // recebe o alerta de saldo. A atendente humana assume o atendimento até a
      // recarga; ao remover a etiqueta, a IA volta.
      if (isInsufficientCreditsError(e)) {
        await haltConversationForNoCredits({
          accountId,
          agentId,
          conversationId,
          agentName: (agent.data.nome as string | undefined) ?? undefined,
          helenaContactId: helenaContact?.id,
          currentTags: helenaContact?.tagNames,
          leadName: (leadData.name as string | undefined) || helenaContact?.name,
          phone: recordPhone(leadData),
          erro: errMsg,
          disableTags: ctx.disableTags,
        });
        return;
      }

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
    const sanitized = sanitizeLeadDataPatch(rawPatch, { current: leadData, lastAssistantText });
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

    // O nome capturado é da ATENDENTE, não do lead. A atendente humana digita
    // pelo WhatsApp da clínica e suas mensagens ficam com role="assistant" — no
    // histórico do LLM são indistinguíveis das falas do agente, então um "me
    // chamo Val" vira lead_data.name="Val". Caso real (Odonto Carioca Campo
    // Grande, 21 96932-0210): a conversa inteira chamou a LEAD de Val.
    if (
      newLeadData.name &&
      nameIsAttendantSelfIntroduction(
        newLeadData.name,
        history.filter((m) => m.role === "assistant").map((m) => m.content),
      )
    ) {
      console.warn(
        `[orch:telemetry] ${JSON.stringify({
          event: "nome_da_atendente_descartado",
          conv: conversationId,
          account: accountId,
          agent: agentId,
          nome_descartado: newLeadData.name,
        })}`,
      );
      newLeadData.name = "";
    }
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
      delete finalLeadData.booked_slot_iso;
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

    // Retorno agendado ("me chama amanhã"): segura os follow-ups até a data.
    // Como o orquestrador SÓ roda quando o lead manda mensagem, se este turn
    // NÃO definiu um novo retomar_em, o lead re-engajou → cancela qualquer
    // retorno agendado anterior e volta ao fluxo normal.
    if (!patch.retomar_em && finalLeadData.retomar_em) {
      finalLeadData = { ...finalLeadData };
      delete finalLeadData.retomar_em;
      delete finalLeadData.retorno_motivo;
      console.log(`[orch] retorno agendado cancelado conv=${conversationId} — lead re-engajou`);
    } else if (patch.retomar_em) {
      console.log(
        `[orch] retorno agendado conv=${conversationId} retomar_em=${finalLeadData.retomar_em} motivo=${finalLeadData.retorno_motivo ?? "-"}`,
      );
    }

    // Transição com→sem appointment_id = cancelamento efetivado neste turn.
    const appointmentJustCancelled =
      hadAppointmentBefore && !finalLeadData.appointment_id;

    // No repasse em cascata quem "estava rodando" era o scheduler no
    // handoffStage — é dele que a transição parte.
    const stageForTransition: Stage = handoffStage ?? stage;
    const resolvedStage = resolveNextStage(stageForTransition, result.next_stage, {
      requireAppointmentForConfirmed: hasBookingIntegration,
      hasAppointmentId: !!finalLeadData.appointment_id,
      leadData: finalLeadData,
    });

    // Overrides deterministicos pos-LLM (stage-signals).
    const overrideOut = applyDeterministicStageOverrides({
      proposedNextStage: resolvedStage,
      originalStage: stageForTransition,
      effectiveStage: handoffStage ?? effectiveStage,
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
    // Agente sem agenda: o estágio persistido nunca pode ser de agendamento
    // (senão a conversa fica "presa" no scheduler no próximo turn). Mantém em
    // QUALIFICATION para o qualifier/prompt do agente conduzir a venda.
    {
      const clamped = clampStageForBooking(newStage, hasBookingIntegration);
      if (clamped !== newStage) {
        console.log(
          `[orch] sem agenda — newStage rebaixado conv=${conversationId} ${newStage} → ${clamped}`,
        );
        newStage = clamped;
      }
    }

    // Guard anti escalada-fantasma: ESCALATED sem escalation_reason e sem o
    // lead ter pedido humano é quase sempre alucinação (JSON truncado, modelo
    // fraco). Escalar silencia a IA permanentemente — bloqueia e mantém o
    // stage para a conversa continuar viva.
    if (newStage === "ESCALATED" && stage !== "ESCALATED") {
      const explicitHumanAsk =
        /\b(humano|atendente|falar com (?:algu[ée]m|uma pessoa|o respons[áa]vel|a equipe|o gerente)|pessoa (?:real|de verdade)|atendimento humano)\b/i.test(
          lastUserMsg,
        );
      if (!finalLeadData.escalation_reason?.trim() && !explicitHumanAsk) {
        console.warn(
          `[orch:telemetry] ${JSON.stringify({
            event: "escalation_blocked_no_reason",
            conv: conversationId,
            account: accountId,
            agent: agentId,
            route,
            stage_from: stage,
            model: ctx.model,
            reply_preview: result.reply.slice(0, 120),
          })}`,
        );
        newStage = stage;
      }
    }

    let reply = result.reply;
    // Flags de telemetria do turn (vao para meta da mensagem + agent_runs).
    let duplicateReplyBlocked = false;
    let falseBookingClaimBlocked = false;
    let falseRescheduleClaimBlocked = false;
    let stallReplyBlocked = false;
    let pointingConfirmAsked = false;

    // GESTO DE APONTAR ("☝🏼", "👆👆"): o lead está indicando algo, mas o gesto
    // não diz O QUÊ — pode ser a oferta do agente OU o pedido dele mesmo. Em vez
    // de adivinhar (agendar no dia errado é o erro mais caro aqui) ou de cair na
    // resposta genérica, devolvemos uma pergunta FECHADA nomeando o(s) horário(s)
    // que o agente acabou de falar. Se ele apontava para a oferta, um "sim"
    // fecha; se apontava para o próprio pedido, ele corrige AQUI.
    //
    // Caso real (Odonto Carioca Campo Grande, 21 97558-2703, 03/08): lead pediu
    // "amanhã às 09:15", ouviu que não tinha e respondeu "👆👆" querendo dizer
    // "eu pedi AMANHÃ" — a IA travou quinta 06/08 e seguiu para o nome.
    if (
      hasBookingIntegration &&
      !finalLeadData.appointment_id &&
      !(finalLeadData.selected_slot_iso ?? "").trim() &&
      isPointingGesture(lastUserMsg)
    ) {
      const apontados = slotsOfferedInLastTurn(finalLeadData, history);
      const confirma = pointingConfirmationReply(apontados);
      if (confirma) {
        pointingConfirmAsked = true;
        console.warn(
          `[orch:telemetry] ${JSON.stringify({
            event: "pointing_gesture_confirm_asked",
            conv: conversationId,
            account: accountId,
            agent: agentId,
            opcoes: apontados.map((s) => `${s.date_label} ${s.time_label}`),
          })}`,
        );
        reply = confirma;
        newStage = "SLOT_OFFER";
      }
    }
    let forcedSchedulingAdvance = userAcceptedSchedulingProposal;

    // Lista de palavras que indicam "confirmei um agendamento". "reservado"/
    // "marcado" entraram depois de um caso real (Clínica Bomfim, 09/07): o
    // agente disse "Reservado para quarta-feira, 15/07" e nenhuma palavra da
    // lista antiga (agendei/agendado/marquei/confirmado) batia — a confirmação
    // falsa passou direto por este guard. Ancoradas com "pra/para" pra não
    // pegar usos genéricos de "reservado"/"marcado" fora de contexto de agenda.
    // Existe algum horário EM JOGO nesta conversa? Sem isso não há agendamento
    // que o agente possa estar confirmando falsamente — e as formas soltas
    // ("agendado", "confirmado") quase sempre falam de OUTRA coisa: o retorno
    // que o dentista marcou, uma consulta antiga, um plano de tratamento.
    // Caso real (Odonto Sorrisos, 87 99625-9078, 03/08): o lead disse "o doutor
    // disse que com 3 meses eu ia voltar pra fazer os implantes" e a resposta do
    // agente — 2ª mensagem da conversa, antes de qualquer horário existir —
    // virou "tive um problema ao registrar sua visita na agenda".
    const horarioEmJogo =
      !!(finalLeadData.selected_slot_iso ?? "").trim() ||
      (finalLeadData.offered_slots?.length ?? 0) > 0;
    if (
      hasBookingIntegration &&
      !finalLeadData.appointment_id &&
      !appointmentJustCancelled &&
      claimsBookingWithoutAppointment({ reply, horarioEmJogo })
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
        reply = `Perfeito! Anotei esse horário para você.\n\n${bookingFieldQuestion(nextField, finalLeadData)}`;
        newStage = "NAME_COLLECT";
      } else if (finalLeadData.selected_slot_iso) {
        reply =
          "Perfeito! Anotei esse horário. Estou finalizando o registro na agenda e já te confirmo.";
        newStage = "BOOKING";
      } else {
        // NÃO inventar falha técnica: nada foi tentado. O texto antigo dizia
        // "tive um problema ao registrar sua visita" e pedia para confirmar um
        // horário que o lead nunca deu — 179 vezes em produção, 46 delas em
        // RECEPTION/QUALIFICATION, onde não havia sequer horário ofertado.
        // Aqui a resposta é honesta (nada foi reservado) e avança de verdade.
        reply = noBookingYetReply(finalLeadData.offered_slots ?? []);
        if (newStage === "CONFIRMED" || stage === "NAME_COLLECT" || stage === "BOOKING") {
          newStage = finalLeadData.selected_slot_iso ? "BOOKING" : "SLOT_OFFER";
        } else if (route === "qualifier" && hasBookingIntegration) {
          // O qualifier NÃO tem tool de agenda — qualquer "vou verificar/
          // organizar/liberar horário" dele é sempre uma promessa vazia (só o
          // scheduler chama listar_horarios de verdade). Sem este branch, o
          // guard só trocava o TEXTO da resposta e o lead ficava PRESO no
          // qualifier repetindo a mesma desculpa pra sempre — caso real (MF
          // Beauty BSB, lead Vera Lúcia): a mesma "tive um problema ao
          // registrar" se repetiu por 3 dias porque newStage nunca saía de
          // RECEPTION/QUALIFICATION. Força o handoff pro scheduler agora.
          newStage = "SLOT_OFFER";
        }
      }
    }

    // Guard anti-"agenda fechada inventada": o agente afirma que a clínica não
    // abre no dia pedido, ou que não há vaga nele, sem ter como saber.
    //
    // Caso real (Odonto Carioca Campo Grande, 21 99826-0816, 11/08): "a agenda
    // de amanhã já está fechada para novos agendamentos" — mensagem com
    // tools=[], sobre um dia útil, e com 2 vagas reais na agenda naquele dia.
    // O modelo recebeu uma lista de horários sem o dia 12 e racionalizou.
    //
    // Só o EXPEDIENTE sustenta "a clínica não abre nesse dia" — agenda vazia num
    // dia útil pode ser agenda cheia, feriado, ou busca ancorada no dia errado.
    // "Não tenho vaga" segue livre, salvo quando contradiz a própria agenda.
    let closedAgendaClaimBlocked = false;
    if (!falseBookingClaimBlocked && hasBookingIntegration) {
      const semProva = unfoundedClosedAgendaClaim({
        reply,
        lastUserMsg,
        offeredSlots: finalLeadData.offered_slots ?? [],
        diasAtivos: activeWeekdayKeys(agentSettings.business_hours_json),
      });
      if (semProva) {
        closedAgendaClaimBlocked = true;
        console.warn(
          `[orch:telemetry] ${JSON.stringify({
            event: "closed_agenda_claim_blocked",
            conv: conversationId,
            account: accountId,
            agent: agentId,
            motivo: semProva.motivo,
            dia: semProva.diaIso,
          })}`,
        );
        reply = closedAgendaSafeReply(semProva.diaIso, finalLeadData.offered_slots ?? []);
        // Volta pro SLOT_OFFER: o próximo turn precisa BUSCAR o dia pedido, não
        // seguir para nome/cadastro em cima de uma negativa que não existia.
        if (!finalLeadData.appointment_id && newStage !== "ESCALATED") {
          newStage = "SLOT_OFFER";
        }
      }
    }

    // Guard anti-"remarcação falsa": JÁ existe appointment_id e o agente afirma
    // que MUDOU/atualizou/remarcou o horário, mas NENHUMA tool de remarcação/
    // cancelamento/criação rodou neste turn → a alteração NÃO aconteceu na
    // agenda (o evento continua na data antiga). Mudar data/hora só funciona via
    // remarcar_agendamento (a tool criar é bloqueada por idempotência quando já
    // há appointment_id). Sem este guard, o agente "confirma" a mudança e o lead
    // aparece num horário que não existe na agenda. Bloqueia a confirmação falsa
    // e pede a reconfirmação, que aciona o remarcar_agendamento no próximo turn.
    const rescheduleToolCalled = (result.tools_called ?? []).some((t) =>
      [
        "remarcar_agendamento",
        "reagendar",
        "reagendar_agendamento",
        "cancelar_agendamento",
        "cancelar_google_calendar",
        "cancelar_clinicorp",
        "criar_agendamento",
        "agendar_google_calendar",
        "agendar_clinicorp",
        "agendar_clinup",
      ].includes(t),
    );
    // "reservei/reservado" entraram depois do mesmo caso real (Clínica Bomfim,
    // 09/07) — a confirmação falsa de uma NOVA data ("Reservado para 15/07")
    // também não batia em nenhuma palavra desta lista. Fica seguro incluir
    // termos mais genéricos aqui porque já exige co-ocorrência com uma palavra
    // de agenda no segundo regex.
    const claimsReschedule =
      /\b(atualizei|atualizado|remarquei|remarcad[oa]|reagendei|reagendad[oa]|mudei|alterei|ajustei|troquei|transferi|reservei|reservad[oa])\b/i.test(
        reply,
      ) && /\b(agenda|agendamento|hor[áa]rio|visita|consulta|reuni[ãa]o)\b/i.test(reply);
    if (
      !falseBookingClaimBlocked &&
      hasBookingIntegration &&
      !!finalLeadData.appointment_id &&
      !appointmentJustCancelled &&
      !rescheduleToolCalled &&
      claimsReschedule
    ) {
      falseRescheduleClaimBlocked = true;
      console.warn(
        `[orch] reply afirma remarcação sem tool conv=${conversationId} — bloqueando alteração falsa`,
      );
      reply =
        "Pra eu garantir a mudança na agenda certinho, me confirma só a nova data e horário que você prefere? Assim já remarco a sua visita. 😊";
      // Mantém o agendamento atual (stage CONFIRMED); o próximo turn, com a
      // reconfirmação do lead, dispara o remarcar_agendamento.
    }

    // Guard anti-"reafirmação cega no CONFIRMED": o lead JÁ tem agendamento
    // confirmado mas sinaliza que NÃO vai conseguir vir / quer cancelar /
    // remarcar / está repensando — e o agente, em vez de tratar a objeção, só
    // repete "sua visita já está confirmada", ignorando a pessoa. Caso real
    // (Maple Bear Osasco, Natalie 11 99881-5258, 21/07): "a logística não vai
    // ficar legal pq eu trabalho na Lapa" → resposta foi só "Sua visita já está
    // confirmada para terça, 21/07 às 11:00". Substitui pela oferta de remarcar/
    // ajudar. Mantém CONFIRMED (não perde o agendamento) — o próximo turn trata
    // o remarcar/cancelar conforme a escolha do lead.
    let confirmedObjectionBlocked = false;
    const replyReaffirmsAppointment =
      /\b(confirmad[ao]|est[áa]\s+confirmad|j[áa]\s+est[áa]\s+(agendad|confirmad)|continua\s+(agendad|confirmad)|aguardando\s+voc[êe]|te\s+esperando)\b/i.test(
        reply,
      );
    const replyAlreadyHelps =
      /\b(remarc|reagend|outro\s+(dia|hor[áa]rio)|outra\s+data|mudar|cancel|prefere|posso\s+(ajudar|ver|remarc)|sem\s+problema|entendo|imagina|sem\s+pressa)\b/i.test(
        reply,
      );
    if (
      hasBookingIntegration &&
      !!finalLeadData.appointment_id &&
      !appointmentJustCancelled &&
      !falseRescheduleClaimBlocked &&
      signalsCannotAttendOrChange(lastUserMsg) &&
      replyReaffirmsAppointment &&
      !replyAlreadyHelps
    ) {
      confirmedObjectionBlocked = true;
      console.warn(
        `[orch:telemetry] ${JSON.stringify({
          event: "confirmed_objection_blocked",
          conv: conversationId,
          account: accountId,
          agent: agentId,
          route,
          stage_from: stage,
          model: ctx.model,
          user_preview: lastUserMsg.slice(0, 120),
          reply_preview: reply.slice(0, 120),
        })}`,
      );
      const firstName = (finalLeadData.name ?? "").trim().split(/\s+/)[0] ?? "";
      reply =
        `${firstName ? `Ah, entendo, ${firstName}! ` : "Ah, entendo! "}` +
        "Se esse horário ficou difícil pra você, sem problema nenhum — consigo remarcar sua visita pra um dia ou horário melhor. Quer que eu veja outras opções, ou prefere seguir com o horário atual? 😊";
      // Mantém CONFIRMED: não cancela nada. O próximo turn, com a resposta do
      // lead, dispara remarcar/listar_horarios ou mantém a visita.
    }

    // Guard anti-"stall": o agente PROMETE agir ("vou finalizar seu cadastro",
    // "só um instante", "vou criar seu cadastro", "já te confirmo") mas NÃO criou
    // agendamento e não perguntou nada — a conversa morre esperando uma ação que
    // nunca vem (bug real no SLOT_OFFER→BOOKING: lead escolhe o horário e o agente
    // fica enrolando). Diferente da confirmação FALSA (tratada acima), aqui o
    // agente nem afirma ter agendado. Substitui o filler pelo próximo passo
    // concreto: pedir o campo que falta, a confirmação de compromisso, ou o slot.
    //
    // Inclui SLOT_OFFER (caso real 09/07, Costa Lima Recreio): lead pediu outra
    // semana, o agente respondeu "vou verificar a agenda" sem chamar
    // listar_horarios — e sem este estágio no gate, o guard nem chegava a rodar
    // (o comentário acima já dizia "SLOT_OFFER→BOOKING" mas o código só cobria
    // NAME_COLLECT/BOOKING).
    const inBookingStage =
      stage === "SLOT_OFFER" ||
      stage === "NAME_COLLECT" ||
      stage === "BOOKING" ||
      effectiveStage === "SLOT_OFFER" ||
      effectiveStage === "NAME_COLLECT" ||
      effectiveStage === "BOOKING" ||
      // Qualifier travado em RECEPTION/QUALIFICATION "enrolando" (vou
      // verificar/encaminhar a agenda, só um minutinho) NUNCA vai cumprir a
      // promessa — ele não tem NENHUMA tool de agenda, só o scheduler tem.
      // Sem isto, o gate original (só estágios do scheduler) deixava o
      // qualifier repetir a mesma desculpa indefinidamente. Caso real (MF
      // Beauty BSB, 11/07): lead confirmou "quarta-feira às 14h" duas vezes
      // e o qualifier respondeu "Vou encaminhar você agora mesmo... Só um
      // minutinho!" sem nunca sair de RECEPTION.
      (route === "qualifier" && hasBookingIntegration) ||
      // MODO UNIFICADO: aqui route é sempre "scheduler", inclusive em
      // RECEPTION/QUALIFICATION — estágios que NÃO estavam no gate. Sem esta
      // cláusula o guard nunca rodava nesses estágios e a enrolação passava
      // direto. Medido no diagnóstico de fluxo (28/07): em QUALIFICATION o
      // agente unificado respondeu "Deixa eu verificar os horários disponíveis"
      // sem chamar a tool em 2 de 3 provedores.
      unifiedMode;
    if (
      !falseBookingClaimBlocked &&
      hasBookingIntegration &&
      !finalLeadData.appointment_id &&
      !appointmentJustCancelled &&
      inBookingStage &&
      looksLikeStallReply(reply)
    ) {
      stallReplyBlocked = true;
      console.warn(
        `[orch:telemetry] ${JSON.stringify({
          event: "stall_reply_blocked",
          conv: conversationId,
          account: accountId,
          agent: agentId,
          route,
          stage_from: stage,
          stage_effective: effectiveStage,
          model: ctx.model,
          reply_preview: reply.slice(0, 120),
        })}`,
      );
      const missingFields = getMissingBookingFields(
        getBookingFieldsForChannel(agentSettings, channelCtx),
        finalLeadData,
      );
      if (finalLeadData.selected_slot_iso && missingFields.length > 0) {
        const nextField = missingFields[0]!;
        reply = `Perfeito, já anotei o horário aqui! 😊\n\n${bookingFieldQuestion(nextField, finalLeadData)}`;
        newStage = "NAME_COLLECT";
      } else if (
        finalLeadData.selected_slot_iso &&
        isCommitmentRequired(agentSettings) &&
        !finalLeadData.commitment_confirmed
      ) {
        reply =
          defaultCommitmentQuestion(agentSettings) ||
          "Posso confirmar esse horário pra você?";
        newStage = "NAME_COLLECT";
      } else if (finalLeadData.selected_slot_iso) {
        // Tudo coletado: o agendamento determinístico deveria ter criado o evento.
        // Se chegou aqui sem appointment_id, a criação na agenda falhou — não
        // enrola: pede a confirmação que dispara nova tentativa no próximo turn.
        reply =
          "Quase lá! Só me confirma que posso garantir esse horário pra você que eu finalizo o agendamento. 😊";
        newStage = "BOOKING";
      } else {
        // SLOT_OFFER sem slot escolhido: em vez de só perguntar "qual horário?"
        // (o lead fica sem ver opção), APRESENTA os horários que já temos. O
        // lead pediu justamente pra ver os horários — não enrola nem devolve
        // vazio. Caso real (Costa Lima Recreio, Luciano): o agente respondeu
        // "vou buscar as opções da tarde... só um instantinho" e não trouxe nada.
        //
        // A resposta considera o DIA que o lead pediu: repetir a mesma oferta
        // ignorando o pedido era o que virava loop. Caso real (Odonto Carioca
        // Campo Grande, 21 97558-2703): lead pediu SÁBADO, o guard respondeu
        // "quinta 13:30 ou 13:45" três vezes idênticas — e nunca disse que a
        // clínica não abre sábado (o guard corta antes de chamar a agenda).
        const fallback = buildSlotOfferFallback({
          lastUserMsg,
          offeredSlots: finalLeadData.offered_slots ?? [],
          diasAtivos: activeWeekdayKeys(agentSettings.business_hours_json),
        });
        reply = fallback.reply;
        // "sem_slots" cai numa pergunta genérica de horário. Se ainda faltam
        // dados obrigatórios, pedir o dado é o próximo passo REAL: perguntar
        // "qual horário fica melhor?" sem ter horário nenhum em mãos é mandar o
        // lead adivinhar a agenda E ainda deixa o cadastro incompleto. Caso real
        // (MF Beauty Magé, Instagram, 28/07): faltavam nome completo E WhatsApp.
        if (fallback.motivo === "sem_slots" && missingFields.length > 0) {
          reply = bookingFieldQuestion(missingFields[0]!, finalLeadData);
        }
        if (fallback.motivo === "dia_fechado" || fallback.motivo === "dia_pedido_disponivel") {
          console.warn(
            `[orch:telemetry] ${JSON.stringify({
              event: "stall_fallback_dia_pedido",
              conv: conversationId,
              account: accountId,
              agent: agentId,
              motivo: fallback.motivo,
              dia_pedido: fallback.diaPedido,
            })}`,
          );
        }
        newStage = "SLOT_OFFER";
      }
    }

    // Se o LEAD TAMBÉM repetiu a própria mensagem anterior (ex.: dois cliques
    // no mesmo anúncio do Instagram geram a mesma saudação duas vezes), uma
    // resposta repetida do agente é uma reação LEGÍTIMA ao input duplicado —
    // não é o LLM alucinando. Caso real (Maple Bear Osasco, 10/07): o lead
    // mandou "Olá! Tenho interesse..." duas vezes (dois cliques no anúncio);
    // a 1ª vez o agente pediu o nome corretamente, e como a 2ª pergunta era
    // idêntica, o agente ia responder a MESMA coisa de novo (correto) — mas o
    // guard achou que era um loop e forçou "vou te mostrar os horários",
    // pulando reto pra SLOT_OFFER sem o lead sequer ter dado o nome.
    const priorUserMsgs = history.filter((m) => m.role === "user");
    const previousUserMsg = priorUserMsgs[priorUserMsgs.length - 2]?.content ?? "";
    const userAlsoRepeated =
      !!lastUserMsg && !!previousUserMsg && isReplyTooSimilar(lastUserMsg, previousUserMsg);

    // …MAS a isenção acima vale UMA vez. Se as DUAS últimas respostas do agente
    // já foram esse mesmo texto, mandar uma terceira nunca é reação legítima —
    // é loop. Caso real (Odonto Carioca Campo Grande, 21 97558-2703): o lead
    // repetiu "penso em ir no sábado" (porque foi ignorado), o userAlsoRepeated
    // desarmou este guard e a MESMA frase saiu 3x seguidas.
    // Compara com as respostas que o AGENTE gerou, não com a última mensagem
    // `assistant` qualquer — os ecos fragmentados da Helena entram como
    // assistant e mascaravam a repetição (ver agentReplies).
    const assistantMsg1 = agentReplies[agentReplies.length - 1] ?? "";
    const assistantMsg2 = agentReplies[agentReplies.length - 2] ?? "";
    const jaRepetiuDuasVezes =
      !!assistantMsg1 &&
      !!assistantMsg2 &&
      isReplyTooSimilar(reply, assistantMsg1) &&
      isReplyTooSimilar(reply, assistantMsg2);

    // Guarda anti-loop: se o reply é praticamente idêntico à última msg do assistente,
    // o LLM está alucinando ao repetir conteúdo. Substitui por um avanço de proposta.
    // Baseline da comparação: a última resposta REAL do agente. Cai para
    // lastAssistantMsg quando ainda não há nenhuma (primeiro turno).
    const baselineAnterior = assistantMsg1 || lastAssistantMsg;

    // 2ª isenção: a pergunta anterior oferecia opções e o lead respondeu só
    // "sim"/"ok" — não escolheu nada, então a pergunta continua em aberto e
    // repeti-la é a única reação correta, não um loop. Caso real (Escudero,
    // 12 99189-4420, 13/08): "superior, inferior ou nas duas?" → "Sim" → a trava
    // engoliu a repergunta e mandou "Desculpa, acho que me confundi aqui! 😅",
    // zerando a conversa para refazer a MESMA pergunta um turno depois.
    // Como a de cima, vale UMA vez: `jaRepetiuDuasVezes` continua mandando.
    const leadSkippedOptions = leadSkippedOptionsQuestion(lastUserMsg, baselineAnterior);

    if (
      baselineAnterior &&
      (!userAlsoRepeated || jaRepetiuDuasVezes) &&
      (!leadSkippedOptions || jaRepetiuDuasVezes) &&
      isReplyTooSimilar(reply, baselineAnterior)
    ) {
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
          prev_preview: baselineAnterior.slice(0, 120),
        })}`,
      );
      if (finalLeadData.appointment_id) {
        // JÁ AGENDADO: nunca re-oferecer agendamento. O fallback antigo caía no
        // ramo genérico e dizia "quer seguir com o agendamento agora? Posso te
        // mostrar os horários" — sem sentido, a visita já está marcada. Caso
        // real (Maple Bear Osasco, 11 96500-7002): visita confirmada p/ 14/07,
        // a lead mandou "Ok" e o agente perguntou se ela queria agendar de novo.
        reply =
          "Perfeito! Seu agendamento já está confirmado. Qualquer coisa que precisar, é só me chamar. 😊";
        newStage = "CONFIRMED";
      } else if (hasBookingIntegration && (stage === "QUALIFICATION" || stage === "RECEPTION")) {
        // NÃO presume que o lead quer agendar — ele pode querer valores/dúvida.
        // O fallback antigo forçava "vou te mostrar os horários" + SLOT_OFFER,
        // empurrando agendamento em cima de quem só queria informação e ainda
        // criando loop quando o contexto vinha poluído (msgs externas/eco
        // duplicadas). Caso real (Maple Bear Osasco, 11 99241-0075): a lead
        // queria PREÇO de matrícula/mensalidade e o agente repetia "vou te
        // mostrar os horários". Pergunta neutra reabre o que ela precisa.
        //
        // O texto NÃO cita vocabulário de um ramo específico. A versão anterior
        // trazia "(valores, turmas, etc.)" — "turmas" veio do caso Maple Bear
        // (escola) e vazou para TODO agente: 170 mensagens em 16 contas, das
        // quais só 2 são escolas. Clínicas de odontologia, estética e até uma
        // casa de festas perguntaram ao lead sobre "turmas". Caso real que
        // levantou isso: Odonto Sorrisos, 87 99116-9430, 04/08.
        //
        // Também não injeta appointment_type_label: os valores reais são
        // inconsistentes ("Call agendada", "AVALIAÇÃO AGENDADA ", "VISITA
        // GUIADA") e quebrariam a concordância. "agendar um horário" serve a
        // todos os ramos.
        reply =
          "Desculpa, acho que me confundi aqui! 😅 Me diz como posso te ajudar: você quer agendar um horário ou tirar alguma dúvida antes?";
        newStage = "QUALIFICATION";
      } else if (effectiveStage === "NAME_COLLECT" || stage === "NAME_COLLECT") {
        // A trava não pode TROCAR DE ASSUNTO. Se a repetição é sobre o NOME,
        // perguntar "quer seguir com o agendamento?" faz o lead achar que
        // voltou à estaca zero — ele já escolheu o horário.
        //
        // Caso real (Odonto Carioca Campo Grande, 21 96543-1529): a lead mandou
        // o nome completo 4x, a trava respondeu 4x "quer seguir com o
        // agendamento agora?", e ela respondeu "Eu já escolhi para as 16:15" e
        // depois "Desisto". A repetição era sintoma de outro bug (o nome dela
        // era descartado na captura), mas este texto transformou um travamento
        // em perda do lead.
        const primeiro = (finalLeadData.name ?? "").trim().split(/\s+/)[0] ?? "";
        reply =
          primeiro && !looksLikeSentenceNotName(finalLeadData.name ?? "")
            ? `Desculpa insistir! Só me confirma o sobrenome do ${primeiro}, por favor, que eu finalizo o agendamento.`
            : "Desculpa insistir! Pra fechar o agendamento eu preciso do nome completo do paciente (nome e sobrenome). Pode me mandar?";
      } else if (hasBookingIntegration) {
        reply =
          "Me confirma só por favor: você quer seguir com o agendamento agora? Posso te mostrar os horários disponíveis.";
      } else {
        // Agente sem integração de agendamento (turismo, vendas, etc.) — texto
        // neutro que não menciona "agendamento" nem "horários".
        reply = "Pode me contar um pouco mais sobre o que você está procurando?";
      }
    }

    // Guard anti-"escalação fantasma": a resposta PROMETE transferir pro humano
    // ("vou chamar uma pessoa da nossa equipe", "vou te transferir"...) mas o
    // stage não virou ESCALATED — nem a tag "IA Desligada" nem o alerta do
    // grupo disparam, e o bot continua "vivo" contradizendo a própria
    // promessa. Caso real (Maple Bear Osasco, 09/07): a lead reclamou de não
    // conseguir condições pelo WhatsApp e ameaçou não visitar; o agente
    // respondeu "vou chamar uma pessoa da nossa equipe" mas propôs continuar
    // em SLOT_OFFER. Só não ficou em silêncio total porque um humano notou a
    // conversa por fora e pausou a IA manualmente — se ninguém tivesse visto,
    // o lead ficaria esperando um handoff que nunca aconteceria. Usa o reply
    // ORIGINAL do LLM (antes dos guards acima) porque é o texto que carrega o
    // sinal — os guards de booking/stall podem tê-lo substituído por algo sem
    // esse sinal, mas a decisão de escalar continua válida.
    const claimsHumanHandoff =
      /\b(vou (chamar|acionar|pedir para) (uma pessoa|algu[ée]m|um[a]? (atendente|colega|especialista))|vou te (transferir|passar|encaminhar) (para|pra) (um[a]? )?(atendente|pessoa|equipe|time|especialista)|algu[ée]m (da (nossa )?equipe|do (nosso )?time) (vai|ir[áa]) (te )?(atender|continuar|assumir|falar)|uma pessoa (da (nossa )?equipe|do (nosso )?time) (vai|ir[áa])|transferindo (seu|o) atendimento|encaminhando (seu|o) atendimento|vou (te )?transferir (seu|o|este) atendimento)\b/i.test(
        result.reply,
      );
    let ghostEscalationForced = false;
    if (claimsHumanHandoff && newStage !== "ESCALATED") {
      ghostEscalationForced = true;
      console.warn(
        `[orch:telemetry] ${JSON.stringify({
          event: "ghost_escalation_forced",
          conv: conversationId,
          account: accountId,
          agent: agentId,
          route,
          stage_from: stage,
          stage_proposed: newStage,
          model: route === "qualifier" ? ctx.qualifierModel : ctx.model,
          reply_preview: result.reply.slice(0, 160),
        })}`,
      );
      finalLeadData = {
        ...finalLeadData,
        escalation_reason:
          finalLeadData.escalation_reason?.trim() ||
          "O agente prometeu transferir para atendimento humano na própria resposta, mas não escalou — forçado automaticamente.",
      };
      newStage = "ESCALATED";
    }

    // Leads360: decide o que sincronizar neste turn. O envio HTTP é best-effort
    // e roda DEPOIS do persist; aqui só marcamos o flag de dedup do lead para
    // ser persistido (evita reenviar /leads a cada turn).
    const leads360 = resolveLeads360Config(agentSettings);
    const leads360SendLead = leads360.enabled && !leads360Synced;
    const leads360InterestNow =
      leads360.enabled &&
      !!finalLeadData.interest?.trim() &&
      finalLeadData.interest.trim() !== interestBefore;
    if (leads360SendLead) finalLeadData.leads360_lead_sent = true;

    const cfKeys = Object.keys(finalLeadData.custom_fields ?? {}).join(",");
    console.log(
      `[orch] persist conv=${conversationId} stage=${newStage} custom_fields=${cfKeys || "(vazio)"}`,
    );

    // 12. Persiste e entrega
    await persistStageAndLeadData(conversationId, meta, newStage, finalLeadData, route);

    // Falha de entrega (Helena fora do ar nas duas tentativas) NÃO pode abortar
    // os passos seguintes: o stage/lead_data (inclusive um appointment_id
    // recém-criado) JÁ foi persistido na linha acima. Sem este try/catch, uma
    // exceção aqui pulava escalação/notifyBooking/Leads360 — e como
    // `justBooked` compara com o estado JÁ persistido, um reprocessamento
    // posterior da conversa nunca mais veria a transição sem→com appointment_id
    // e a notificação pra equipe (WhatsApp/Leads360) ficava perdida PARA SEMPRE,
    // mesmo que o lead recebesse a resposta depois num retry.
    try {
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
          pointing_gesture_confirm_asked: pointingConfirmAsked || undefined,
          false_booking_claim_blocked: falseBookingClaimBlocked || undefined,
          closed_agenda_claim_blocked: closedAgendaClaimBlocked || undefined,
          // Quando um guard TROCA o texto, a resposta original do LLM some — foi
          // o que impediu de saber qual palavra disparou o false_booking_claim
          // no caso Odonto Sorrisos (87 99625-9078). Guardamos o original para
          // conseguir auditar o gatilho depois.
          reply_llm_original:
            reply !== result.reply ? result.reply.slice(0, 400) : undefined,
          false_reschedule_claim_blocked: falseRescheduleClaimBlocked || undefined,
          confirmed_objection_blocked: confirmedObjectionBlocked || undefined,
          stall_reply_blocked: stallReplyBlocked || undefined,
          // Repasse qualifier → scheduler dentro do MESMO turn (Fase 1). Valor
          // = motivo ("next_stage" ou "stall"). Serve pra medir quantas vezes a
          // heurística de roteamento teria custado um turno ao lead.
          same_turn_handoff: sameTurnHandoff
            ? ((result.telemetry?.same_turn_handoff as string) ?? true)
            : undefined,
          ghost_escalation_forced: ghostEscalationForced || undefined,
          forced_scheduling_advance: forcedSchedulingAdvance || undefined,
          preflight_blocked: (result.telemetry?.preflight_blocked as boolean) || undefined,
          preflight_dirty_fields: (result.telemetry?.dirty_fields as string[]) || undefined,
          double_booking_blocked:
            (result.telemetry?.double_booking_blocked as boolean) || undefined,
          // Diagnóstico de falha de agendamento. Estas chaves eram calculadas pelo
          // scheduler e DESCARTADAS aqui (a lista era fixa), então toda escalada por
          // "falha técnica" chegava ao banco sem o motivo real — cegueira que custou
          // os diagnósticos de 07/07 e 15-16/07. Repassar cru o que o scheduler mediu.
          booking_error: (result.telemetry?.booking_error as string) || undefined,
          booking_error_kind: (result.telemetry?.booking_error_kind as string) || undefined,
          booking_failure_kind: (result.telemetry?.booking_failure_kind as string) || undefined,
          booking_failed_slot: (result.telemetry?.booking_failed_slot as string) || undefined,
          booking_guard_hold: (result.telemetry?.booking_guard_hold as string) || undefined,
          false_confirmation_blocked:
            (result.telemetry?.false_confirmation_blocked as boolean) || undefined,
          booking_escalated_technical:
            (result.telemetry?.booking_escalated_technical as boolean) || undefined,
          booking_validation_only_blocked:
            (result.telemetry?.booking_validation_only_blocked as boolean) || undefined,
          // Sem estas duas o scrub de confirmação falsa disparava INVISÍVEL no
          // meta: a conversa era reescrita (re-oferta) e o selected_slot_iso
          // apagado sem deixar rastro, e o diagnóstico levava a conclusão errada
          // ("a trava não rodou"). Caso real (Costa Lima Recreio, 21 98542-7519).
          false_confirmation_scrubbed:
            (result.telemetry?.false_confirmation_scrubbed as boolean) || undefined,
          chosen_slot_preserved:
            (result.telemetry?.chosen_slot_preserved as boolean) || undefined,
        },
        sessionId,
        effectivePhone ?? conversationPhone,
      );
    } catch (e) {
      console.error(
        `[orch] deliverReply falhou conv=${conversationId} — lead pode não ter recebido a resposta, mas escalação/notificações/Leads360 seguem normalmente:`,
        e,
      );
    }

    // 13. Se transitou para ESCALATED, dispara escalação humana
    if (newStage === "ESCALATED" && stage !== "ESCALATED") {
      console.log(`[orch] disparando escalateToHuman — motivo: ${finalLeadData.escalation_reason}`);
      try {
        await escalateToHuman({
          accountId,
          agentId,
          phone: recordPhone(finalLeadData),
          sessionId,
          helenaContactId: helenaContact?.id,
          helenaContactName: helenaContact?.name,
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
        // Rótulo da notificação: a agenda escolhida pode definir o seu próprio
        // (ex: agenda "Festas" → "FESTA AGENDADA" em vez de "VISITA AGENDADA").
        let appointmentLabel = agentSettings.appointment_type_label || "Consulta";
        const selectedAgenda = (finalLeadData.selected_agenda ?? "").trim();
        if (selectedAgenda) {
          try {
            const agendas = await listAccountAgendas(accountId);
            const match = agendas.find(
              (a) => a.label.toLowerCase() === selectedAgenda.toLowerCase(),
            );
            if (match?.rotuloNotificacao) appointmentLabel = match.rotuloNotificacao;
          } catch (e) {
            console.warn("[orch] rótulo de notificação da agenda indisponível:", e);
          }
        }
        // Custom fields como Record<string, string> p/ uso em {{cf.<chave>}}.
        const cfRaw = (finalLeadData.custom_fields ?? {}) as Record<string, unknown>;
        const customFields: Record<string, string> = {};
        for (const [k, v] of Object.entries(cfRaw)) {
          if (typeof v === "string") customFields[k] = v;
          else if (typeof v === "number" || typeof v === "boolean") customFields[k] = String(v);
        }
        // O resumo agora é gerado DENTRO de notifyBooking quando habilitado e o
        // template realmente usa {{resumo}} — economiza tokens em quem desliga.
        await notifyBooking({
          agentId,
          accountId,
          event,
          patientName:
            resolveBookingLeadName(finalLeadData) ||
            (finalLeadData.name as string | undefined) ||
            "(sem nome)",
          phone: recordPhone(finalLeadData),
          datetimeIso: justBooked
            ? (finalLeadData.selected_slot_iso as string | undefined) ?? ""
            : slotIsoBefore,
          appointmentLabel,
          agenda: selectedAgenda,
          // {{unidade}}: mesma origem de {{agenda}} (selected_agenda), nome que
          // faz sentido numa central com várias unidades/localidades.
          unidade: selectedAgenda,
          interesse: (finalLeadData.interest as string | undefined) ?? "",
          observacoes: (finalLeadData.notes as string | undefined) ?? "",
          agenteNome: (agent.data.nome as string | undefined) ?? "",
          empresa: agentSettings.company_name ?? "",
          customFields,
          history,
          orKey: ctx.orKey,
          summaryModel: ctx.ragGateModel,
        });
      } catch (e) {
        console.error("[orch] notifyBooking falhou:", e);
      }
    }

    // 15. Leads360 (gestão de leads) — envios best-effort por webhook. Cada
    //     função engole falhas internamente, então não quebram o turn.
    if (leads360.enabled) {
      const leads360Name =
        resolveBookingLeadName(finalLeadData) ||
        (finalLeadData.name as string | undefined) ||
        helenaContact?.name ||
        "(sem nome)";
      const leads360Phone = recordPhone(finalLeadData);
      if (leads360SendLead) {
        await sendLeads360Lead(leads360, {
          name: helenaContact?.name || leads360Name,
          phone: leads360Phone,
          utm: helenaContact?.utm ?? null,
        });
      }
      if (leads360InterestNow) {
        await sendLeads360Interest(leads360, {
          name: leads360Name,
          phone: leads360Phone,
          interest: finalLeadData.interest!.trim(),
        });
      }
      if (justBooked) {
        await sendLeads360Scheduled(leads360, {
          name: leads360Name,
          phone: leads360Phone,
          datetimeIso: (finalLeadData.selected_slot_iso as string | undefined) ?? null,
        });
      }
      if (newStage === "ESCALATED" && stage !== "ESCALATED") {
        await sendLeads360Transfer(leads360, {
          name: leads360Name,
          phone: leads360Phone,
        });
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
