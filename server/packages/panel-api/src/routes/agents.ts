import { Hono } from "hono";
import { eq, and } from "drizzle-orm";
import { requireSession } from "../middleware/auth";
import {
  db,
  agents,
  agentFollowupConfig,
  agentWarmupConfig,
  mediaAssets,
  agentAutomationRules,
  env,
} from "@sarai/shared";

export const agentsRoute = new Hono<{ Variables: { accountId: string } }>();
agentsRoute.use("*", requireSession);

/* ── helper: verify agent ownership ─────────────────────────── */
async function ownerAgent(id: string, accountId: string) {
  const [agent] = await db
    .select()
    .from(agents)
    .where(eq(agents.id, id))
    .limit(1);
  if (!agent) return null;
  if (agent.accountId !== accountId) return undefined; // forbidden
  return agent;
}

/* ── PATCH /:id  – partial update agent ─────────────────────── */
agentsRoute.patch("/:id", async (c) => {
  const id = c.req.param("id");
  const accountId = c.get("accountId");

  const owner = await ownerAgent(id, accountId);
  if (owner === null) return c.json({ error: "not_found" }, 404);
  if (owner === undefined) return c.json({ error: "forbidden" }, 403);

  const body = await c.req.json();
  const allowed = ["name", "system_prompt", "llm_provider", "llm_model", "tools", "enabled"] as const;

  // Map snake_case body keys to camelCase column names
  const keyMap: Record<string, string> = {
    name: "name",
    system_prompt: "systemPrompt",
    llm_provider: "llmProvider",
    llm_model: "llmModel",
    tools: "tools",
    enabled: "enabled",
  };

  const updates: Record<string, unknown> = {};
  for (const key of allowed) {
    if (body[key] !== undefined) {
      updates[keyMap[key]] = body[key];
    }
  }

  if (Object.keys(updates).length === 0) {
    return c.json(owner);
  }

  const [updated] = await db
    .update(agents)
    .set(updates)
    .where(eq(agents.id, id))
    .returning();

  return c.json(updated);
});

/* ── GET /:id/followup ──────────────────────────────────────── */
agentsRoute.get("/:id/followup", async (c) => {
  const id = c.req.param("id");
  const accountId = c.get("accountId");

  const owner = await ownerAgent(id, accountId);
  if (owner === null) return c.json({ error: "not_found" }, 404);
  if (owner === undefined) return c.json({ error: "forbidden" }, 403);

  const [config] = await db
    .select()
    .from(agentFollowupConfig)
    .where(eq(agentFollowupConfig.agentId, id))
    .limit(1);

  return c.json(config ?? {});
});

/* ── PATCH /:id/followup  – upsert ─────────────────────────── */
agentsRoute.patch("/:id/followup", async (c) => {
  const id = c.req.param("id");
  const accountId = c.get("accountId");

  const owner = await ownerAgent(id, accountId);
  if (owner === null) return c.json({ error: "not_found" }, 404);
  if (owner === undefined) return c.json({ error: "forbidden" }, 403);

  const body = await c.req.json();

  const values = {
    agentId: id,
    enabled: body.enabled,
    cronExpression: body.cron_expression,
    maxFollowups: body.max_followups,
    prompts: body.prompts,
  };

  // Remove undefined keys so defaults are used on insert
  const cleanValues = Object.fromEntries(
    Object.entries(values).filter(([, v]) => v !== undefined),
  ) as typeof values;

  const updateFields = { ...cleanValues };
  delete (updateFields as Record<string, unknown>).agentId;

  const [result] = await db
    .insert(agentFollowupConfig)
    .values(cleanValues)
    .onConflictDoUpdate({
      target: agentFollowupConfig.agentId,
      set: updateFields,
    })
    .returning();

  return c.json(result);
});

/* ── GET /:id/warmup ────────────────────────────────────────── */
agentsRoute.get("/:id/warmup", async (c) => {
  const id = c.req.param("id");
  const accountId = c.get("accountId");

  const owner = await ownerAgent(id, accountId);
  if (owner === null) return c.json({ error: "not_found" }, 404);
  if (owner === undefined) return c.json({ error: "forbidden" }, 403);

  const [config] = await db
    .select()
    .from(agentWarmupConfig)
    .where(eq(agentWarmupConfig.agentId, id))
    .limit(1);

  return c.json(config ?? {});
});

/* ── PATCH /:id/warmup  – upsert ───────────────────────────── */
agentsRoute.patch("/:id/warmup", async (c) => {
  const id = c.req.param("id");
  const accountId = c.get("accountId");

  const owner = await ownerAgent(id, accountId);
  if (owner === null) return c.json({ error: "not_found" }, 404);
  if (owner === undefined) return c.json({ error: "forbidden" }, 403);

  const body = await c.req.json();

  const values = {
    agentId: id,
    enabled: body.enabled,
    tempoWu1: body.tempo_wu1,
    tempoWu2: body.tempo_wu2,
    tempoWu3: body.tempo_wu3,
    tempoWu4: body.tempo_wu4,
    tempoWu5: body.tempo_wu5,
    prompts: body.prompts,
    subscriberId: body.subscriber_id,
    businessId: body.business_id,
  };

  const cleanValues = Object.fromEntries(
    Object.entries(values).filter(([, v]) => v !== undefined),
  ) as typeof values;

  const updateFields = { ...cleanValues };
  delete (updateFields as Record<string, unknown>).agentId;

  const [result] = await db
    .insert(agentWarmupConfig)
    .values(cleanValues)
    .onConflictDoUpdate({
      target: agentWarmupConfig.agentId,
      set: updateFields,
    })
    .returning();

  return c.json(result);
});

/* ── GET /:id/media ─────────────────────────────────────────── */
agentsRoute.get("/:id/media", async (c) => {
  const id = c.req.param("id");
  const accountId = c.get("accountId");

  const owner = await ownerAgent(id, accountId);
  if (owner === null) return c.json({ error: "not_found" }, 404);
  if (owner === undefined) return c.json({ error: "forbidden" }, 403);

  const rows = await db
    .select()
    .from(mediaAssets)
    .where(eq(mediaAssets.agentId, id));

  return c.json(rows);
});

/* ── POST /:id/media ────────────────────────────────────────── */
agentsRoute.post("/:id/media", async (c) => {
  const id = c.req.param("id");
  const accountId = c.get("accountId");

  const owner = await ownerAgent(id, accountId);
  if (owner === null) return c.json({ error: "not_found" }, 404);
  if (owner === undefined) return c.json({ error: "forbidden" }, 403);

  const body = await c.req.json();

  const [row] = await db
    .insert(mediaAssets)
    .values({
      agentId: id,
      name: body.name,
      description: body.description,
      source: body.source,
      externalId: body.external_id,
      mimeType: body.mime_type,
    })
    .returning();

  return c.json(row, 201);
});

/* ── DELETE /:id/media/:mediaId ─────────────────────────────── */
agentsRoute.delete("/:id/media/:mediaId", async (c) => {
  const id = c.req.param("id");
  const mediaId = c.req.param("mediaId");
  const accountId = c.get("accountId");

  const owner = await ownerAgent(id, accountId);
  if (owner === null) return c.json({ error: "not_found" }, 404);
  if (owner === undefined) return c.json({ error: "forbidden" }, 403);

  const [deleted] = await db
    .delete(mediaAssets)
    .where(and(eq(mediaAssets.id, mediaId), eq(mediaAssets.agentId, id)))
    .returning();

  if (!deleted) return c.json({ error: "not_found" }, 404);
  return c.json({ ok: true });
});

/* ── GET /:id/automations ───────────────────────────────────── */
agentsRoute.get("/:id/automations", async (c) => {
  const id = c.req.param("id");
  const accountId = c.get("accountId");

  const owner = await ownerAgent(id, accountId);
  if (owner === null) return c.json({ error: "not_found" }, 404);
  if (owner === undefined) return c.json({ error: "forbidden" }, 403);

  const rows = await db
    .select()
    .from(agentAutomationRules)
    .where(eq(agentAutomationRules.agentId, id));

  return c.json(rows);
});

/* ── POST /:id/automations ──────────────────────────────────── */
agentsRoute.post("/:id/automations", async (c) => {
  const id = c.req.param("id");
  const accountId = c.get("accountId");

  const owner = await ownerAgent(id, accountId);
  if (owner === null) return c.json({ error: "not_found" }, 404);
  if (owner === undefined) return c.json({ error: "forbidden" }, 403);

  const body = await c.req.json();

  const [row] = await db
    .insert(agentAutomationRules)
    .values({
      agentId: id,
      trigger: body.trigger,
      conditions: body.conditions,
      actions: body.actions,
      enabled: body.enabled,
    })
    .returning();

  return c.json(row, 201);
});

/* ── DELETE /:id/automations/:ruleId ────────────────────────── */
agentsRoute.delete("/:id/automations/:ruleId", async (c) => {
  const id = c.req.param("id");
  const ruleId = c.req.param("ruleId");
  const accountId = c.get("accountId");

  const owner = await ownerAgent(id, accountId);
  if (owner === null) return c.json({ error: "not_found" }, 404);
  if (owner === undefined) return c.json({ error: "forbidden" }, 403);

  const [deleted] = await db
    .delete(agentAutomationRules)
    .where(
      and(
        eq(agentAutomationRules.id, ruleId),
        eq(agentAutomationRules.agentId, id),
      ),
    )
    .returning();

  if (!deleted) return c.json({ error: "not_found" }, 404);
  return c.json({ ok: true });
});

/* ── GET /:id/webhook  (existing) ───────────────────────────── */
agentsRoute.get("/:id/webhook", async (c) => {
  const id = c.req.param("id");
  const accountId = c.get("accountId");

  const [agent] = await db
    .select({
      id: agents.id,
      accountId: agents.accountId,
      webhookSecret: agents.webhookSecret,
    })
    .from(agents)
    .where(eq(agents.id, id))
    .limit(1);

  if (!agent) return c.json({ error: "not_found" }, 404);
  if (agent.accountId !== accountId) return c.json({ error: "forbidden" }, 403);

  return c.json({
    agent_id: agent.id,
    inbound_url: `${env.PUBLIC_BASE_URL}/webhook/${agent.id}`,
    webhook_secret: agent.webhookSecret,
  });
});
