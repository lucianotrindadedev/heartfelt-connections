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
import {
  loadHelenaAccount,
  sendHelenaText,
  loadHelenaSession,
  findHelenaTemplateByName,
  sendHelenaTemplate,
} from "@/lib/helena.server";
import { generateContextualFollowup } from "@/lib/agents/followup-context.server";
import { checkContactBlockedBySession } from "@/lib/agent-block.server";
import { followupHeldByConversationGuards } from "@/lib/conversation-guards";
import {
  clearStaleConversationLock,
  releaseConversationLock,
  tryAcquireConversationLock,
} from "@/lib/conversation-lock.server";
import {
  agentNeedsStaleConversations,
  planFollowupStep,
  WHATSAPP_WINDOW_MS,
} from "@/lib/followup-plan";

function validateCronSecret(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  return request.headers.get("x-cron-secret") === secret;
}

interface ConversationMeta {
  stage?: string;
  lead_data?: {
    appointment_id?: number | string;
    booked_tag_applied?: boolean;
    /** "me chama amanhã": segura o follow-up até esta data (ISO 8601). */
    retomar_em?: string;
  } | null;
  [k: string]: unknown;
}

/**
 * Retorno agendado pelo lead: enquanto `retomar_em` (em meta.lead_data) for uma
 * data FUTURA, nenhum follow-up dispara — o lead pediu para ser contatado só lá.
 * Data inválida ou no passado → não segura (fluxo normal).
 */
function isHeldByCallback(meta: ConversationMeta | null, now: Date): boolean {
  const raw = meta?.lead_data?.retomar_em;
  if (!raw) return false;
  const when = new Date(raw);
  if (isNaN(when.getTime())) return false;
  return now < when;
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
  // Conversa que mistura contatos, ou lead que só agradeceu: cobrar horário
  // ali é empurrar agendamento em quem não pediu. Ver conversation-guards.
  if (followupHeldByConversationGuards(meta)) return true;
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
  helena_template_name: string | null;
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

        // Teto de envios por tick — POR AGENTE, não global. Vários agentes
        // compartilham a MESMA instância Helena (ex.: Costa Lima Odontologia
        // e Maple Bear Osasco, ambos em api.crmmentoriae7.com.br), mas um
        // teto único compartilhado entre todos deixava o primeiro agente da
        // lista (ordenados por agent_id) esgotar sozinho o orçamento do tick
        // inteiro — MB Osasco simplesmente nunca era alcançado enquanto Costa
        // Lima Odontologia tivesse backlog. Por agente, cada um tem sua cota
        // garantida a cada tick e nenhum morre de fome; o teto ainda evita
        // que UM agente com represa grande dispare tudo de uma vez (causa
        // real de 429/rate-limit já visto em produção).
        const MAX_SENDS_PER_TICK_PER_AGENT = 10;

        for (const [agentId, agentSteps] of stepsByAgent) {
          // Verifica se agente está ativo
          const agentRow = await sb
            .from("agents")
            .select("id, account_id, ativo, settings")
            .eq("id", agentId)
            .single();
          if (!agentRow.data?.ativo) continue;
          const agentSettings = agentRow.data.settings as Record<string, string> | null;
          // Modo teste: NÃO dispara follow-up (o dono ainda está testando e não
          // quer que a automação alcance clientes reais).
          if (agentSettings?.test_mode === "true") {
            console.log(`[followup-seq] agente ${agentId} em modo teste — follow-ups suspensos`);
            continue;
          }
          const accountId = agentRow.data.account_id as string;
          const blockedTagsRaw = agentSettings?.blocked_tags ?? null;

          // Busca as conversas do agente, paginando (não confiar em .limit()
          // sozinho — caso MB Osasco: .limit(500) sem order() deixava as
          // recentes de fora). Da MAIS NOVA para a mais antiga: quem acabou de
          // conversar é quem mais precisa do follow-up e deve ser servido
          // primeiro quando a cota do tick é disputada.
          // Sem step com template, conversa parada há mais de 24h nunca envia
          // nada (WhatsApp só entrega texto livre dentro da janela) — nem
          // busca. Na Sorriso Saúde eram ~700 de 1.122 conversas por tick.
          const staleCutoffIso = agentNeedsStaleConversations(agentSteps)
            ? null
            : new Date(now.getTime() - WHATSAPP_WINDOW_MS).toISOString();
          const convs: {
            id: string;
            phone: string | null;
            helena_session_id: string | null;
            channel: string | null;
            meta: unknown;
          }[] = [];
          const CONV_PAGE_SIZE = 1000;
          for (let from = 0; ; from += CONV_PAGE_SIZE) {
            let q = sb
              .from("conversations")
              .select("id, phone, helena_session_id, channel, meta")
              .eq("agent_id", agentId);
            if (staleCutoffIso) q = q.gte("atualizado_em", staleCutoffIso);
            const { data: page, error: convErr } = await q
              .order("criado_em", { ascending: false })
              .order("id", { ascending: true })
              .range(from, from + CONV_PAGE_SIZE - 1);
            if (convErr) {
              console.error(
                `[followup-seq] erro paginando conversas do agente ${agentId}:`,
                convErr.message,
              );
              break;
            }
            if (!page || page.length === 0) break;
            convs.push(...page);
            if (page.length < CONV_PAGE_SIZE) break;
          }
          if (!convs.length) continue;

          let agentSent = 0; // envios deste agente neste tick — reseta por agente

          for (const conv of convs) {
            try {
              const convId = conv.id as string;

              // Lead já agendado/escalado → nunca enviar follow-up.
              if (shouldSkipFollowup(conv.meta as ConversationMeta | null)) continue;

              // Retorno agendado pelo lead ("me chama amanhã"): segura toda a
              // sequência até a data combinada. Quando a data chega, o follow-up
              // volta a fluir normalmente.
              if (isHeldByCallback(conv.meta as ConversationMeta | null, now)) {
                continue;
              }

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
                .select("step_id, sent_at")
                .eq("conversation_id", convId)
                .eq("status", "sent")
                .gt("sent_at", cycleStartAt.toISOString());

              // Delay, horário permitido e janela de 24h do WhatsApp — tudo
              // decidido ANTES de gastar cota. Só envio de verdade conta.
              const decision = planFollowupStep({
                steps: agentSteps,
                sentInCycle: (alreadySent ?? []) as { step_id: string; sent_at: string }[],
                lastMsgAt,
                cycleStartAt,
                now,
              });
              if (decision.kind !== "send_text" && decision.kind !== "send_template") continue;
              const nextStep = decision.step;
              const sessionId = (conv.helena_session_id as string | null) ?? null;
              // Template precisa da sessão Helena pra descobrir o canal.
              if (decision.kind === "send_template" && !sessionId) continue;

              // Teto deste agente atingido neste tick: passa pro PRÓXIMO
              // agente (não para o tick inteiro — outros agentes não podem
              // pagar pelo backlog deste). Esta conversa e as demais deste
              // agente seguem elegíveis e tentam de novo no próximo tick.
              if (agentSent >= MAX_SENDS_PER_TICK_PER_AGENT) {
                console.log(
                  `[followup-seq] agente ${agentId}: limite de ${MAX_SENDS_PER_TICK_PER_AGENT} envios/tick atingido — resto fica pro próximo tick`,
                );
                break;
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

                // Respeita "IA Desligada"/blocked_tags: se o contato tem a
                // etiqueta de pausa no CRM, NÃO envia follow-up. (Antes o
                // follow-up ignorava a etiqueta e falava com leads pausados.)
                const block = await checkContactBlockedBySession({
                  accountId,
                  sessionId: sessionId ?? undefined,
                  blockedTagsRaw,
                });
                if (block.blocked) {
                  console.log(
                    `[followup-seq] pulando conv ${convId} — IA pausada pela etiqueta "${block.tag}"`,
                  );
                  continue;
                }

              attempted++;
              agentSent++;

              // ── Fora da janela de 24h do WhatsApp → template oficial ────
              // Texto livre só é entregue dentro de 24h da ÚLTIMA msg do lead.
              // Fora disso (ex.: retorno agendado "me chama amanhã"), só
              // template. Sem template o planFollowupStep já descartou acima.
              if (decision.kind === "send_template" && sessionId) {
                const templateName = decision.templateName;
                try {
                  const helena = await loadHelenaAccount(accountId);
                  const session = await loadHelenaSession(helena, sessionId).catch(() => null);
                  const channelId = session?.channelId ?? null;
                  if (!channelId) {
                    await sb.from("followup_step_runs").insert({
                      step_id: nextStep.id, conversation_id: convId, agent_id: agentId,
                      status: "failed", error: "no_channel_id_on_session",
                    });
                    continue;
                  }
                  const template = await findHelenaTemplateByName(helena, channelId, templateName);
                  if (!template) {
                    await sb.from("followup_step_runs").insert({
                      step_id: nextStep.id, conversation_id: convId, agent_id: agentId,
                      status: "failed", error: `template_not_found:${templateName}`,
                    });
                    continue;
                  }
                  const convMeta = conv.meta as { lead_data?: { name?: string } } | null;
                  const leadName = (convMeta?.lead_data?.name ?? "").toString().trim();
                  const sendRes = await sendHelenaTemplate(helena, {
                    sessionId,
                    templateId: template.id,
                    parameters: leadName ? { nome: leadName } : {},
                  });
                  if (!sendRes.ok) {
                    await sb.from("followup_step_runs").insert({
                      step_id: nextStep.id, conversation_id: convId, agent_id: agentId,
                      status: "failed",
                      error: `Helena template ${sendRes.status}: ${sendRes.body.slice(0, 200)}`,
                    });
                    continue;
                  }
                  await sb.from("messages").insert({
                    conversation_id: convId, role: "assistant",
                    content: `[template] ${templateName}`,
                    meta: {
                      origem: "followup",
                      followup_step_ordem: nextStep.ordem,
                      followup_mode: "template",
                      helena_template_name: templateName,
                    },
                  });
                  await sb.from("followup_step_runs").insert({
                    step_id: nextStep.id, conversation_id: convId, agent_id: agentId,
                    message_sent: `[template] ${templateName}`, status: "sent",
                  });
                  console.log(
                    `[followup-seq] conv ${convId} fora das 24h → template "${templateName}" enviado`,
                  );
                  processed++;
                } catch (e) {
                  const msg = e instanceof Error ? e.message : String(e);
                  console.error(`[followup-seq] template falhou conv ${convId}: ${msg}`);
                  await sb.from("followup_step_runs").insert({
                    step_id: nextStep.id, conversation_id: convId, agent_id: agentId,
                    status: "failed", error: msg.slice(0, 500),
                  });
                }
                continue;
              }

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
