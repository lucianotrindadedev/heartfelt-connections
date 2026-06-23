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
import { dispatchInboundAgentTurn } from "@/lib/schedule-agent-turn.server";
import { checkContactBlockedBySession } from "@/lib/agent-block.server";
import { messageMatchesAgentCommand } from "@/lib/agent-commands.server";
import { getGroqApiKey, transcribeAudioFromUrl } from "@/lib/groq.server";
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
  resolveHelenaContactId,
  sendHelenaText,
  setHelenaContactTags,
  type HelenaContact,
} from "@/lib/helena.server";

const AI_DISABLED_TAG = "IA Desligada";

/** Normaliza tag para comparação: sem acento, sem espaços nas pontas, maiúsculo. */
function normalizeTag(s: string): string {
  return (s ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .trim()
    .toUpperCase();
}

/** Tags que pausam a IA: a fixa "IA Desligada" (escalada humana) + as
 *  configuradas pelo dono em settings.blocked_tags (vírgula/; /quebra de linha). */
function parseBlockedTags(raw: string | undefined): string[] {
  const tags = [AI_DISABLED_TAG];
  if (raw?.trim()) {
    for (const t of raw.split(/[,;\n]/)) {
      const v = t.trim();
      if (v) tags.push(v);
    }
  }
  return tags;
}

/** Retorna a tag bloqueadora que o contato possui (nome real), ou null. */
function findBlockingTag(tagNames: string[], blockedTags: string[]): string | null {
  const blockedSet = new Set(blockedTags.map(normalizeTag));
  for (const t of tagNames) {
    if (blockedSet.has(normalizeTag(t))) return t;
  }
  return null;
}

interface HelenaFile {
  mimeType?: string | null;
  type?: string | null;
  publicUrl?: string | null;
  url?: string | null;
  name?: string | null;
}
interface HelenaDetails {
  to?: string | null;
  from?: string | null;
  file?: HelenaFile | null;
  transcription?: string | null;
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

/** Origens das mensagens que ESTA plataforma gera e envia (não são do lead nem
 *  de atendente humano). Usadas para detectar o eco/loopback. */
const OWN_OUTBOUND_ORIGINS = new Set(["agente", "followup", "warmup", "warm-up"]);

function normalizeEcho(s: string | null | undefined): string {
  return (s ?? "").toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * Anti-eco/loopback: a Helena reentrega como evento (TO_HUB, e às vezes até
 * FROM_HUB) as mensagens que a própria plataforma enviou — resposta do agente,
 * follow-up, warm-up. Esses ecos chegam com `userId` (parecendo atendente
 * humano), eram gravados como mensagem do histórico e poluíam o contexto do LLM
 * — inclusive CRUZANDO leads quando uma saudação em massa caía na sessão errada
 * (agente chamava o lead pelo nome de outra pessoa).
 *
 * Detecção sem depender de campos internos da Helena: o eco é sempre uma cópia
 * de algo que NÓS enviamos há pouco. Comparamos o texto recebido com as
 * mensagens que esta plataforma gerou nos últimos minutos (qualquer conversa da
 * conta — pega eco cruzado). Mensagem real de atendente humano é texto livre,
 * diferente das nossas, e passa normalmente.
 *
 * O envio em bolhas faz a mensagem gravada (reply completo, multi-bolha) ser
 * diferente do eco (uma bolha só) — por isso comparamos por containment nos
 * dois sentidos.
 */
async function isOwnRecentOutboundEcho(
  sb: ReturnType<typeof getSelfhost>,
  accountId: string,
  content: string,
): Promise<boolean> {
  const target = normalizeEcho(content);
  if (target.length < 25) return false; // curto demais: risco de falso positivo com msg real

  const since = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  // Escopo por conta: messages → conversations(agent_id) → agents(account_id).
  const { data, error } = await sb
    .from("messages")
    .select("content, meta, conversations!inner(agents!inner(account_id))")
    .eq("role", "assistant")
    .eq("conversations.agents.account_id", accountId)
    .gte("criado_em", since)
    .order("criado_em", { ascending: false })
    .limit(300);
  if (error || !data) return false;

  for (const m of data as Array<{ content: string | null; meta: Record<string, unknown> | null }>) {
    const origem = (m.meta?.origem as string | undefined) ?? "";
    if (!OWN_OUTBOUND_ORIGINS.has(origem)) continue; // ignora ecos já gravados (origem "humano") e msgs do lead
    const stored = normalizeEcho(m.content);
    if (!stored) continue;
    if (stored === target || stored.includes(target) || target.includes(stored)) {
      return true;
    }
  }
  return false;
}

interface ConversationUpsertInput {
  agentId: string;
  sessionId?: string;
  fromDetails?: string;
  legacyPhone?: string;
  /** Telefone real do lead no WhatsApp (FROM_HUB) — prioridade sobre CRM. */
  inboundLeadPhone?: string | null;
}

interface ConversationUpsertResult {
  convId: string | null;
  contact: HelenaContact | null;
}

async function upsertConversation(
  accountId: string,
  input: ConversationUpsertInput,
): Promise<ConversationUpsertResult> {
  const sb = getSelfhost();
  let channel: ConversationChannel = "unknown";
  let contactId: string | null = null;
  let instagram: string | null = null;
  let messengerId: string | null = null;
  let contactPhone: string | null = null;
  let leadPhone: string | null = null;
  let sessionChannelId: string | null = null;
  let resolvedContact: HelenaContact | null = null;

  if (input.sessionId) {
    try {
      const helena = await loadHelenaAccount(accountId);
      const contact = await loadHelenaContactFromSession(helena, input.sessionId);
      const session = await loadHelenaSession(helena, input.sessionId);
      sessionChannelId = session?.channelId ?? null;
      if (contact) {
        resolvedContact = contact;
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
      const inboundWa = normalizeBrazilPhone(input.inboundLeadPhone);
      if (inboundWa) {
        updates.lead_phone = inboundWa;
      } else {
        const existingLead = normalizeBrazilPhone(bySession.data.lead_phone as string | null);
        if (!existingLead && contactPhone) updates.lead_phone = contactPhone;
      }

      await sb.from("conversations").update(updates).eq("id", convId);
      return { convId, contact: resolvedContact };
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
    return { convId, contact: resolvedContact };
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
    return { convId: null, contact: resolvedContact };
  }
  return { convId: ins.data.id as string, contact: resolvedContact };
}

export const Route = createFileRoute("/api/public/webhook/helena/$accountId")({
  server: {
    handlers: {
      POST: async ({ request, params }) => {
        const accountId = params.accountId;
        const sb = getSelfhost();

        // Busca o helena_account_id da conta — usado para validar companyId
        // (a Helena CRM envia o UUID dela, que pode ser diferente do
        // accounts.id interno quando há múltiplos agentes Sarai por CRM).
        const accountRow = await sb
          .from("accounts")
          .select("helena_account_id")
          .eq("id", accountId)
          .maybeSingle();
        if (!accountRow.data) {
          return new Response("Account not found", { status: 404 });
        }
        const helenaAccountId =
          (accountRow.data.helena_account_id as string | null) ?? accountId;

        const agentRow = await sb
          .from("agents")
          .select("id, ativo, webhook_secret, debounce_segundos, settings")
          .eq("account_id", accountId)
          .maybeSingle();
        if (!agentRow.data) {
          return new Response("Account not found", { status: 404 });
        }

        // Comandos livres em settings.pause_command / resume_command (qualquer texto; vários separados por vírgula).
        const agentSettings = (agentRow.data.settings as Record<string, string> | null) ?? {};
        const pauseCommandRaw = agentSettings.pause_command;
        const resumeCommandRaw = agentSettings.resume_command;

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
          // companyId vem da Helena → comparar com helena_account_id, não com
          // o accounts.id interno (que pode ter sufixo -2, -3 etc).
          if (
            payloadCompanyId &&
            payloadCompanyId !== helenaAccountId &&
            payloadCompanyId !== accountId
          ) {
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
        let messageContent = (c.text ?? "").toString();
        const messageType = c.type ?? "TEXT";

        // Eventos TRACK (rastreamento/status da Helena: entrega, "contato enviou
        // mensagem", saudação automática) NÃO são mensagens de chat — chegam com
        // content vazio e, sendo TO_HUB+userId, eram gravados como assistant/humano,
        // virando a ÚLTIMA mensagem da conversa e SUPRIMINDO a resposta do agente
        // (conversationNeedsAgentReply via última msg = assistant → não responde).
        // Causava leads sem resposta (ex.: mensagens à noite que só eram atendidas
        // quando chegava outro evento real horas depois). Ignorar por completo.
        if (messageType.toUpperCase() === "TRACK") {
          return Response.json({ ok: true, skipped: "track-event" });
        }

        // ── Áudio: detecta arquivo de áudio no payload e transcreve via Groq ──
        // Helena entrega o anexo em content.details.file { mimeType, publicUrl }.
        const helenaFile = c.details?.file ?? null;
        const fileMime = (helenaFile?.mimeType ?? helenaFile?.type ?? "").toString();
        const isAudioMessage =
          fileMime.startsWith("audio/") ||
          messageType.toUpperCase() === "AUDIO" ||
          messageType.toUpperCase() === "VOICE";
        const audioUrl: string | null =
          body.audio_url ?? helenaFile?.publicUrl ?? helenaFile?.url ?? null;
        let audioTranscription: string | null = null;

        if (isAudioMessage && audioUrl && !messageContent.trim()) {
          // Helena às vezes já manda a transcrição pronta — usa de graça.
          const prebuilt = (c.details?.transcription ?? "").toString().trim();
          if (prebuilt) {
            audioTranscription = prebuilt;
            messageContent = prebuilt;
            console.log(`[webhook] áudio: usando transcrição da Helena (${prebuilt.length} chars)`);
          } else {
            const groqKey = await getGroqApiKey(accountId);
            if (groqKey) {
              const tr = await transcribeAudioFromUrl(audioUrl, groqKey, { language: "pt" });
              if (tr.ok && tr.text) {
                audioTranscription = tr.text;
                messageContent = tr.text;
                console.log(`[webhook] áudio transcrito via Groq (${tr.text.length} chars)`);
              } else {
                console.error(`[webhook] transcrição falhou: ${tr.error}`);
                // Fallback: avisa o LLM que veio áudio mas não deu pra transcrever
                messageContent = "[O lead enviou um áudio que não pôde ser transcrito. Peça gentilmente para reenviar como texto.]";
              }
            } else {
              console.warn("[webhook] áudio recebido mas GROQ_API_KEY não configurada");
              messageContent = "[O lead enviou um áudio, mas a transcrição não está configurada. Peça para reenviar como texto.]";
            }
          }
        }

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

        // Anti-eco/loopback: descarta a reentrega das mensagens que ESTA
        // plataforma enviou (chegam como "humano" por carregarem userId, e até
        // como "lead" em alguns casos). Roda para QUALQUER classificação porque a
        // Helena ecoa nossos envios ora como TO_HUB, ora como FROM_HUB. Mensagem
        // real de atendente humano é texto livre e não casa com nossos envios.
        if (await isOwnRecentOutboundEcho(sb, accountId, messageContent)) {
          console.log(
            `[webhook] eco da própria plataforma descartado (conv-key=${fromDetails || legacyPhone || sessionId}) — não gravado`,
          );
          return Response.json({ ok: true, skipped: "self-echo" });
        }

        const inboundLeadPhone = isInbound
          ? normalizeBrazilPhone(fromDetails || legacyPhone)
          : null;

        const { convId, contact: resolvedContact } = await upsertConversation(accountId, {
          agentId: agentRow.data.id as string,
          sessionId,
          fromDetails: fromDetails || legacyPhone,
          legacyPhone,
          inboundLeadPhone,
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

        // ── Comandos de pausar/reativar a IA (configuráveis por agente) ──
        // Adiciona ou remove a tag "IA Desligada" no contato Helena.
        const isPauseCmd =
          isInbound &&
          messageMatchesAgentCommand(messageContent, pauseCommandRaw, ["/pausar"]);
        const isResumeCmd =
          isInbound &&
          messageMatchesAgentCommand(messageContent, resumeCommandRaw, ["/ativar"]);

        if (isPauseCmd || isResumeCmd) {
          console.log(
            `[webhook] comando ${isPauseCmd ? "pausar" : "ativar"} recebido para ${convId} (pause="${pauseCommandRaw ?? ""}" resume="${resumeCommandRaw ?? ""}")`,
          );

          let tagApplied = false;
          try {
            const helena = await loadHelenaAccount(accountId);
            const contactId = await resolveHelenaContactId(helena, {
              sessionId,
              contact: resolvedContact,
              phone: fromDetails || legacyPhone || resolvedContact?.phoneNumber,
            });

            if (contactId) {
              await sb
                .from("conversations")
                .update({
                  helena_contact_id: contactId,
                  atualizado_em: new Date().toISOString(),
                })
                .eq("id", convId);

              const tagResult = await setHelenaContactTags(
                helena,
                contactId,
                [AI_DISABLED_TAG],
                isPauseCmd ? "InsertIfNotExists" : "DeleteIfExists",
              );
              tagApplied = tagResult.ok;
              if (!tagResult.ok) {
                console.error(
                  `[webhook] tag op falhou: ${tagResult.status} ${tagResult.body.slice(0, 300)}`,
                );
              } else {
                console.log(
                  `[webhook] tag "${AI_DISABLED_TAG}" ${isPauseCmd ? "adicionada" : "removida"} — contact ${contactId}`,
                );
              }
            } else {
              console.warn("[webhook] sem contactId — não foi possível alterar tag Helena");
            }

            // Pausa com sucesso = silenciosa (só aplica tag). Avisa só em erro ou ao reativar.
            const shouldNotifyUser = isResumeCmd || !contactId || !tagApplied;
            if (shouldNotifyUser) {
              const confirmText = !contactId
                ? "Não consegui localizar seu cadastro no CRM para pausar a IA. Peça ao atendente humano aplicar a etiqueta IA Desligada."
                : !tagApplied
                  ? "Recebi o comando, mas não consegui atualizar a etiqueta no CRM. Tente novamente ou peça ajuda ao atendente."
                  : "Atendimento reativado ✅ A IA voltará a responder normalmente.";

              await sendHelenaText(helena, {
                phone: fromDetails || legacyPhone || undefined,
                text: confirmText,
                sessionId,
              });
            }
          } catch (e) {
            console.error("[webhook] pause/resume - falha:", e);
          }

          // Em caso de pause, limpa qualquer turn pendente
          if (isPauseCmd) {
            const { clearConversationQueue } = await import("@/lib/message-queue.server");
            await clearConversationQueue(convId);
          }

          return Response.json({
            ok: true,
            conversation_id: convId,
            action: isPauseCmd ? "pause" : "resume",
            tag_applied: tagApplied,
          });
        }

        // ── Modo teste ──
        const testMode = agentSettings.test_mode === "true";
        const testTag = agentSettings.test_tag?.trim() || "Testando";

        // ── Comandos #teste / #sair (auto opt-in/out do modo teste) ──
        // No modo teste, contatos SEM a etiqueta são ignorados — exceto estes comandos.
        // #teste APLICA a etiqueta de teste no próprio contato (entra no modo teste);
        // #sair REMOVE a etiqueta (sai do modo teste). Sem mexer no CRM. Só funcionam
        // com o modo teste ligado; configuráveis via settings.test_enable_command /
        // settings.test_disable_command (defaults "#teste" / "#sair").
        const isTestEnableCmd =
          isInbound &&
          testMode &&
          messageMatchesAgentCommand(messageContent, agentSettings.test_enable_command, ["#teste"]);
        const isTestDisableCmd =
          isInbound &&
          testMode &&
          messageMatchesAgentCommand(messageContent, agentSettings.test_disable_command, ["#sair"]);

        if (isTestEnableCmd || isTestDisableCmd) {
          const enabling = isTestEnableCmd; // se ambos casarem, prioriza entrar
          const cmdLabel = enabling ? "#teste" : "#sair";
          console.log(`[webhook] comando ${cmdLabel} recebido — conv ${convId}`);
          let tagApplied = false;
          try {
            const helena = await loadHelenaAccount(accountId);
            const contactId = await resolveHelenaContactId(helena, {
              sessionId,
              contact: resolvedContact,
              phone: fromDetails || legacyPhone || resolvedContact?.phoneNumber,
            });
            if (contactId) {
              await sb
                .from("conversations")
                .update({ helena_contact_id: contactId, atualizado_em: new Date().toISOString() })
                .eq("id", convId);
              const tagRes = await setHelenaContactTags(
                helena,
                contactId,
                [testTag],
                enabling ? "InsertIfNotExists" : "DeleteIfExists",
              );
              tagApplied = tagRes.ok;
              if (!tagRes.ok) {
                console.error(
                  `[webhook] ${cmdLabel} tag falhou: ${tagRes.status} ${tagRes.body.slice(0, 200)}`,
                );
              } else {
                console.log(
                  `[webhook] ${cmdLabel} — etiqueta "${testTag}" ${enabling ? "aplicada" : "removida"} no contato ${contactId}`,
                );
              }
            } else {
              console.warn(`[webhook] ${cmdLabel} sem contactId — etiqueta não alterada`);
            }
            const okText = enabling
              ? `✅ Modo teste ativado para este contato. Pode conversar normalmente que eu já respondo.`
              : `✅ Você saiu do modo teste. Enquanto o modo teste estiver ligado, não vou mais responder este contato (envie ${agentSettings.test_enable_command?.trim() || "#teste"} para voltar).`;
            const failText = enabling
              ? `Recebi o ${cmdLabel}, mas não consegui aplicar a etiqueta "${testTag}" no CRM. Aplique a etiqueta manualmente para testar.`
              : `Recebi o ${cmdLabel}, mas não consegui remover a etiqueta "${testTag}" no CRM. Remova a etiqueta manualmente.`;
            await sendHelenaText(helena, {
              phone: fromDetails || legacyPhone || undefined,
              text: tagApplied ? okText : failText,
              sessionId,
            });
          } catch (e) {
            console.error(`[webhook] ${cmdLabel} - falha:`, e);
          }
          return Response.json({
            ok: true,
            conversation_id: convId,
            action: enabling ? "test_enable" : "test_disable",
            tag_applied: tagApplied,
          });
        }

        // ── Bloqueio por tag: ignora completamente o agente ──
        // Fixa "IA Desligada" (escalada humana) + etiquetas configuradas pelo
        // dono (settings.blocked_tags). Reutiliza o contato já carregado.
        const blockedTags = parseBlockedTags(agentSettings.blocked_tags);
        let blockingTag =
          isInbound && resolvedContact
            ? findBlockingTag(resolvedContact.tagNames, blockedTags)
            : null;
        // Fail-safe: numa msg de entrada, se o contato NÃO carregou do CRM, não
        // dá pra saber se a IA está pausada ("IA Desligada"). Antes a IA
        // respondia mesmo assim (furava o bloqueio). Tenta resolver de novo via
        // sessão; se ainda não der, NÃO respondemos (na dúvida, silêncio).
        let contactTagsKnown = !isInbound || !!resolvedContact;
        if (isInbound && !resolvedContact && sessionId) {
          const recheck = await checkContactBlockedBySession({
            accountId,
            sessionId,
            blockedTagsRaw: agentSettings.blocked_tags,
          });
          contactTagsKnown = recheck.resolved;
          if (recheck.resolved && recheck.blocked) blockingTag = recheck.tag;
        }
        const agentBlockedByTag = !!blockingTag;
        const blockUnverifiable = isInbound && !contactTagsKnown && !!sessionId;
        if (agentBlockedByTag) {
          console.log(`[webhook] agente bloqueado pela tag "${blockingTag}" — conv ${convId}`);
        } else if (blockUnverifiable) {
          console.warn(
            `[webhook] contato não carregou do CRM — NÃO vou responder (fail-safe "IA Desligada") conv ${convId}`,
          );
        }

        // Gate do modo teste: quando ligado, o agente SÓ responde contatos que
        // têm a etiqueta de teste (default "Testando"). Mensagens comuns de
        // contatos sem a etiqueta são ignoradas — só o comando #teste (acima)
        // funciona sem ela, justamente para o contato se auto-habilitar.
        const hasTestTag =
          isInbound && resolvedContact
            ? resolvedContact.tagNames.some(
                (t) => normalizeTag(t) === normalizeTag(testTag),
              )
            : false;
        const blockedByTestMode = testMode && !hasTestTag;
        if (blockedByTestMode) {
          console.log(
            `[webhook] MODO TESTE ativo — contato sem etiqueta "${testTag}", agente não responde (conv ${convId}).`,
          );
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
          ...(audioTranscription
            ? { audio_transcrito: true, transcription: audioTranscription }
            : {}),
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

        if (
          isInbound &&
          agentRow.data.ativo &&
          !agentBlockedByTag &&
          !blockedByTestMode &&
          !blockUnverifiable
        ) {
          // Modo teste zera o delay (debounce) para iterar rápido nos testes.
          const debounce = testMode ? 0 : (agentRow.data.debounce_segundos as number | null) ?? 20;
          console.log(
            `[webhook] agendando agent turn para ${convId} — debounce=${debounce}s${testMode ? " (modo teste)" : ""}`,
          );
          try {
            // Um único disparo: waitUntil (Vercel) OU fila pg_cron — nunca os dois.
            await dispatchInboundAgentTurn(convId, debounce);
          } catch (e) {
            console.error("[agent-turn] falhou:", e);
          }
        } else if (isInbound) {
          console.log(
            `[webhook] agente NÃO disparado — ativo=${agentRow.data.ativo}, bloqueado=${agentBlockedByTag}, modo_teste_sem_etiqueta=${blockedByTestMode}, contato_nao_verificavel=${blockUnverifiable}`,
          );
        }

        return Response.json({ ok: true, conversation_id: convId, role });
      },
    },
  },
});
