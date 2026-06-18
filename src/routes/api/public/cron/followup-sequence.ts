// POST /api/public/cron/followup-sequence
//
// Processa a NOVA sequência de follow-up (tabela followup_steps).
// Chamado pelo pg_cron a cada ~5 min.
//
// Lógica:
// 1. Para cada agente com followup_steps habilitados (enabled=true):
//    a. Busca conversas elegíveis: agente ativo, última msg NÃO é do lead,
//       lead NÃO está agendado/escalado (conversations.meta), última msg foi
//       há tempo suficiente.
//    b. Para cada conversa, identifica qual é o PRÓXIMO step a enviar
//       (consultando followup_step_runs).
//    c. Verifica se o tempo do step bateu (delay desde a última interação
//       relevante = msg do lead OU envio do step anterior).
//    d. Verifica janela horária + dias permitidos.
//    e. Se for hora: gera mensagem (texto fixo OU contextual via LLM) e envia.
//    f. Registra em followup_step_runs.

import { createFileRoute } from "@tanstack/react-router";
import { getSelfhost } from "@/integrations/selfhost/client.server";
import { loadHelenaAccount, sendHelenaText } from "@/lib/helena.server";
import { generateContextualFollowup } from "@/lib/agents/followup-context.server";
import {
  clearStaleConversationLock,
  releaseConversationLock,
  tryAcquireConversationLock,
} from "@/lib/conversation-lock.server";

function validateCronSecret(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  return request.headers.get("x-cron-secret") === secret;
}

function delayToMs(value: number, unit: string): number {
  switch (unit) {
    case "minutes":
      return value * 60 * 1000;
    case "hours":
      return value * 60 * 60 * 1000;
    case "days":
      return value * 24 * 60 * 60 * 1000;
    default:
      return value * 60 * 1000;
  }
}

const DAY_KEYS = ["dom", "seg", "ter", "qua", "qui", "sex", "sab"];
function isAllowedNow(
  windowStart: number | null,
  windowEnd: number | null,
  allowedDays: string[] | null,
  now: Date,
): boolean {
  // Tudo em horário de São Paulo
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Sao_Paulo",
    hour: "numeric",
    weekday: "short",
    hour12: false,
  }).formatToParts(now);
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
  const weekdayMap: Record<string, string> = {
    Sun: "dom",
    Mon: "seg",
    Tue: "ter",
    Wed: "qua",
    Thu: "qui",
    Fri: "sex",
    Sat: "sab",
  };
  const weekdayShort = parts.find((p) => p.type === "weekday")?.value ?? "";
  const weekdayKey = weekdayMap[weekdayShort] ?? "";

  if (windowStart !== null && windowEnd !== null) {
    if (hour < windowStart || hour >= windowEnd) return false;
  }
  if (Array.isArray(allowedDays) && allowedDays.length > 0) {
    if (!allowedDays.includes(weekdayKey)) return false;
  }
  return true;
}

interface ConversationMeta {
  stage?: string;
  lead_data?: { appointment_id?: number | string; booked_tag_applied?: boolean } | null;
  [k: string]: unknown;
}

/**
 * Lead já agendado (ou escalado para humano) NÃO deve receber follow-up.
 * Fonte da verdade local (conversations.meta), equivalente à etiqueta "Agendado":
 *  - lead_data.appointment_id presente → agendamento ativo (limpo ao cancelar);
 *  - stage CONFIRMED → pós-agendamento;
 *  - stage ESCALATED → handoff humano, o bot não deve insistir.
 * Se o lead cancelar, appointment_id é limpo e o stage volta p/ SLOT_OFFER, então
 * o follow-up volta a ser elegível naturalmente.
 */
function shouldSkipFollowup(meta: ConversationMeta | null): boolean {
  if (!meta) return false;
  const ld = meta.lead_data ?? null;
  if (ld && (ld.appointment_id != null || ld.booked_tag_applied === true)) return true;
  if (meta.stage === "CONFIRMED" || meta.stage === "ESCALATED") return true;
  return false;
}

interface FollowupStep {
  id: string;
  agent_id: string;
  ordem: number;
  enabled: boolean;
  delay_value: number;
  delay_unit: string;
  mode: "message" | "contextual";
  message_text: string | null;
  contextual_instruction: string | null;
  window_start_hour: number | null;
  window_end_hour: number | null;
  allowed_days: string[] | null;
}

export const Route = createFileRoute("/api/public/cron/followup-sequence")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        if (!validateCronSecret(request)) {
          return new Response("Unauthorized", { status: 401 });
        }

        const sb = getSelfhost();
        const now = new Date();

        // 1. Carrega TODOS os steps habilitados, agrupados por agente
        const { data: steps, error: stepsErr } = await sb
          .from("followup_steps")
          .select("*")
          .eq("enabled", true)
          .order("agent_id")
          .order("ordem", { ascending: true });
        if (stepsErr) {
          return Response.json({ ok: false, error: stepsErr.message }, { status: 500 });
        }
        if (!steps || steps.length === 0) {
          return Response.json({ ok: true, processed: 0, reason: "no steps" });
        }

        // Detecta steps com config invalida (modo 'message' sem message_text)
        // e auto-desabilita pra evitar log spam a cada minuto.
        const invalidSteps = (steps as FollowupStep[]).filter(
          (s) =>
            s.mode === "message" &&
            (!s.message_text || !s.message_text.trim()),
        );
        if (invalidSteps.length > 0) {
          const ids = invalidSteps.map((s) => s.id);
          await sb.from("followup_steps").update({ enabled: false }).in("id", ids);
          console.warn(
            `[followup-seq] auto-disabled ${ids.length} step(s) com config invalida (mode=message + message_text vazio): ${ids.join(", ")}`,
          );
        }
        const validSteps = (steps as FollowupStep[]).filter(
          (s) => !invalidSteps.includes(s),
        );
        if (validSteps.length === 0) {
          return Response.json({
            ok: true,
            processed: 0,
            reason: "all steps had invalid config and were auto-disabled",
            disabled_steps: invalidSteps.map((s) => s.id),
          });
        }

        // Agrupa por agent_id
        const stepsByAgent = new Map<string, FollowupStep[]>();
        for (const s of validSteps) {
          const arr = stepsByAgent.get(s.agent_id) ?? [];
          arr.push(s);
          stepsByAgent.set(s.agent_id, arr);
        }

        let processed = 0;
        let attempted = 0;

        for (const [agentId, agentSteps] of stepsByAgent) {
          // Verifica se agente está ativo
          const agentRow = await sb
            .from("agents")
            .select("id, account_id, ativo")
            .eq("id", agentId)
            .single();
          if (!agentRow.data?.ativo) continue;
          const accountId = agentRow.data.account_id as string;

          // Busca conversas desse agente cuja ÚLTIMA mensagem foi do lead
          const { data: convs } = await sb
            .from("conversations")
            .select("id, phone, helena_session_id, channel, meta")
            .eq("agent_id", agentId)
            .limit(500);
          if (!convs?.length) continue;

          for (const conv of convs) {
            try {
              const convId = conv.id as string;

              // Lead já agendado/escalado → nunca enviar follow-up.
              if (shouldSkipFollowup(conv.meta as ConversationMeta | null)) continue;

              // Última mensagem da conversa
              const { data: lastMsg } = await sb
                .from("messages")
                .select("role, criado_em, content, meta")
                .eq("conversation_id", convId)
                .order("criado_em", { ascending: false })
                .limit(1)
                .maybeSingle();
              if (!lastMsg) continue;
              // Follow-up dispara quando o LEAD ficou inativo após a IA responder.
              // Se a última msg é do user → lead acabou de responder, reinicia o ciclo
              // (não envia agora; quando IA responder e ele ficar inativo de novo, começa do step 1).
              if (lastMsg.role === "user") continue;

              const lastMsgAt = new Date(lastMsg.criado_em as string);

              // CICLO REINICIÁVEL: pegamos a última msg do LEAD (role=user) na conversa.
              // Step_runs anteriores a essa msg pertencem a um ciclo antigo e não contam.
              // Se o lead NUNCA mandou msg → ciclo único desde o início da conversa.
              const { data: lastUserMsg } = await sb
                .from("messages")
                .select("criado_em")
                .eq("conversation_id", convId)
                .eq("role", "user")
                .order("criado_em", { ascending: false })
                .limit(1)
                .maybeSingle();
              const cycleStartAt = lastUserMsg
                ? new Date(lastUserMsg.criado_em as string)
                : new Date(0);

              // Steps disparados DENTRO do ciclo atual (após a última resposta do lead)
              const { data: alreadySent } = await sb
                .from("followup_step_runs")
                .select("step_id, sent_at, status")
                .eq("conversation_id", convId)
                .eq("status", "sent")
                .gt("sent_at", cycleStartAt.toISOString());
              const sentStepIds = new Set(
                (alreadySent ?? []).map((r) => r.step_id as string),
              );

              // Próximo step pendente no ciclo atual
              const pendingSteps = agentSteps.filter((s) => !sentStepIds.has(s.id));
              if (pendingSteps.length === 0) continue; // sequência inteira já rodou neste ciclo
              const nextStep = pendingSteps[0];

              // Anchor a partir do qual contamos o delay:
              //   - step 1 do ciclo: última msg da IA (lead inativo desde então)
              //   - step N > 1: último envio bem-sucedido do MESMO ciclo
              let anchorAt: Date;
              if (alreadySent && alreadySent.length > 0) {
                const latestSend = alreadySent
                  .map((r) => new Date(r.sent_at as string))
                  .sort((a, b) => b.getTime() - a.getTime())[0];
                anchorAt = latestSend > lastMsgAt ? latestSend : lastMsgAt;
              } else {
                anchorAt = lastMsgAt;
              }

              const delayMs = delayToMs(nextStep.delay_value, nextStep.delay_unit);
              const earliestSendAt = new Date(anchorAt.getTime() + delayMs);
              if (now < earliestSendAt) continue; // ainda não é hora

              // Janela permitida agora?
              if (
                !isAllowedNow(
                  nextStep.window_start_hour,
                  nextStep.window_end_hour,
                  nextStep.allowed_days,
                  now,
                )
              ) {
                continue;
              }

              // Lock por conversa: o cron roda a cada minuto e a geração
              // contextual pode passar de 60s — ticks sobrepostos liam "step
              // pendente" ao mesmo tempo e enviavam o MESMO follow-up várias
              // vezes (ex.: 4 seguidos). O lock atômico serializa os ticks e
              // também impede follow-up durante um turno real do agente.
              await clearStaleConversationLock(convId);
              if (!(await tryAcquireConversationLock(convId))) continue;
              try {
                // Re-checa SOB o lock: outro tick pode ter acabado de enviar
                // este step entre a leitura inicial e a aquisição do lock.
                const { data: justSent } = await sb
                  .from("followup_step_runs")
                  .select("step_id")
                  .eq("conversation_id", convId)
                  .eq("step_id", nextStep.id)
                  .eq("status", "sent")
                  .gt("sent_at", cycleStartAt.toISOString())
                  .limit(1);
                if (justSent && justSent.length > 0) continue;

              attempted++;

              // Resolve o texto: fixo ou contextual
              let messageText = "";
              if (nextStep.mode === "message") {
                messageText = (nextStep.message_text ?? "").trim();
                if (!messageText) {
                  // Step com config invalida — ja foi auto-desabilitado no
                  // inicio do tick; este guard e so um safety net.
                  continue;
                }
              } else {
                try {
                  const ctxResult = await generateContextualFollowup({
                    accountId,
                    agentId,
                    conversationId: convId,
                    stepInstruction:
                      nextStep.contextual_instruction?.trim() ||
                      "Reengaje o lead de forma humana e personalizada.",
                    stepOrdem: nextStep.ordem,
                  });
                  messageText = ctxResult.reply;
                } catch (e) {
                  const msg = e instanceof Error ? e.message : String(e);
                  console.error(`[followup-seq] contextual falhou: ${msg}`);
                  await sb.from("followup_step_runs").insert({
                    step_id: nextStep.id,
                    conversation_id: convId,
                    agent_id: agentId,
                    status: "failed",
                    error: msg.slice(0, 500),
                  });
                  continue;
                }
              }

              // Envia pelo Helena
              try {
                const helena = await loadHelenaAccount(accountId);
                const sendRes = await sendHelenaText(helena, {
                  phone: (conv.phone as string) || undefined,
                  text: messageText,
                  sessionId: (conv.helena_session_id as string | null) ?? undefined,
                });
                if (!sendRes.ok) {
                  await sb.from("followup_step_runs").insert({
                    step_id: nextStep.id,
                    conversation_id: convId,
                    agent_id: agentId,
                    message_sent: messageText,
                    status: "failed",
                    error: `Helena ${sendRes.status}: ${sendRes.body.slice(0, 200)}`,
                  });
                  continue;
                }
              } catch (e) {
                const msg = e instanceof Error ? e.message : String(e);
                await sb.from("followup_step_runs").insert({
                  step_id: nextStep.id,
                  conversation_id: convId,
                  agent_id: agentId,
                  message_sent: messageText,
                  status: "failed",
                  error: msg.slice(0, 500),
                });
                continue;
              }

              // Sucesso: grava em messages + followup_step_runs
              await sb.from("messages").insert({
                conversation_id: convId,
                role: "assistant",
                content: messageText,
                meta: {
                  origem: "followup",
                  followup_step_ordem: nextStep.ordem,
                  followup_mode: nextStep.mode,
                },
              });
              await sb.from("followup_step_runs").insert({
                step_id: nextStep.id,
                conversation_id: convId,
                agent_id: agentId,
                message_sent: messageText,
                status: "sent",
              });

              processed++;
              } finally {
                await releaseConversationLock(convId);
              }
            } catch (e) {
              console.error("[followup-seq] erro na conversa:", e);
            }
          }
        }

        return Response.json({ ok: true, attempted, processed });
      },
    },
  },
});
