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
import { enqueueMessage } from "@/lib/message-queue.server";
import { scheduleConversationAgentTurn } from "@/lib/schedule-agent-turn.server";
import {
  isResetCommand,
  resetConversationHistory,
  RESET_CONFIRMATION_MESSAGE,
} from "@/lib/reset-conversation.server";
import {
  getContactChannel,
  loadHelenaAccount,
  loadHelenaContactFromSession,
  loadHelenaSession,
  sendHelenaText,
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
  text?: string | null;
  audio_url?: string;
  session_id?: string;
  sessionId?: string;
  direction?: string;
  origin?: string;
  type?: string;
  userId?: string | null;
  companyId?: string;
  details?: HelenaDetails;
  origem?: string;
}

/** Helena envia 3 formatos: envelope { eventType, content }, conteúdo flat na raiz, ou legado n8n. */
function normalizeHelenaPayload(raw: HelenaPayload): {
  eventType: string;
  content: HelenaContent;
} {
  if (raw.eventType && raw.content) {
    return { eventType: raw.eventType, content: raw.content };
  }

  const flatSession = (raw.sessionId ?? raw.session_id ?? raw.content?.sessionId)?.toString().trim();
  const flatText = raw.text ?? raw.content?.text;
  const flatDirection = raw.direction ?? raw.content?.direction;
  const flatType = raw.type ?? raw.content?.type;

  if (flatSession && (flatDirection || flatText !== undefined || flatType)) {
    return {
      eventType: raw.eventType ?? "MESSAGE_RECEIVED",
      content: {
        id: raw.content?.id,
        companyId: raw.companyId ?? raw.content?.companyId,
        sessionId: flatSession,
        text: flatText ?? null,
        direction: flatDirection,
        origin: raw.origin ?? raw.content?.origin,
        type: flatType ?? "TEXT",
        userId: raw.userId ?? raw.content?.userId,
        details: raw.details ?? raw.content?.details,
      },
    };
  }

  return {
    eventType: (raw.evento ?? "mensagem_recebida").toString(),
    content: {
      sessionId: (raw.session_id ?? raw.sessionId)?.toString(),
      text: (raw.conteudo ?? raw.texto ?? raw.text ?? "").toString() || null,
      type: raw.tipo ?? "TEXT",
      details: {
        from: raw.telefone ?? raw.phone ?? raw.details?.from ?? null,
      },
    },
  };
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

        const { eventType, content: c } = normalizeHelenaPayload(body);
        const isHelenaNative =
          eventType === "MESSAGE_RECEIVED" ||
          !!c.direction ||
          !!c.sessionId;

        if (isHelenaNative) {
          const payloadCompanyId = c.companyId;
          if (payloadCompanyId && payloadCompanyId !== accountId) {
            return new Response("Unauthorized: companyId mismatch", { status: 401 });
          }
        } else {
          const providedSecret = request.headers.get("x-helena-secret") ?? "";
          const expectedSecret = (agentRow.data.webhook_secret as string | null) ?? "";
          if (expectedSecret && !timingSafeEqual(providedSecret, expectedSecret)) {
            return new Response("Invalid secret", { status: 401 });
          }
        }

        const sessionId = c.sessionId?.trim() || undefined;
        const fromDetails = (c.details?.from ?? "").toString().trim();
        const legacyPhone = (body.telefone ?? body.phone ?? "").toString().trim();
        const messageContent = (c.text ?? "").toString();
        const audioUrl = body.audio_url ?? null;
        const messageType = c.type ?? "TEXT";

        const isInbound =
          c.direction === "FROM_HUB" ||
          c.origin === "GATEWAY" ||
          c.origin === "CUSTOMER" ||
          (eventType === "MESSAGE_RECEIVED" &&
            c.direction !== "TO_HUB" &&
            (c.direction === "FROM_HUB" || !c.direction)) ||
          (body.evento ?? "").toLowerCase() === "mensagem_recebida" ||
          (body.origem ?? "").toLowerCase() === "lead" ||
          (body.origem ?? "").toLowerCase() === "cliente";

        const isHuman =
          !isInbound &&
          (!!c.userId ||
            (body.origem ?? "").toLowerCase() === "humano" ||
            (body.origem ?? "").toLowerCase() === "atendente");

        const origem = isInbound ? "lead" : isHuman ? "humano" : "agente";

        if (!sessionId && !fromDetails && !legacyPhone) {
          return new Response("Missing sessionId or contact identifier", { status: 400 });
        }

        // Eco do bot/plataforma (TO_HUB sem atendente) — não grava no histórico do LLM
        if (!isInbound && !isHuman) {
          return Response.json({ ok: true, skipped: "outbound-bot" });
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

        // ── Comando /reset: limpa histórico, confirma e NÃO aciona o agente ──
        if (isInbound && isResetCommand(messageContent)) {
          await resetConversationHistory(convId);

          try {
            const helena = await loadHelenaAccount(accountId);
            await sendHelenaText(helena, {
              phone: fromDetails || legacyPhone || undefined,
              text: RESET_CONFIRMATION_MESSAGE,
              sessionId,
            });
          } catch (e) {
            console.error("[webhook] /reset - falha ao enviar confirmação:", e);
          }

          return Response.json({ ok: true, conversation_id: convId, action: "reset" });
        }

        const role = isInbound ? "user" : "assistant";
        const meta: Record<string, unknown> = {
          origem,
          tipo: messageType,
          channel_from: fromDetails || null,
          ...(isHelenaNative
            ? {
                direction: c.direction,
                helena_msg_id: c.id,
                payload_shape: body.eventType ? "envelope" : "flat",
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
              scheduleConversationAgentTurn(convId, debounce);
            } else {
              scheduleConversationAgentTurn(convId, 0);
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
