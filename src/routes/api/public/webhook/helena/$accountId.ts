// Webhook público recebendo eventos do CRM Helena.
// POST /api/public/webhook/helena/$accountId
import { createFileRoute } from "@tanstack/react-router";
import { getSelfhost } from "@/integrations/selfhost/client.server";
import {
  buildConversationKey,
  detectChannelFromSession,
  isLikelyWhatsAppIdentifier,
  normalizeBrazilPhone,
  type ConversationChannel,
} from "@/lib/conversation-channel.server";
import { runAgentTurn } from "@/lib/agent-turn.server";
import { enqueueMessage } from "@/lib/message-queue.server";
import {
  getContactChannel,
  loadHelenaAccount,
  loadHelenaContactFromSession,
  loadHelenaSession,
} from "@/lib/helena.server";

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
  type?: string;
  sessionId?: string;
  text?: string | null;
  direction?: string;
  origin?: string;
  status?: string;
  details?: HelenaDetails;
  fileId?: string | null;
}

interface HelenaPayload {
  eventType?: string;
  date?: string;
  content?: HelenaContent;
  changeMetadata?: unknown;
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

function timingSafeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

interface ConversationUpsertInput {
  agentId: string;
  sessionId?: string;
  fromDetails?: string;
  legacyPhone?: string;
}

async function upsertConversation(
  accountId: string,
  input: ConversationUpsertInput,
): Promise<string | null> {
  const sb = getSelfhost();
  let channel: ConversationChannel = "unknown";
  let contactId: string | null = null;
  let instagram: string | null = null;
  let messengerId: string | null = null;
  let contactPhone: string | null = null;
  let leadPhone: string | null = null;
  let sessionChannelId: string | null = null;

  if (input.sessionId) {
    try {
      const helena = await loadHelenaAccount(accountId);
      const contact = await loadHelenaContactFromSession(helena, input.sessionId);
      const session = await loadHelenaSession(helena, input.sessionId);
      sessionChannelId = session?.channelId ?? null;
      if (contact) {
        contactId = contact.id;
        instagram = contact.instagram;
        messengerId = contact.messengerId;
        contactPhone = normalizeBrazilPhone(contact.phoneNumber);
        channel = getContactChannel(contact, sessionChannelId);
      } else if (sessionChannelId) {
        channel = detectChannelFromSession(sessionChannelId);
      }
    } catch (e) {
      console.warn("[webhook] falha ao enriquecer sessão Helena:", e);
    }
  }

  if (channel === "unknown" && input.fromDetails) {
    if (isLikelyWhatsAppIdentifier(input.fromDetails)) {
      channel = "whatsapp";
    }
  }
  if (channel === "unknown" && input.legacyPhone && isLikelyWhatsAppIdentifier(input.legacyPhone)) {
    channel = "whatsapp";
  }

  const conversationPhone = buildConversationKey({
    channel,
    fromDetails: input.fromDetails ?? input.legacyPhone,
    instagram,
    messengerId,
    sessionId: input.sessionId,
    contactPhone,
    leadPhone,
  });

  const channelIdentifier =
    instagram ?? messengerId ?? (channel === "whatsapp" ? conversationPhone : null);

  // 1) Busca por sessionId (multicanal)
  if (input.sessionId) {
    const bySession = await sb
      .from("conversations")
      .select("id, phone, lead_phone")
      .eq("agent_id", input.agentId)
      .eq("helena_session_id", input.sessionId)
      .maybeSingle();

    if (bySession.data) {
      const convId = bySession.data.id as string;
      const updates: Record<string, unknown> = {
        channel,
        channel_identifier: channelIdentifier,
        atualizado_em: new Date().toISOString(),
      };
      if (contactId) updates.helena_contact_id = contactId;
      const existingLead = normalizeBrazilPhone(bySession.data.lead_phone as string | null);
      if (!existingLead && contactPhone) updates.lead_phone = contactPhone;

      await sb.from("conversations").update(updates).eq("id", convId);
      return convId;
    }
  }

  // 2) Busca por phone legado (WhatsApp / migração)
  const byPhone = await sb
    .from("conversations")
    .select("id")
    .eq("agent_id", input.agentId)
    .eq("phone", conversationPhone)
    .maybeSingle();

  if (byPhone.data) {
    const convId = byPhone.data.id as string;
    await sb
      .from("conversations")
      .update({
        helena_session_id: input.sessionId ?? null,
        helena_contact_id: contactId,
        channel,
        channel_identifier: channelIdentifier,
        lead_phone: contactPhone,
      })
      .eq("id", convId);
    return convId;
  }

  const ins = await sb
    .from("conversations")
    .insert({
      agent_id: input.agentId,
      phone: conversationPhone,
      helena_session_id: input.sessionId ?? null,
      helena_contact_id: contactId,
      channel,
      channel_identifier: channelIdentifier,
      lead_phone: contactPhone,
    })
    .select("id")
    .single();

  if (ins.error) {
    console.error("[webhook] insert conversation:", ins.error.message);
    return null;
  }
  return ins.data.id as string;
}

export const Route = createFileRoute("/api/public/webhook/helena/$accountId")({
  server: {
    handlers: {
      POST: async ({ request, params }) => {
        const accountId = params.accountId;
        const sb = getSelfhost();

        const agentRow = await sb
          .from("agents")
          .select("id, ativo, webhook_secret, debounce_segundos")
          .eq("account_id", accountId)
          .maybeSingle();
        if (!agentRow.data) {
          return new Response("Account not found", { status: 404 });
        }

        let body: HelenaPayload;
        try {
          body = (await request.json()) as HelenaPayload;
        } catch {
          return new Response("Invalid JSON", { status: 400 });
        }

        const isNewFormat = !!body.eventType;

        if (isNewFormat) {
          const payloadCompanyId = body.content?.companyId;
          if (!payloadCompanyId || payloadCompanyId !== accountId) {
            return new Response("Unauthorized: companyId mismatch", { status: 401 });
          }
        } else {
          const providedSecret = request.headers.get("x-helena-secret") ?? "";
          const expectedSecret = (agentRow.data.webhook_secret as string | null) ?? "";
          if (expectedSecret && !timingSafeEqual(providedSecret, expectedSecret)) {
            return new Response("Invalid secret", { status: 401 });
          }
        }

        let fromDetails = "";
        let messageContent: string;
        let sessionId: string | undefined;
        let audioUrl: string | null = null;
        let isInbound: boolean;
        let isHuman: boolean;
        let messageType: string;
        let origem: string;
        let legacyPhone = "";

        if (isNewFormat) {
          const c = body.content ?? {};
          isInbound =
            body.eventType === "MESSAGE_RECEIVED" &&
            (c.direction === "FROM_HUB" ||
              c.origin === "GATEWAY" ||
              c.origin === "CUSTOMER");
          isHuman = !isInbound && !!c.userId;
          messageType = c.type ?? "TEXT";
          fromDetails = (c.details?.from ?? "").toString().trim();
          messageContent = (c.text ?? "").toString();
          sessionId = c.sessionId;
          origem = isInbound ? "lead" : isHuman ? "humano" : "agente";
        } else {
          legacyPhone = (body.telefone ?? body.phone ?? "").toString().trim();
          fromDetails = legacyPhone;
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

        if (!sessionId && !fromDetails && !legacyPhone) {
          return new Response("Missing sessionId or contact identifier", { status: 400 });
        }

        if (!isInbound && !isHuman && !messageContent) {
          return Response.json({ ok: true, skipped: "no-content" });
        }

        const convId = await upsertConversation(accountId, {
          agentId: agentRow.data.id as string,
          sessionId,
          fromDetails: fromDetails || legacyPhone,
          legacyPhone,
        });

        if (!convId) {
          return new Response("DB error: could not upsert conversation", { status: 500 });
        }

        const role = isInbound ? "user" : "assistant";
        const meta: Record<string, unknown> = {
          origem,
          tipo: messageType,
          channel_from: fromDetails || null,
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

        if (isInbound) {
          await sb.from("conversation_state").upsert(
            {
              conversation_id: convId,
              last_user_message_at: new Date().toISOString(),
              aguardando_followup: false,
              numero_followup: 0,
            },
            { onConflict: "conversation_id" },
          );
        }

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
