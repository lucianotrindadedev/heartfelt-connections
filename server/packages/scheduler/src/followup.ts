import {
  db, agents, conversations, conversationState, messages,
  agentFollowupConfig, integrations,
  callLlm, HelenaClient, logger, env, redis,
} from "@sarai/shared";
import type { LlmMessage } from "@sarai/shared";
import { eq, and, sql, desc } from "drizzle-orm";

export async function runFollowupTick() {
  logger.info("followup tick starting");

  try {
    // Find all conversations awaiting followup
    const pending = await db.select({
      conversationId: conversationState.conversationId,
      numeroFollowup: conversationState.numeroFollowup,
      lastUserMessageAt: conversationState.lastUserMessageAt,
    })
    .from(conversationState)
    .where(and(
      eq(conversationState.aguardandoFollowup, true),
      eq(conversationState.lockConversa, false),
    ));

    for (const row of pending) {
      try {
        // Get conversation
        const [conv] = await db.select().from(conversations)
          .where(eq(conversations.id, row.conversationId));
        if (!conv || conv.status !== "active") continue;

        // Get agent and followup config
        const [agent] = await db.select().from(agents)
          .where(and(eq(agents.id, conv.agentId), eq(agents.enabled, true)));
        if (!agent) continue;

        const [fConfig] = await db.select().from(agentFollowupConfig)
          .where(eq(agentFollowupConfig.agentId, agent.id));
        if (!fConfig || !fConfig.enabled) continue;

        // Get Helena config
        const [helenaInt] = await db.execute(
          sql`SELECT pgp_sym_decrypt(config_enc, ${env.PGCRYPTO_KEY}) as config
              FROM integrations
              WHERE account_id = ${agent.accountId} AND type = 'helena_crm'`
        );
        if (!helenaInt?.config) continue;
        const helenaConfig = JSON.parse(helenaInt.config as string);
        const helena = new HelenaClient({ baseUrl: helenaConfig.base_url, token: helenaConfig.token });

        // Check tags: block if IA DESLIGADA, IA AGENDOU, CRC AGENDOU
        if (conv.helenaContactId) {
          try {
            const contact = await helena.getContact(conv.helenaContactId);
            const tags = (contact.tagNames || []).map(t => t.toUpperCase());
            if (tags.includes("IA DESLIGADA") || tags.includes("IA AGENDOU") || tags.includes("CRC AGENDOU")) {
              // Disable followup for this conversation
              await db.update(conversationState).set({
                aguardandoFollowup: false, updatedAt: new Date(),
              }).where(eq(conversationState.conversationId, row.conversationId));
              continue;
            }
          } catch {}
        }

        // Check max followups
        if (row.numeroFollowup >= fConfig.maxFollowups) {
          await db.update(conversationState).set({
            aguardandoFollowup: false, updatedAt: new Date(),
          }).where(eq(conversationState.conversationId, row.conversationId));
          continue;
        }

        // Check Helena session status (must be PENDING)
        if (conv.helenaSessionId) {
          try {
            const session = await helena.getSession(conv.helenaSessionId);
            if (session.status !== "PENDING") continue;
          } catch {}
        }

        // Check timing based on follow_ups_horas config
        // The followup config may have a custom "follow_ups_horas" in the prompts JSON
        // Default: [1, 5] (hours after last interaction)
        const followupHours: number[] = (fConfig.prompts as any)?.follow_ups_horas || [1, 5];
        const hoursForThisFollowup = followupHours[Math.min(row.numeroFollowup, followupHours.length - 1)] || 1;
        
        const lastMsg = row.lastUserMessageAt ? new Date(row.lastUserMessageAt) : null;
        if (!lastMsg) continue;
        
        const hoursSinceLastMsg = (Date.now() - lastMsg.getTime()) / 3600000;
        if (hoursSinceLastMsg < hoursForThisFollowup) continue;

        // ── TIME TO SEND FOLLOW-UP ──

        // Get OpenRouter API key
        const [orInt] = await db.execute(
          sql`SELECT pgp_sym_decrypt(config_enc, ${env.PGCRYPTO_KEY}) as config
              FROM integrations
              WHERE account_id = ${agent.accountId} AND type = 'openrouter'`
        );
        const apiKey = orInt?.config ? JSON.parse(orInt.config as string).api_key : null;

        // Get followup prompts from config
        const prompts = (fConfig.prompts as any)?.messages || fConfig.prompts;
        let followupText: string;

        if (apiKey && agent.systemPrompt) {
          // Run AI agent for contextual followup (like n8n's "Agente de Recuperação de Leads")
          // Load conversation history
          const historyRows = await db.select().from(messages)
            .where(eq(messages.conversationId, conv.id))
            .orderBy(desc(messages.createdAt))
            .limit(50);
          
          const history: LlmMessage[] = historyRows.reverse().map(r => ({
            role: r.role as LlmMessage["role"],
            content: r.content,
          }));

          const followupNumber = row.numeroFollowup + 1;
          const systemPrompt = `Você é um agente de follow-up. O lead não respondeu após um período estendido.
Este é o follow-up #${followupNumber} de ${fConfig.maxFollowups}.
${followupNumber === 1 ? "Envie uma mensagem contextual baseada no histórico da conversa." : "Envie uma mensagem curta e direta."}
Regras: Uma pergunta por mensagem. Máximo 250 caracteres. Nunca repita mensagens anteriores. Não use "de graça" ou "gratuita".
---
${agent.systemPrompt}`;

          const llmMessages: LlmMessage[] = [
            { role: "system", content: systemPrompt },
            ...history,
            { role: "user", content: "<lead não respondeu após período estendido de tempo>" },
          ];

          const res = await callLlm({
            apiKey,
            model: agent.llmModel || env.OPENROUTER_DEFAULT_MODEL,
            messages: llmMessages,
            temperature: 0.9,
            maxTokens: 512,
          });
          followupText = res.content;
        } else {
          // Use static prompt from config
          const staticPrompts = Array.isArray(prompts) ? prompts : [];
          const idx = Math.min(row.numeroFollowup, staticPrompts.length - 1);
          followupText = staticPrompts[idx] || "Olá! Posso te ajudar com algo?";
        }

        // Send via Helena
        if (conv.helenaSessionId) {
          await helena.sendMessage(conv.helenaSessionId, followupText);
        }

        // Store followup message in DB
        await db.insert(messages).values({
          conversationId: conv.id,
          role: "assistant",
          content: followupText,
        });

        // Update state
        await db.update(conversationState).set({
          numeroFollowup: row.numeroFollowup + 1,
          updatedAt: new Date(),
        }).where(eq(conversationState.conversationId, row.conversationId));

        logger.info({
          conversationId: row.conversationId,
          followup: row.numeroFollowup + 1,
          phone: conv.phone,
        }, "followup sent via Helena");

      } catch (e: any) {
        logger.error({ conversationId: row.conversationId, err: e.message }, "followup failed");
      }
    }
  } catch (e: any) {
    logger.error({ err: e.message }, "followup tick failed");
  }
}
