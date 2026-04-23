import { Hono } from "hono";
import { Queue } from "bullmq";
import { redis, logger } from "@sarai/shared";

export const inboundQueue = new Queue("inbound", { connection: redis });

export const webhookRoute = new Hono();

/**
 * Helena posta mensagens aqui. Header `x-webhook-secret` valida origem.
 * O secret é o `agents.webhook_secret` do agente alvo.
 */
webhookRoute.post("/:agentId", async (c) => {
  const agentId = c.req.param("agentId");
  const secret = c.req.header("x-webhook-secret");
  // TODO: validar secret contra agents.webhook_secret no Postgres (com cache)
  if (!secret) return c.json({ error: "missing secret" }, 401);

  const payload = await c.req.json().catch(() => ({}));
  const phone: string | undefined = payload.phone ?? payload.from;
  if (!phone) return c.json({ error: "missing phone" }, 400);

  await inboundQueue.add(
    "inbound",
    { agentId, phone, payload, receivedAt: Date.now() },
    { removeOnComplete: 1000, removeOnFail: 5000, attempts: 3, backoff: { type: "exponential", delay: 5000 } },
  );
  logger.debug({ agentId, phone }, "enqueued inbound");
  return c.json({ ok: true });
});

webhookRoute.post("/clinicorp/:agentId", async (c) => {
  // fluxo 08 parte 1
  return c.json({ ok: true });
});

webhookRoute.post("/helena-tags/:agentId", async (c) => {
  // fluxo 08 parte 2
  return c.json({ ok: true });
});
