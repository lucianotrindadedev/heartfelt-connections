// Webhook público recebendo eventos do CRM Helena.
// POST /api/public/webhook/helena/$accountId
// Header: X-Helena-Secret: <agents.webhook_secret>
//
// Aceita 2 eventos:
//   - mensagem do lead (role=user)   → grava + dispara agente (se ativo)
//   - mensagem enviada (atendente/agente) → grava (sem disparar agente)
import { createFileRoute } from "@tanstack/react-router";
import { getSelfhost } from "@/integrations/selfhost/client.server";
import { runAgentTurn } from "@/lib/agent-turn.server";

interface Payload {
  evento?: string; // mensagem_recebida | mensagem_enviada
  telefone?: string;
  phone?: string;
  tipo?: string; // texto | audio
  conteudo?: string;
  content?: string;
  texto?: string;
  audio_url?: string;
  session_id?: string;
  origem?: string; // humano | agente | lead
}

function timingSafeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

export const Route = createFileRoute("/api/public/webhook/helena/$accountId")({
  server: {
    handlers: {
      POST: async ({ request, params }) => {
        const accountId = params.accountId;
        const sb = getSelfhost();

        // 1. Carrega agente + secret
        const agentRow = await sb
          .from("agents")
          .select("id, ativo, webhook_secret")
          .eq("account_id", accountId)
          .maybeSingle();
        if (!agentRow.data) {
          return new Response("Account not found", { status: 404 });
        }

        // 2. Valida secret
        const provided = request.headers.get("x-helena-secret") ?? "";
        const expected = agentRow.data.webhook_secret as string;
        if (!provided || !timingSafeEqual(provided, expected)) {
          return new Response("Invalid secret", { status: 401 });
        }

        // 3. Parse payload
        let body: Payload;
        try {
          body = (await request.json()) as Payload;
        } catch {
          return new Response("Invalid JSON", { status: 400 });
        }

        const phone = (body.telefone ?? body.phone ?? "").toString().trim();
        if (!phone) return new Response("Missing phone", { status: 400 });

        const content = (body.conteudo ?? body.content ?? body.texto ?? "").toString();
        const evento = (body.evento ?? "mensagem_recebida").toLowerCase();
        const origem = (body.origem ?? "").toLowerCase();

        const isInbound =
          evento === "mensagem_recebida" || origem === "lead" || origem === "cliente";
        const isHuman = origem === "humano" || origem === "atendente";
        const isAgent = origem === "agente" || origem === "ia";

        // 4. Upsert conversation
        let convId: string;
        const existingConv = await sb
          .from("conversations")
          .select("id")
          .eq("agent_id", agentRow.data.id)
          .eq("phone", phone)
          .maybeSingle();
        if (existingConv.data) {
          convId = existingConv.data.id as string;
          if (body.session_id) {
            await sb
              .from("conversations")
              .update({ helena_session_id: body.session_id })
              .eq("id", convId);
          }
        } else {
          const ins = await sb
            .from("conversations")
            .insert({
              agent_id: agentRow.data.id,
              phone,
              helena_session_id: body.session_id ?? null,
            })
            .select("id")
            .single();
          if (ins.error) {
            return new Response(`DB error: ${ins.error.message}`, { status: 500 });
          }
          convId = ins.data.id as string;
        }

        // 5. Persiste mensagem
        const role = isInbound ? "user" : "assistant";
        const meta: Record<string, unknown> = {
          origem: isHuman ? "humano" : isAgent ? "agente" : isInbound ? "lead" : "desconhecido",
          evento,
        };

        await sb.from("messages").insert({
          conversation_id: convId,
          role,
          content,
          audio_url: body.audio_url ?? null,
          meta,
        });

        // 6. Atualiza last_user_message_at se inbound
        if (isInbound) {
          await sb
            .from("conversation_state")
            .upsert(
              {
                conversation_id: convId,
                last_user_message_at: new Date().toISOString(),
                aguardando_followup: false,
                numero_followup: 0,
              },
              { onConflict: "conversation_id" },
            );
        }

        // 7. Dispara agente quando: inbound + agente ativo
        // (mensagens de humano/agente são apenas gravadas)
        // Aguardamos para garantir execução no runtime do Worker.
        if (isInbound && agentRow.data.ativo) {
          try {
            await runAgentTurn(convId);
          } catch (e) {
            console.error("[agent-turn] falhou:", e);
          }
        }


        return Response.json({ ok: true, conversation_id: convId, role });
      },
    },
  },
});
