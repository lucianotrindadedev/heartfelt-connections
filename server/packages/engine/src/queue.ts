// ---------------------------------------------------------------------------
// Inbound message processing worker - replicates n8n workflows 01-05.
//
// Flow: Helena webhook → BullMQ → this worker
//   1. Route by eventType (MESSAGE_RECEIVED vs MESSAGE_SENT)
//   2. For MESSAGE_SENT: handle IA toggle ("Olá!" / "OK")
//   3. For MESSAGE_RECEIVED: filter by tags → process message type → queue → debounce → agent → format → split → send
// ---------------------------------------------------------------------------

import { Worker, type Job, Queue } from "bullmq";
import {
  redis, env, logger, db,
  agents, conversations, messages, conversationState, agentRuns, integrations,
  callLlm, HelenaClient, EvolutionClient,
} from "@sarai/shared";
import type { LlmMessage } from "@sarai/shared";
import { eq, and, desc, sql, asc } from "drizzle-orm";
import { getToolDefinitions, executeTool } from "./tools";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ─── Types ──────────────────────────────────────────────────────────────────

interface InboundPayload {
  agentId: string;
  phone: string;
  eventType: string;       // MESSAGE_RECEIVED | MESSAGE_SENT
  messageId: string;
  sessionId: string;       // Helena session ID
  contactId: string;       // Helena contact ID
  companyId: string;
  text: string;
  timestamp: string;
  messageType: string;     // text | audio | image | pdf | other_file
  fileUrl: string;
  fileMimeType: string;
  receivedAt: number;
}

// ─── Helper: Get agent config with Redis cache (60s) ────────────────────────

async function getAgentConfig(agentId: string) {
  const cacheKey = `agent:config:${agentId}`;
  const cached = await redis.get(cacheKey);
  if (cached) return JSON.parse(cached);

  const [agent] = await db.select().from(agents).where(eq(agents.id, agentId)).limit(1);
  if (!agent) throw new Error(`Agent ${agentId} not found`);

  // Load & decrypt integrations
  const intRows = await db.select({ type: integrations.type, configEnc: integrations.configEnc })
    .from(integrations).where(eq(integrations.accountId, agent.accountId));

  const decryptedIntegrations: Record<string, any> = {};
  for (const row of intRows) {
    try {
      const [dec] = await db.execute(
        sql`SELECT pgp_sym_decrypt(${row.configEnc}::bytea, ${env.PGCRYPTO_KEY}) as config`
      );
      if (dec?.config) decryptedIntegrations[row.type] = JSON.parse(dec.config as string);
    } catch {}
  }

  const config = { ...agent, integrations: decryptedIntegrations };
  await redis.set(cacheKey, JSON.stringify(config), "EX", 60);
  return config;
}

// ─── Helper: Get or create conversation ─────────────────────────────────────

async function getOrCreateConversation(agentId: string, phone: string, sessionId?: string, contactId?: string) {
  const [existing] = await db.select().from(conversations)
    .where(and(eq(conversations.agentId, agentId), eq(conversations.phone, phone)))
    .limit(1);

  if (existing) {
    // Update helena IDs if we have them and they're missing
    if (sessionId && !existing.helenaSessionId) {
      await db.update(conversations).set({ helenaSessionId: sessionId, helenaContactId: contactId })
        .where(eq(conversations.id, existing.id));
    }
    return {
      ...existing,
      helenaSessionId: sessionId || existing.helenaSessionId,
      helenaContactId: contactId || existing.helenaContactId,
    };
  }

  const [created] = await db.insert(conversations).values({
    agentId, phone, status: "active",
    helenaSessionId: sessionId || null,
    helenaContactId: contactId || null,
  }).returning();

  await db.insert(conversationState).values({ conversationId: created.id });
  return created;
}

// ─── Helper: Get message history (last 50) ──────────────────────────────────

async function getMessageHistory(conversationId: string): Promise<LlmMessage[]> {
  const rows = await db.select().from(messages)
    .where(eq(messages.conversationId, conversationId))
    .orderBy(desc(messages.createdAt))
    .limit(50);

  return rows.reverse().map(r => ({
    role: r.role as LlmMessage["role"],
    content: r.content,
    ...(r.toolCalls ? { tool_calls: r.toolCalls as any } : {}),
    ...(r.role === "tool" && Array.isArray(r.toolCalls) && (r.toolCalls as any[]).length > 0
      ? { tool_call_id: (r.toolCalls as any)[0].id }
      : {}),
  }));
}

// ─── Helper: Transcribe audio via Groq Whisper ──────────────────────────────

async function transcribeAudio(fileUrl: string, groqApiKey: string): Promise<string> {
  // Download the audio file
  const audioRes = await fetch(fileUrl);
  if (!audioRes.ok) throw new Error(`Failed to download audio: ${audioRes.status}`);
  const audioBlob = await audioRes.blob();

  // Send to Groq Whisper
  const formData = new FormData();
  formData.append("file", audioBlob, "audio.ogg");
  formData.append("model", "whisper-large-v3-turbo");
  formData.append("temperature", "0");
  formData.append("response_format", "verbose_json");
  formData.append("language", "pt");

  const res = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${groqApiKey}` },
    body: formData,
  });

  if (!res.ok) throw new Error(`Groq Whisper error ${res.status}: ${await res.text()}`);
  const data = await res.json() as { text: string };
  return data.text || "";
}

// ─── Helper: Analyze image via GPT-4o-mini ──────────────────────────────────

async function analyzeImage(fileUrl: string, openaiApiKey: string): Promise<string> {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${openaiApiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Descreva detalhadamente o conteúdo desta imagem. Se contiver texto, transcreva-o. Se for um documento, extraia as informações principais." },
            { type: "image_url", image_url: { url: fileUrl } },
          ],
        },
      ],
      max_tokens: 1024,
    }),
  });

  if (!res.ok) throw new Error(`OpenAI Vision error ${res.status}: ${await res.text()}`);
  const data = await res.json() as any;
  return data.choices?.[0]?.message?.content || "[Imagem não reconhecida]";
}

// ─── Helper: Extract text from PDF ──────────────────────────────────────────

async function extractPdfText(fileUrl: string): Promise<string> {
  // Download PDF
  const pdfRes = await fetch(fileUrl);
  if (!pdfRes.ok) throw new Error(`Failed to download PDF: ${pdfRes.status}`);
  const buffer = await pdfRes.arrayBuffer();

  // Basic text extraction from PDF streams
  const bytes = new Uint8Array(buffer);
  const text = new TextDecoder("latin1").decode(bytes);

  const textParts: string[] = [];
  const streamRegex = /stream\s*\n([\s\S]*?)endstream/g;
  let match;
  while ((match = streamRegex.exec(text)) !== null) {
    const content = match[1];
    const tjRegex = /\(([^)]*)\)\s*Tj/g;
    let tjMatch;
    while ((tjMatch = tjRegex.exec(content)) !== null) {
      textParts.push(tjMatch[1]);
    }
  }

  if (textParts.length > 0) {
    return textParts.join(" ").trim();
  }

  // Fallback: extract readable characters
  const readableText = text.replace(/[^\x20-\x7E\xC0-\xFF\n]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  return readableText.slice(0, 5000) || `[Documento PDF recebido: ${fileUrl}]`;
}

// ─── Helper: Format text for WhatsApp ───────────────────────────────────────

async function formatForWhatsApp(text: string, apiKey: string, model: string): Promise<string> {
  try {
    const res = await callLlm({
      apiKey,
      model: model || "x-ai/grok-4.1-fast",
      messages: [
        {
          role: "system",
          content: "Você é especialista em formatação de mensagem para WhatsApp. Regras: Substitua ** por * (negrito WhatsApp). Remova # e ## (títulos markdown). Mantenha emojis, links e listas. Retorne APENAS o texto formatado, sem explicações.",
        },
        { role: "user", content: text },
      ],
      temperature: 0.1,
      maxTokens: 4096,
    });
    return res.content || text;
  } catch {
    // Fallback: simple regex formatting
    return text.replace(/\*\*/g, "*").replace(/^#{1,3}\s*/gm, "");
  }
}

// ─── Helper: Split message via LLM (workflow 02) ────────────────────────────

async function splitMessage(text: string, apiKey: string, model: string): Promise<string[]> {
  // Short messages don't need splitting
  if (text.length < 300) return [text];

  try {
    const res = await callLlm({
      apiKey,
      model: model || "x-ai/grok-4.1-fast",
      messages: [
        {
          role: "system",
          content: `Você é um agente divisor de mensagens para WhatsApp. Sua tarefa é dividir mensagens longas em blocos menores e naturais, como se fossem mensagens reais de WhatsApp.

Regras:
- Nunca altere o conteúdo, apenas divida em pontos naturais
- Não quebre listas no meio
- Máximo de 5 mensagens
- Mensagens curtas (< 2 frases) não precisam ser divididas
- Mantenha emojis, links e formatação intactos
- Retorne APENAS um JSON válido no formato: {"mensagens": ["msg1", "msg2", ...]}`,
        },
        { role: "user", content: text },
      ],
      temperature: 0.3,
      maxTokens: 4096,
    });

    // Parse JSON from response
    const jsonMatch = res.content.match(/\{[\s\S]*"mensagens"[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      if (Array.isArray(parsed.mensagens) && parsed.mensagens.length > 0) {
        return parsed.mensagens;
      }
    }
  } catch (e) {
    logger.warn({ err: (e as Error).message }, "message split failed, sending as single");
  }

  return [text];
}

// ─── Helper: Send messages with typing simulation (workflow 02) ─────────────

async function sendWithTypingDelay(helena: HelenaClient, sessionId: string, chunks: string[]) {
  const WORDS_PER_MINUTE = 230;

  for (const chunk of chunks) {
    const wordCount = chunk.length / 4.5;
    const typingDelayMs = Math.min((60 * wordCount / WORDS_PER_MINUTE) * 1000, 25000);

    await sleep(typingDelayMs);
    await helena.sendMessage(sessionId, chunk);
  }
}

// ─── Helper: Monitoring agent - detect scheduling events ────────────────────

async function runMonitoringAgent(
  agentConfig: any,
  conversation: any,
  agentOutput: string,
  helena: HelenaClient,
) {
  const apiKey = agentConfig.integrations?.openrouter?.api_key;
  if (!apiKey) return;

  try {
    const res = await callLlm({
      apiKey,
      model: env.MONITOR_MODEL || "x-ai/grok-4.1-fast",
      messages: [
        {
          role: "system",
          content: `Analise a resposta do assistente e detecte se houve um evento de AGENDAMENTO, REMARCAÇÃO ou CANCELAMENTO de consulta.
Se detectar, responda APENAS com JSON: {"evento": "AGENDAMENTO|REMARCACAO|CANCELAMENTO", "detalhes": "breve descrição"}
Se não detectar nenhum evento, responda apenas: SEM_NOTIFICACAO`,
        },
        { role: "user", content: agentOutput },
      ],
      temperature: 0.1,
      maxTokens: 256,
    });

    if (res.content.includes("SEM_NOTIFICACAO")) return;

    // Parse event
    const jsonMatch = res.content.match(/\{[\s\S]*"evento"[\s\S]*\}/);
    if (!jsonMatch) return;

    const event = JSON.parse(jsonMatch[0]);

    // Update tags: remove "N/A Não Agendado", add "IA Agendou"
    if (conversation.helenaContactId && event.evento === "AGENDAMENTO") {
      await helena.removeTags(conversation.helenaContactId, ["N/A Não Agendado"]).catch(() => {});
      await helena.addTags(conversation.helenaContactId, ["IA Agendou"]).catch(() => {});

      // Remove from sequences
      try {
        const seqs = await helena.getSequencesByContact(conversation.helenaContactId);
        for (const seq of seqs.items || []) {
          await helena.removeFromSequence(seq.id, conversation.helenaContactId, conversation.phone).catch(() => {});
        }
      } catch {}
    }

    // Send group alert via Evolution API (if configured)
    const evoConfig = agentConfig.integrations?.evolution_api;
    const alertGroup = evoConfig?.alert_group_jid || agentConfig.integrations?.helena_crm?.grupo_alerta;
    if (evoConfig && alertGroup) {
      const evo = new EvolutionClient({
        baseUrl: evoConfig.base_url,
        apiKey: evoConfig.api_key,
        instanceName: evoConfig.instance_name,
      });
      const msg = `🔔 *${event.evento}*\n*Telefone:* ${conversation.phone}\n*Detalhes:* ${event.detalhes}`;
      await evo.sendGroupAlert(alertGroup, msg).catch(() => {});
    }
  } catch (e) {
    logger.warn({ err: (e as Error).message }, "monitoring agent failed");
  }
}

// ─── Helper: Process MESSAGE_SENT (IA toggle) ──────────────────────────────

async function handleMessageSent(payload: InboundPayload, agentConfig: any) {
  // When the human agent sends "Olá!" → add "IA Desligada" tag (turn off AI)
  // When sends "OK" → remove "IA Desligada" tag (turn on AI)
  const helenaConfig = agentConfig.integrations?.helena_crm;
  if (!helenaConfig) return;

  const helena = new HelenaClient({ baseUrl: helenaConfig.base_url, token: helenaConfig.token });
  const text = payload.text.trim();

  if (text === "Olá!" && payload.contactId) {
    await helena.addTags(payload.contactId, ["IA Desligada"]).catch(() => {});
    logger.info({ phone: payload.phone }, "IA disabled by human agent");
  } else if (text === "OK" && payload.contactId) {
    await helena.removeTags(payload.contactId, ["IA Desligada"]).catch(() => {});
    logger.info({ phone: payload.phone }, "IA enabled by human agent");
  }
}

// ─── Helper: Check if should process (tag filtering) ────────────────────────

async function shouldProcess(contactId: string, helena: HelenaClient): Promise<boolean> {
  if (!contactId) return true;

  try {
    const contact = await helena.getContact(contactId);
    const tags: string[] = contact.tagNames || [];

    const blockTags = ["IA DESLIGADA", "FUNCIONÁRIO", "PACIENTE", "CRC AGENDOU", "LEAD DESQUALIFICADO"];
    for (const tag of blockTags) {
      if (tags.some((t: string) => t.toUpperCase() === tag)) {
        logger.debug({ contactId, tag }, "message blocked by tag");
        return false;
      }
    }
    return true;
  } catch {
    return true; // If we can't check, proceed
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// MAIN WORKER
// ═══════════════════════════════════════════════════════════════════════════

export const worker = new Worker(
  "inbound",
  async (job: Job) => {
    const payload = job.data as InboundPayload;
    const { agentId, phone, eventType } = payload;

    // Load agent config
    const agentConfig = await getAgentConfig(agentId);
    if (!agentConfig.enabled) {
      logger.debug({ agentId }, "agent disabled, skipping");
      return;
    }

    // ── Route by event type ──
    if (eventType === "MESSAGE_SENT") {
      await handleMessageSent(payload, agentConfig);
      return;
    }

    if (eventType !== "MESSAGE_RECEIVED") {
      logger.debug({ eventType }, "ignoring non-message event");
      return;
    }

    // ── MESSAGE_RECEIVED flow ──
    const helenaConfig = agentConfig.integrations?.helena_crm;
    if (!helenaConfig) throw new Error("Helena CRM not configured for this agent");
    const helena = new HelenaClient({ baseUrl: helenaConfig.base_url, token: helenaConfig.token });

    // Step 1: Check tags - should we process?
    if (!await shouldProcess(payload.contactId, helena)) return;

    // Step 2: Handle special commands
    if (payload.text === "/reset") {
      const conv = await getOrCreateConversation(agentId, phone, payload.sessionId, payload.contactId);
      // Clear message history
      await db.delete(messages).where(eq(messages.conversationId, conv.id));
      // Reset status
      await db.update(conversationState).set({
        lockConversa: false, aguardandoFollowup: false, numeroFollowup: 0, updatedAt: new Date(),
      }).where(eq(conversationState.conversationId, conv.id));
      await helena.sendMessage(payload.sessionId, "Memória resetada. Como posso te ajudar?");
      return;
    }

    if (payload.text === "/teste") {
      if (payload.contactId) await helena.addTags(payload.contactId, ["Testando"]).catch(() => {});
      await helena.sendMessage(payload.sessionId, "Modo de teste habilitado.");
      return;
    }

    if (payload.text?.toLowerCase() === "sair") {
      if (payload.contactId) {
        // Remove from all sequences
        try {
          const seqs = await helena.getSequencesByContact(payload.contactId);
          for (const seq of seqs.items || []) {
            await helena.removeFromSequence(seq.id, payload.contactId, phone).catch(() => {});
          }
        } catch {}
        await helena.addTags(payload.contactId, ["Lead Desqualificado"]).catch(() => {});
      }
      await helena.sendMessage(payload.sessionId, "Você foi removido(a) da nossa lista. Se quiser voltar, é só chamar!");
      return;
    }

    // Step 3: Convert message to text based on type
    let messageText = payload.text || "";

    if (payload.messageType === "audio" && payload.fileUrl) {
      const groqKey = agentConfig.integrations?.groq?.api_key || env.GROQ_API_KEY;
      if (groqKey) {
        try {
          messageText = await transcribeAudio(payload.fileUrl, groqKey);
        } catch (e) {
          logger.error({ err: (e as Error).message }, "audio transcription failed");
          messageText = "[Áudio recebido - transcrição falhou]";
        }
      } else {
        messageText = "[Áudio recebido - sem chave Groq configurada]";
      }
    } else if (payload.messageType === "image" && payload.fileUrl) {
      const openaiKey = env.OPENAI_API_KEY;
      if (openaiKey) {
        try {
          messageText = await analyzeImage(payload.fileUrl, openaiKey);
        } catch (e) {
          logger.error({ err: (e as Error).message }, "image analysis failed");
          messageText = `[Imagem recebida] ${payload.text || ""}`;
        }
      } else {
        messageText = `[Imagem recebida] ${payload.text || ""}`;
      }
    } else if (payload.messageType === "pdf" && payload.fileUrl) {
      try {
        messageText = await extractPdfText(payload.fileUrl);
      } catch {
        messageText = "[Documento PDF recebido]";
      }
    } else if (payload.messageType === "other_file") {
      messageText = `[Arquivo recebido: ${payload.fileMimeType || "desconhecido"}]`;
    }

    if (!messageText.trim()) return;

    // Step 4: Enqueue message (message batching like n8n_fila_mensagens)
    const queueKey = `msgqueue:${agentId}:${phone}`;
    const msgEntry = JSON.stringify({
      messageId: payload.messageId,
      text: messageText,
      timestamp: payload.timestamp,
    });
    await redis.rpush(queueKey, msgEntry);
    await redis.expire(queueKey, 120);

    // Step 5: Debounce wait (20 seconds)
    await sleep(env.WEBHOOK_DEBOUNCE_MS);

    // Step 6: Check if this is the latest message (deduplication)
    const queuedMsgs = await redis.lrange(queueKey, 0, -1);
    if (queuedMsgs.length === 0) return;

    const lastMsg = JSON.parse(queuedMsgs[queuedMsgs.length - 1]);
    if (lastMsg.messageId !== payload.messageId) {
      // Another, newer message will handle this batch
      logger.debug({ phone }, "skipping - newer message will handle batch");
      return;
    }

    // Step 7: Collect all queued messages
    const allMessages = queuedMsgs.map((m: string) => JSON.parse(m));
    const collectedText = allMessages.map((m: any) => m.text).join("\n");

    // Clear the queue
    await redis.del(queueKey);

    // Step 8: Lock conversation
    const conversation = await getOrCreateConversation(agentId, phone, payload.sessionId, payload.contactId);
    const lockKey = `lock:${agentId}:${phone}`;

    // Poll for lock (like n8n's "Agente já terminou?" loop, max 5 retries)
    let lockAcquired = false;
    for (let attempt = 0; attempt < 6; attempt++) {
      // Check conversation state
      const [state] = await db.select().from(conversationState)
        .where(eq(conversationState.conversationId, conversation.id));

      if (!state || !state.lockConversa || attempt >= 5) {
        // Acquire lock
        const acquired = await redis.set(lockKey, "1", "EX", 120, "NX");
        if (acquired || attempt >= 5) {
          lockAcquired = true;
          break;
        }
      }
      await sleep(5000); // Wait 5s before retry
    }

    if (!lockAcquired) {
      logger.warn({ phone }, "could not acquire lock after retries");
      return;
    }

    // Set lock in DB
    await db.update(conversationState).set({
      lockConversa: true,
      numeroFollowup: 0,
      aguardandoFollowup: true,
      lastUserMessageAt: new Date(),
      updatedAt: new Date(),
    }).where(eq(conversationState.conversationId, conversation.id));

    const startMs = Date.now();
    let totalTokensIn = 0;
    let totalTokensOut = 0;
    let allToolsCalled: string[] = [];

    try {
      // Step 9: Store user message
      await db.insert(messages).values({
        conversationId: conversation.id,
        role: "user",
        content: collectedText,
      });

      // Step 10: Get contact info for context
      let contactInfo: any = {};
      try {
        if (payload.contactId) {
          contactInfo = await helena.getContact(payload.contactId);
        }
      } catch {}

      // Ensure contact has tags (add "N/A Não agendado" if no tags)
      if (payload.contactId && (!contactInfo.tagNames || contactInfo.tagNames.length === 0)) {
        await helena.addTags(payload.contactId, ["N/A Não agendado"]).catch(() => {});
      }

      // Step 11: Build system prompt with date context
      const now = new Date();
      const br = new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo", dateStyle: "full", timeStyle: "short" });
      const yesterday = new Date(now.getTime() - 86400000);
      const tomorrow = new Date(now.getTime() + 86400000);
      const dateContext = `<informacoes-sistema>\nOntem foi ${yesterday.toLocaleDateString("pt-BR", { dateStyle: "full" })}\nHoje é ${br.format(now)}\nAmanhã é ${tomorrow.toLocaleDateString("pt-BR", { dateStyle: "full" })}\n</informacoes-sistema>`;

      // Build tool instructions
      const toolInstructions = agentConfig.integrations?.helena_crm?.tool_instructions || "";

      const systemPrompt = `${dateContext}\n---\n${agentConfig.systemPrompt}\n---\n${toolInstructions}`;

      const systemMsg: LlmMessage = { role: "system", content: systemPrompt };
      const history = await getMessageHistory(conversation.id);
      const llmMessages: LlmMessage[] = [systemMsg, ...history];

      // Step 12: Get tool definitions and OpenRouter key
      const toolDefs = agentConfig.tools?.length
        ? getToolDefinitions(agentConfig.tools as string[])
        : undefined;

      const apiKey = agentConfig.integrations?.openrouter?.api_key;
      if (!apiKey) throw new Error("OpenRouter API key not configured");

      // Step 13: Call LLM
      let response = await callLlm({
        apiKey,
        model: agentConfig.llmModel || env.OPENROUTER_DEFAULT_MODEL,
        messages: llmMessages,
        tools: toolDefs,
        temperature: 0.9,
        maxTokens: 4096,
      });
      totalTokensIn += response.tokensIn;
      totalTokensOut += response.tokensOut;

      // Step 14: Tool loop
      let iterations = 0;
      const MAX_ITERATIONS = 10;

      while (response.toolCalls.length > 0 && iterations < MAX_ITERATIONS) {
        iterations++;

        // Store assistant message with tool calls
        await db.insert(messages).values({
          conversationId: conversation.id,
          role: "assistant",
          content: response.content || "",
          toolCalls: response.toolCalls as any,
        });

        llmMessages.push({
          role: "assistant",
          content: response.content || "",
          tool_calls: response.toolCalls,
        });

        // Execute each tool
        for (const tc of response.toolCalls) {
          allToolsCalled.push(tc.function.name);
          const toolResult = await executeTool(tc.function.name, JSON.parse(tc.function.arguments), {
            agentConfig,
            conversation,
            phone,
            helena,
            contactInfo,
          });

          const resultStr = JSON.stringify(toolResult);

          // Store tool result
          await db.insert(messages).values({
            conversationId: conversation.id,
            role: "tool",
            content: resultStr,
            toolCalls: [{ id: tc.id }] as any,
          });

          llmMessages.push({
            role: "tool",
            content: resultStr,
            tool_call_id: tc.id,
          });
        }

        // Call LLM again with tool results
        response = await callLlm({
          apiKey,
          model: agentConfig.llmModel || env.OPENROUTER_DEFAULT_MODEL,
          messages: llmMessages,
          tools: toolDefs,
          temperature: 0.9,
          maxTokens: 4096,
        });
        totalTokensIn += response.tokensIn;
        totalTokensOut += response.tokensOut;
      }

      // Step 15: Validate output
      const output = response.content;
      if (!output || output === "Agent stopped due to max iterations.") {
        throw new Error("Agent produced no valid output");
      }

      // Step 16: Format for WhatsApp
      const formatted = await formatForWhatsApp(output, apiKey, env.FORMATTER_MODEL);

      // Step 17: Store final assistant message
      await db.insert(messages).values({
        conversationId: conversation.id,
        role: "assistant",
        content: formatted,
      });

      // Step 18: Split and send via Helena
      const chunks = await splitMessage(formatted, apiKey, env.SPLITTER_MODEL);
      await sendWithTypingDelay(helena, payload.sessionId, chunks);

      // Step 19: Run monitoring agent (async, don't block)
      runMonitoringAgent(agentConfig, conversation, formatted, helena).catch(e =>
        logger.warn({ err: (e as Error).message }, "monitoring agent error")
      );

      // Step 20: Log successful run
      const latencyMs = Date.now() - startMs;
      const costUsd = ((totalTokensIn * 0.000003) + (totalTokensOut * 0.000015)).toFixed(6);

      await db.insert(agentRuns).values({
        agentId,
        conversationId: conversation.id,
        phone,
        status: "ok",
        latencyMs,
        tokensIn: totalTokensIn,
        tokensOut: totalTokensOut,
        costUsd,
        toolsCalled: allToolsCalled,
      });

      logger.info(
        {
          agentId,
          phone,
          tokens: totalTokensIn + totalTokensOut,
          tools: allToolsCalled.length,
          latencyMs,
        },
        "processed inbound message",
      );

    } catch (error) {
      const err = error as Error;
      logger.error({ agentId, phone, err: err.message }, "agent processing failed");

      await db.insert(agentRuns).values({
        agentId,
        conversationId: conversation.id,
        phone,
        status: "error",
        latencyMs: Date.now() - startMs,
        tokensIn: totalTokensIn,
        tokensOut: totalTokensOut,
        costUsd: "0",
        toolsCalled: allToolsCalled,
        error: err.message,
      });

      throw error; // Let BullMQ retry
    } finally {
      // Unlock conversation
      await db.update(conversationState).set({
        lockConversa: false,
        updatedAt: new Date(),
      }).where(eq(conversationState.conversationId, conversation.id));
      await redis.del(lockKey);
    }
  },
  { connection: redis, concurrency: 10 },
);

worker.on("failed", (job, err) => {
  logger.error({ jobId: job?.id, err: err.message }, "inbound job failed");
});
