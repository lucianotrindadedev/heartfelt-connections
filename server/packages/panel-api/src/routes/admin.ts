import { Hono } from "hono";
import { z } from "zod";
import { eq, desc } from "drizzle-orm";
import { requireAdmin } from "../middleware/auth";
import { db, accounts, agents, agentFollowupConfig, agentWarmupConfig, agentTemplates } from "@sarai/shared";

export const adminRoute = new Hono();
adminRoute.use("*", requireAdmin);

// ---------- Accounts ----------
adminRoute.get("/accounts", async (c) => {
  const rows = await db
    .select({
      id: accounts.id,
      name: accounts.name,
      crm_base_api: accounts.crmBaseApi,
      created_at: accounts.createdAt,
    })
    .from(accounts)
    .orderBy(desc(accounts.createdAt));
  return c.json(
    rows.map((r) => ({
      ...r,
      crm_token_set: false,
      created_at: r.created_at?.toISOString?.() ?? r.created_at,
    })),
  );
});

const NewAccount = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  crm_base_api: z.string().url().nullish(),
});

adminRoute.post("/accounts", async (c) => {
  const body = NewAccount.parse(await c.req.json());
  const [row] = await db
    .insert(accounts)
    .values({ id: body.id, name: body.name, crmBaseApi: body.crm_base_api ?? null })
    .onConflictDoUpdate({
      target: accounts.id,
      set: { name: body.name, crmBaseApi: body.crm_base_api ?? null },
    })
    .returning();
  return c.json({
    id: row.id,
    name: row.name,
    crm_base_api: row.crmBaseApi,
    crm_token_set: false,
    created_at: row.createdAt,
  });
});

// ---------- Agents ----------
adminRoute.get("/accounts/:id/agents", async (c) => {
  const accountId = c.req.param("id");
  const rows = await db.select().from(agents).where(eq(agents.accountId, accountId));
  return c.json(rows);
});

const NewAgent = z.object({
  name: z.string().min(1),
  kind: z.enum(["main", "followup", "warmup"]).default("main"),
  template: z.string().default("clinicorp_dental"),
  llm_provider: z.string().optional(),
  llm_model: z.string().optional(),
  system_prompt: z.string().optional(),
});

adminRoute.post("/accounts/:id/agents", async (c) => {
  const accountId = c.req.param("id");
  const body = NewAgent.parse(await c.req.json());

  // Load template from database
  const [tpl] = await db.select().from(agentTemplates)
    .where(eq(agentTemplates.key, body.template))
    .limit(1);

  const [agent] = await db.insert(agents).values({
    accountId,
    name: body.name,
    kind: body.kind,
    template: body.template,
    llmProvider: body.llm_provider ?? "openrouter",
    llmModel: body.llm_model ?? "x-ai/grok-4.1-fast",
    systemPrompt: body.system_prompt ?? tpl?.defaultPrompt ?? "",
    tools: tpl ? tpl.defaultTools : [],
  }).returning();

  // Create followup/warmup config from template defaults
  if (tpl) {
    const fDefaults = tpl.followupDefaults as any;
    await db.insert(agentFollowupConfig).values({
      agentId: agent.id,
      cronExpression: fDefaults.cron || "*/10 8-21 * * *",
      maxFollowups: fDefaults.max || 2,
      prompts: fDefaults,
    }).onConflictDoNothing();

    const wDefaults = tpl.warmupDefaults as any;
    await db.insert(agentWarmupConfig).values({
      agentId: agent.id,
      tempoWu1: wDefaults.wu1 || 96,
      tempoWu2: wDefaults.wu2 || 72,
      tempoWu3: wDefaults.wu3 || 48,
      tempoWu4: wDefaults.wu4 || 24,
      tempoWu5: wDefaults.wu5 || 2,
      prompts: wDefaults.prompts || {},
    }).onConflictDoNothing();
  }

  return c.json(agent);
});

// ---------- Templates ----------
adminRoute.get("/templates", async (c) => {
  const rows = await db.select().from(agentTemplates).orderBy(agentTemplates.label);
  return c.json(rows);
});

adminRoute.get("/templates/:id", async (c) => {
  const id = c.req.param("id");
  const [tpl] = await db.select().from(agentTemplates).where(eq(agentTemplates.id, id)).limit(1);
  if (!tpl) return c.json({ error: "not_found" }, 404);
  return c.json(tpl);
});

const NewTemplate = z.object({
  key: z.string().min(1),
  label: z.string().min(1),
  description: z.string().optional(),
  integration_key: z.string().min(1),
  required_integrations: z.array(z.string()).default([]),
  optional_integrations: z.array(z.string()).default([]),
  default_tools: z.array(z.string()).default([]),
  default_prompt: z.string().default(""),
  tool_instructions: z.string().default(""),
  followup_defaults: z.any().default({}),
  warmup_defaults: z.any().default({}),
  credential_fields: z.array(z.any()).default([]),
  enabled: z.boolean().default(true),
});

adminRoute.post("/templates", async (c) => {
  const body = NewTemplate.parse(await c.req.json());
  const [row] = await db.insert(agentTemplates).values({
    key: body.key,
    label: body.label,
    description: body.description,
    integrationKey: body.integration_key,
    requiredIntegrations: body.required_integrations,
    optionalIntegrations: body.optional_integrations,
    defaultTools: body.default_tools,
    defaultPrompt: body.default_prompt,
    toolInstructions: body.tool_instructions,
    followupDefaults: body.followup_defaults,
    warmupDefaults: body.warmup_defaults,
    credentialFields: body.credential_fields,
    enabled: body.enabled,
  }).returning();
  return c.json(row, 201);
});

adminRoute.patch("/templates/:id", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json();

  const updates: Record<string, any> = {};
  if (body.label !== undefined) updates.label = body.label;
  if (body.description !== undefined) updates.description = body.description;
  if (body.integration_key !== undefined) updates.integrationKey = body.integration_key;
  if (body.required_integrations !== undefined) updates.requiredIntegrations = body.required_integrations;
  if (body.optional_integrations !== undefined) updates.optionalIntegrations = body.optional_integrations;
  if (body.default_tools !== undefined) updates.defaultTools = body.default_tools;
  if (body.default_prompt !== undefined) updates.defaultPrompt = body.default_prompt;
  if (body.tool_instructions !== undefined) updates.toolInstructions = body.tool_instructions;
  if (body.followup_defaults !== undefined) updates.followupDefaults = body.followup_defaults;
  if (body.warmup_defaults !== undefined) updates.warmupDefaults = body.warmup_defaults;
  if (body.credential_fields !== undefined) updates.credentialFields = body.credential_fields;
  if (body.enabled !== undefined) updates.enabled = body.enabled;

  if (Object.keys(updates).length === 0) return c.json({ error: "no fields" }, 400);
  updates.updatedAt = new Date();

  const [row] = await db.update(agentTemplates).set(updates)
    .where(eq(agentTemplates.id, id)).returning();
  if (!row) return c.json({ error: "not_found" }, 404);
  return c.json(row);
});

adminRoute.delete("/templates/:id", async (c) => {
  const id = c.req.param("id");
  const [row] = await db.delete(agentTemplates).where(eq(agentTemplates.id, id)).returning();
  if (!row) return c.json({ error: "not_found" }, 404);
  return c.json({ ok: true });
});
