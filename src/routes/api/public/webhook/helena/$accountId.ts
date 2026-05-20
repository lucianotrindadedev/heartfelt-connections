// Webhook público recebendo eventos do CRM Helena.
// POST /api/public/webhook/helena/$accountId
//
// Suporta 2 formatos:
//
// NOVO (Helena nativo):
//   { eventType: "MESSAGE_RECEIVED", content: { companyId, text, direction, sessionId,
//     details: { from, to } } }
//   Auth: companyId no payload deve bater com accountId na URL.
//
// LEGADO (N8N / formato antigo):
//   { evento, telefone, conteudo, origem, session_id }
//   Auth: header X-Helena-Secret com agents.webhook_secret.
import { createFileRoute } from "@tanstack/react-router";
import { getSelfhost } from "@/integrations/selfhost/client.server";
import { runAgentTurn } from "@/lib/agent-turn.server";
import { enqueueMessage } from "@/lib/message-queue.server";

// ── Tipo do formato novo (Helena nativo) ──────────────────────────

interface HelenaDetails {
  to?: string | null;
  from?: string | null;
  file?: unknown;
  transcription?: unknown;
}

interface HelenaContent {
  id?: string;
  companyId?: string;
  senderId?: string | null;
  userId?: string | null;
  type?: string;          // "TEXT" | "AUDIO" | "IMAGE" etc.
  sessionId?: string;
  text?: string | null;
  direction?: string;     // "FROM_HUB" = inbound | "TO_HUB" = outbound
  origin?: string;        // "GATEWAY" | "BOT" | "AGENT"
  status?: string;
  details?: HelenaDetails;
  fileId?: string | null;
}

interface HelenaPayload {
  eventType?: string;     // "MESSAGE_RECEIVED" | ...
  date?: string;
  content?: HelenaContent;
  changeMetadata?: unknown;
  // Campos legado na mesma interface (para tipagem unificada)
  evento?: string;
  telefone?: string;
  phone?: string;
  tipo?: string;
  conteudo?: string;
  texto?: string;
  audio_url?: string;
  session_id?: string;
  origem?: string;
}

// ── Utilitários ───────────────────────────────────────────────────

function timingSafeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

// ── Handler ───────────────────────────────────────────────────────

export const Route = createFileRoute("/api/public/webhook/helena/$accountId")({
  server: {
    handlers: {
      POST: async ({ request, params }) => {
        const accountId = params.accountId;
        const sb = getSelfhost();

        // 1. Carrega agente
        const agentRow = await sb
          .from("agents")
          .select("id, ativo, webhook_secret, debounce_segundos")
          .eq("account_id", accountId)
          .maybeSingle();
        if (!agentRow.data) {
          return new Response("Account not found", { status: 404 });
        }

        // 2. Parse payload
        let body: HelenaPayload;
        try {
          body = (await request.json()) as HelenaPayload;
        } catch {
          return new Response("Invalid JSON", { status: 400 });
        }

        // 3. Detecta formato pelo conteúdo do payload (não pelo header)
        const isNewFormat = !!body.eventType;

        // 4. Autenticação baseada no formato detectado
        if (isNewFormat) {
          // Formato nativo Helena: ignora x-helena-secret, valida companyId no payload
          const payloadCompanyId = body.content?.companyId;
          if (!payloadCompanyId || payloadCompanyId !== accountId) {
            return new Response("Unauthorized: companyId mismatch", { status: 401 });
          }
        } else {
          // Formato legado (N8N): valida pelo header x-helena-secret
          const providedSecret = request.headers.get("x-helena-secret") ?? "";
          const expectedSecret = (agentRow.data.webhook_secret as string | null) ?? "";
          if (expectedSecret && !timingSafeEqual(providedSecret, expectedSecret)) {
            return new Response("Invalid secret", { status: 401 });
          }
        }

        let phone: string;
        let messageContent: string;
        let sessionId: string | undefined;
        let audioUrl: string | null = null;
        let isInbound: boolean;
        let isHuman: boolean;
        let messageType: string;
        let origem: string;

        if (isNewFormat) {
          const c = body.content ?? {};

          // FROM_HUB = mensagem vinda do cliente para a plataforma Helena (inbound)
          // TO_HUB   = mensagem enviada pela Helena/agente para o cliente (outbound)
          isInbound =
            body.eventType === "MESSAGE_RECEIVED" &&
            (c.direction === "FROM_HUB" ||
              c.origin === "GATEWAY" ||
              c.origin === "CUSTOMER");

          // Identifica se foi humano ou agente
          isHuman = !isInbound && !!(c.userId);
          messageType = c.type ?? "TEXT";
          phone = (c.details?.from ?? "").toString().trim();
          messageContent = (c.text ?? "").toString();
          sessionId = c.sessionId;
          origem = isInbound
            ? "lead"
            : isHuman
              ? "humano"
              : "agente";

        } else {
          // Formato legado
          phone = (body.telefone ?? body.phone ?? "").toString().trim();
          messageContent = (body.conteudo ?? body.texto ?? "").toString();
          sessionId = body.session_id;
          audioUrl = body.audio_url ?? null;
          messageType = body.tipo ?? "TEXT";

          const evento = (body.evento ?? "mensagem_recebida").toLowerCase();
          const legadoOrigem = (body.origem ?? "").toLowerCase();
          isInbound =
            evento === "mensagem_recebida" ||
            legadoOrigem === "lead" ||
            legadoOrigem === "cliente";
          isHuman = legadoOrigem === "humano" || legadoOrigem === "atendente";
          origem = isInbound ? "lead" : isHuman ? "humano" : "agente";
        }

        if (!phone) return new Response("Missing phone", { status: 400 });

        // Ignora eventos de status / entrega / leitura sem conteúdo de mensagem
        if (!isInbound && !isHuman && !messageContent) {
          return Response.json({ ok: true, skipped: "no-content" });
        }

        // 5. Upsert conversa
        let convId: string;
        const existingConv = await sb
          .from("conversations")
          .select("id")
          .eq("agent_id", agentRow.data.id)
          .eq("phone", phone)
          .maybeSingle();

        if (existingConv.data) {
          convId = existingConv.data.id as string;
          if (sessionId) {
            await sb
              .from("conversations")
              .update({ helena_session_id: sessionId })
              .eq("id", convId);
          }
        } else {
          const ins = await sb
            .from("conversations")
            .insert({
              agent_id: agentRow.data.id,
              phone,
              helena_session_id: sessionId ?? null,
            })
            .select("id")
            .single();
          if (ins.error) {
            return new Response(`DB error: ${ins.error.message}`, { status: 500 });
          }
          convId = ins.data.id as string;
        }

        // 6. Persiste mensagem
        const role = isInbound ? "user" : "assistant";
        const meta: Record<string, unknown> = {
          origem,
          tipo: messageType,
          ...(isNewFormat
            ? {
                direction: body.content?.direction,
                helena_msg_id: body.content?.id,
              }
            : { evento: body.evento ?? "mensagem_recebida" }),
        };

        await sb.from("messages").insert({
          conversation_id: convId,
          role,
          content: messageContent,
          audio_url: audioUrl,
          meta,
        });

        // 7. Atualiza last_user_message_at se inbound
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

        // 8. Dispara agente: apenas mensagens inbound + agente ativo
        if (isInbound && agentRow.data.ativo) {
          const debounce = (agentRow.data.debounce_segundos as number | null) ?? 20;
          try {
            if (debounce > 0) {
              await enqueueMessage(convId, debounce);
            } else {
              await runAgentTurn(convId);
            }
          } catch (e) {
            console.error("[agent-turn] falhou:", e);
          }
        }

        return Response.json({ ok: true, conversation_id: convId, role });
      },
    },
  },
});
