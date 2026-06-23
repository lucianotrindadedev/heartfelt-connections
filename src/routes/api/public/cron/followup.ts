// POST /api/public/cron/followup — envia follow-ups automáticos para leads em silêncio
// Chamado pelo pg_cron a cada 10 minutos (8h-21h).
import { createFileRoute } from "@tanstack/react-router";
import { getSelfhost } from "@/integrations/selfhost/client.server";
import { loadHelenaAccount, sendHelenaText } from "@/lib/helena.server";
import { checkContactBlockedBySession } from "@/lib/agent-block.server";

function validateCronSecret(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  return request.headers.get("x-cron-secret") === secret;
}

export const Route = createFileRoute("/api/public/cron/followup")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        if (!validateCronSecret(request)) {
          return new Response("Unauthorized", { status: 401 });
        }

        const sb = getSelfhost();
        const now = new Date();

        // Busca conversations aguardando follow-up com agente ativo
        const { data: states, error } = await sb
          .from("conversation_state")
          .select(
            "conversation_id, last_user_message_at, numero_followup, aguardando_followup",
          )
          .eq("aguardando_followup", true);

        if (error || !states?.length) {
          return Response.json({ ok: true, processed: 0 });
        }

        let processed = 0;

        for (const state of states) {
          const convId = state.conversation_id as string;
          const lastMsg = new Date(state.last_user_message_at as string);
          const nFu = (state.numero_followup as number) || 0;

          // Carrega agente e configuração de follow-up
          const conv = await sb
            .from("conversations")
            .select("id, phone, helena_session_id, agent_id, lead_phone, channel")
            .eq("id", convId)
            .single();
          if (!conv.data) continue;

          const sessionId = (conv.data.helena_session_id as string | null) ?? undefined;
          if (!sessionId) continue;

          const agent = await sb
            .from("agents")
            .select("id, account_id, ativo, settings")
            .eq("id", conv.data.agent_id)
            .single();
          if (!agent.data?.ativo) continue;

          const accountId = agent.data.account_id as string;
          const agentId = agent.data.id as string;

          // Respeita "IA Desligada"/blocked_tags (mesma regra do webhook).
          const block = await checkContactBlockedBySession({
            accountId,
            sessionId,
            blockedTagsRaw:
              (agent.data.settings as Record<string, string> | null)?.blocked_tags ?? null,
          });
          if (block.blocked) {
            console.log(
              `[followup] pulando conv ${convId} — IA pausada pela etiqueta "${block.tag}"`,
            );
            continue;
          }

          const fu = await sb
            .from("agent_followup")
            .select("ativo, max_tentativas, delay_horas, prompt_fu1, prompt_fu2")
            .eq("agent_id", agentId)
            .single();

          if (!fu.data?.ativo) continue;

          const maxTentativas = (fu.data.max_tentativas as number) ?? 2;
          if (nFu >= maxTentativas) {
            // Desativa follow-up para esta conversa
            await sb
              .from("conversation_state")
              .update({ aguardando_followup: false })
              .eq("conversation_id", convId);
            continue;
          }

          const delays = (fu.data.delay_horas as number[] | null) ?? [1, 5];
          const delayHoras = delays[nFu] ?? delays[delays.length - 1];
          const triggerAt = new Date(lastMsg.getTime() + delayHoras * 60 * 60 * 1000);

          if (now < triggerAt) continue; // ainda não é hora

          const prompt = nFu === 0
            ? ((fu.data.prompt_fu1 as string) || "")
            : ((fu.data.prompt_fu2 as string) || "");

          if (!prompt) continue;

          // Envia follow-up
          try {
            const helena = await loadHelenaAccount(accountId);
            const phone =
              (conv.data.lead_phone as string | null) ?? (conv.data.phone as string);

            const sendRes = await sendHelenaText(helena, { phone, text: prompt, sessionId });

            if (sendRes.ok) {
              // Persiste mensagem no DB
              await sb.from("messages").insert({
                conversation_id: convId,
                role: "assistant",
                content: prompt,
                meta: { origem: "agente", tipo: "followup", numero_followup: nFu + 1 },
              });

              // Atualiza estado
              await sb.from("conversation_state").update({
                numero_followup: nFu + 1,
                aguardando_followup: nFu + 1 < maxTentativas,
              }).eq("conversation_id", convId);

              processed++;
            }
          } catch (e) {
            console.error(`[followup] erro para conversa ${convId}:`, e);
          }
        }

        return Response.json({ ok: true, processed });
      },
    },
  },
});
