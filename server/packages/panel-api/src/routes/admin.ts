import { Hono } from "hono";
import { z } from "zod";
import { eq, desc } from "drizzle-orm";
import { requireAdmin } from "../middleware/auth";
import { db, accounts, agents, agentFollowupConfig, agentWarmupConfig } from "@sarai/shared";
import { templates } from "@sarai/shared/templates";

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

  const tpl = (templates as Record<string, (typeof templates)[keyof typeof templates] | undefined>)[
    body.template
  ];

  const [agent] = await db
    .insert(agents)
    .values({
      accountId,
      name: body.name,
      kind: body.kind,
      template: body.template,
      llmProvider: body.llm_provider ?? "openrouter",
      llmModel: body.llm_model ?? "x-ai/grok-4-fast",
      systemPrompt: body.system_prompt ?? tpl?.default_prompt ?? "",
      tools: tpl ? [...tpl.default_tools] : [],
    })
    .returning();

  if (tpl) {
    await db
      .insert(agentFollowupConfig)
      .values({
        agentId: agent.id,
        cronExpression: tpl.followup_defaults.cron,
        maxFollowups: tpl.followup_defaults.max,
        prompts: tpl.followup_defaults.prompts,
      })
      .onConflictDoNothing();

    await db
      .insert(agentWarmupConfig)
      .values({
        agentId: agent.id,
        tempoWu1: tpl.warmup_defaults.wu1,
        tempoWu2: tpl.warmup_defaults.wu2,
        tempoWu3: tpl.warmup_defaults.wu3,
        tempoWu4: tpl.warmup_defaults.wu4,
        tempoWu5: tpl.warmup_defaults.wu5,
        prompts: tpl.warmup_defaults.prompts,
      })
      .onConflictDoNothing();
  }

  return c.json(agent);
});
