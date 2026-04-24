import { Hono } from "hono";
import { Queue } from "bullmq";
import { redis, logger, db, agents } from "@sarai/shared";
import { eq } from "drizzle-orm";

export const inboundQueue = new Queue("inbound", { connection: redis });

export const webhookRoute = new Hono();

// Cache webhook secrets in Redis for 5 min
async function validateSecret(agentId: string, secret: string): Promise<boolean> {
  const cacheKey = `webhook:secret:${agentId}`;
  let stored = await redis.get(cacheKey);
  if (!stored) {
    const [agent] = await db.select({ webhookSecret: agents.webhookSecret })
      .from(agents).where(eq(agents.id, agentId)).limit(1);
    if (!agent) return false;
    stored = agent.webhookSecret;
    await redis.set(cacheKey, stored!, "EX", 300);
  }
  return stored === secret;
}

/**
 * Helena CRM webhook - receives MESSAGE_RECEIVED and MESSAGE_SENT events.
 * 
 * Helena payload format:
 * {
 *   eventType: "MESSAGE_RECEIVED" | "MESSAGE_SENT",
 *   content: {
 *     id: string,           // message ID
 *     companyId: string,     // account ID
 *     sessionId: string,     // conversation session ID
 *     contactId: string,     // Helena contact ID
 *     text: string,          // message text
 *     timestamp: string,     // ISO timestamp
 *     details: {
 *       from: string,        // phone number
 *       file?: {
 *         mimeType: string,
 *         url?: string,
 *         publicUrl?: string,
 *       }
 *     }
 *   }
 * }
 */
webhookRoute.post("/:agentId", async (c) => {
  const agentId = c.req.param("agentId");
  const secret = c.req.header("x-webhook-secret");
  
  if (!secret) return c.json({ error: "missing secret" }, 401);
  const valid = await validateSecret(agentId, secret);
  if (!valid) return c.json({ error: "invalid secret" }, 401);

  const body = await c.req.json().catch(() => ({}));
  const eventType: string = body.eventType || "";
  const content = body.content || {};
  const details = content.details || {};
  const phone: string = details.from || "";
  
  if (!phone) return c.json({ error: "missing phone" }, 400);
  
  // Determine message type
  const file = details.file || null;
  let messageType = "text";
  if (file?.mimeType?.startsWith("audio/")) messageType = "audio";
  else if (file?.mimeType?.startsWith("image/")) messageType = "image";
  else if (file?.mimeType?.startsWith("application/")) messageType = "pdf";
  else if (file) messageType = "other_file";

  await inboundQueue.add(
    "inbound",
    {
      agentId,
      phone,
      eventType,
      messageId: content.id || "",
      sessionId: content.sessionId || "",
      contactId: content.contactId || "",
      companyId: content.companyId || "",
      text: content.text || "",
      timestamp: content.timestamp || new Date().toISOString(),
      messageType,
      fileUrl: file?.publicUrl || file?.url || "",
      fileMimeType: file?.mimeType || "",
      receivedAt: Date.now(),
    },
    {
      removeOnComplete: 1000,
      removeOnFail: 5000,
      attempts: 3,
      backoff: { type: "exponential", delay: 5000 },
    },
  );
  
  logger.debug({ agentId, phone, eventType, messageType }, "enqueued helena event");
  return c.json({ ok: true });
});

// Clinicorp appointment status change webhook (workflow 08 - faltosos)
webhookRoute.post("/clinicorp/:agentId", async (c) => {
  const agentId = c.req.param("agentId");
  const body = await c.req.json().catch(() => ({}));
  
  await inboundQueue.add(
    "clinicorp-event",
    {
      agentId,
      statusId: body.Payload?.StatusId || "",
      professionalId: body.Payload?.Dentist_PersonId || "",
      patientId: body.Payload?.Patient_PersonId || "",
      appointmentId: body.Payload?.Id || "",
      payload: body,
      receivedAt: Date.now(),
    },
    { removeOnComplete: 500, removeOnFail: 2000, attempts: 2 },
  );
  
  logger.debug({ agentId }, "enqueued clinicorp event");
  return c.json({ ok: true });
});

// Helena tag change webhook (workflow 08 - FUF financeiro)
webhookRoute.post("/helena-tags/:agentId", async (c) => {
  const agentId = c.req.param("agentId");
  const body = await c.req.json().catch(() => ({}));
  const content = body.content || {};
  
  await inboundQueue.add(
    "helena-tag-event",
    {
      agentId,
      contactId: content.id || "",
      phone: content.phonenumber || "",
      tagNames: content.tagNames || [],
      payload: body,
      receivedAt: Date.now(),
    },
    { removeOnComplete: 500, removeOnFail: 2000, attempts: 2 },
  );
  
  logger.debug({ agentId }, "enqueued helena tag event");
  return c.json({ ok: true });
});
