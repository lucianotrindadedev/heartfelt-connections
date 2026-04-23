import { Hono } from "hono";
import { z } from "zod";
import { and, eq, desc, sql as dsql } from "drizzle-orm";
import { requireSession } from "../middleware/auth";
import {
  db,
  accounts,
  agents,
  integrations,
  conversations,
  agentRuns,
  encrypt,
} from "@sarai/shared";

export const accountsRoute = new Hono<{ Variables: { accountId: string } }>();
accountsRoute.use("*", requireSession);

// Garante que o JWT confere com :id
function assertSameAccount(c: { req: { param: (k: string) => string }; get: (k: "accountId") => string }) {
  const id = c.req.param("id");
  if (id !== c.get("accountId")) throw new Error("forbidden");
  return id;
}

accountsRoute.get("/:id/stats", async (c) => {
  const id = assertSameAccount(c);

  const [agentsCountRow] = await db
    .select({ n: dsql<number>`count(*)::int` })
    .from(agents)
    .where(and(eq(agents.accountId, id), eq(agents.enabled, true)));

  const [msgRow] = await db
    .select({ n: dsql<number>`count(*)::int` })
    .from(agentRuns)
    .innerJoin(agents, eq(agents.id, agentRuns.agentId))
    .where(and(eq(agents.accountId, id), dsql`${agentRuns.createdAt} > now() - interval '24 hours'`));

  const [costRow] = await db
    .select({ s: dsql<string>`coalesce(sum(${agentRuns.costUsd}),0)::text` })
    .from(agentRuns)
    .innerJoin(agents, eq(agents.id, agentRuns.agentId))
    .where(and(eq(agents.accountId, id), dsql`${agentRuns.createdAt} > now() - interval '24 hours'`));

  return c.json({
    agents_active: agentsCountRow?.n ?? 0,
    messages_24h: msgRow?.n ?? 0,
    estimated_cost_24h_usd: Number(costRow?.s ?? 0),
    queue_size: 0,
  });
});

accountsRoute.get("/:id/agents", async (c) => {
  const id = assertSameAccount(c);
  const rows = await db.select().from(agents).where(eq(agents.accountId, id));
  return c.json(rows);
});

accountsRoute.get("/:id/integrations", async (c) => {
  const id = assertSameAccount(c);
  const rows = await db
    .select({
      id: integrations.id,
      account_id: integrations.accountId,
      type: integrations.type,
      config_preview: integrations.configPreview,
      updated_at: integrations.updatedAt,
    })
    .from(integrations)
    .where(eq(integrations.accountId, id));
  return c.json(rows.map((r) => ({ ...r, has_secrets: true })));
});

const PutIntegration = z.object({
  type: z.enum([
    "helena_crm",
    "clinicorp",
    "google_calendar",
    "google_drive",
    "clinup",
    "elevenlabs",
    "openrouter",
    "evolution_api",
    "central360",
    "groq",
  ]),
  config: z.record(z.string(), z.unknown()),
  preview: z.record(z.string(), z.string()).optional(),
});

accountsRoute.put("/:id/integrations", async (c) => {
  const id = assertSameAccount(c);
  const body = PutIntegration.parse(await c.req.json());
  const enc = encrypt(JSON.stringify(body.config));
  await db
    .insert(integrations)
    .values({
      accountId: id,
      type: body.type,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      configEnc: enc as any,
      configPreview: body.preview ?? {},
    })
    .onConflictDoUpdate({
      target: [integrations.accountId, integrations.type],
      set: {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        configEnc: enc as any,
        configPreview: body.preview ?? {},
        updatedAt: new Date(),
      },
    });
  return c.json({ ok: true });
});

accountsRoute.get("/:id/conversations", async (c) => {
  const id = assertSameAccount(c);
  const rows = await db
    .select({
      id: conversations.id,
      agent_id: conversations.agentId,
      phone: conversations.phone,
      helena_session_id: conversations.helenaSessionId,
      helena_contact_id: conversations.helenaContactId,
      status: conversations.status,
      updated_at: conversations.updatedAt,
    })
    .from(conversations)
    .innerJoin(agents, eq(agents.id, conversations.agentId))
    .where(eq(agents.accountId, id))
    .orderBy(desc(conversations.updatedAt))
    .limit(200);
  return c.json(rows);
});

accountsRoute.get("/:id/runs", async (c) => {
  const id = assertSameAccount(c);
  const rows = await db
    .select({
      id: agentRuns.id,
      agent_id: agentRuns.agentId,
      conversation_id: agentRuns.conversationId,
      phone: agentRuns.phone,
      status: agentRuns.status,
      latency_ms: agentRuns.latencyMs,
      cost_usd: agentRuns.costUsd,
      tokens_in: agentRuns.tokensIn,
      tokens_out: agentRuns.tokensOut,
      tools_called: agentRuns.toolsCalled,
      error: agentRuns.error,
      created_at: agentRuns.createdAt,
    })
    .from(agentRuns)
    .innerJoin(agents, eq(agents.id, agentRuns.agentId))
    .where(eq(agents.accountId, id))
    .orderBy(desc(agentRuns.createdAt))
    .limit(200);
  return c.json(rows);
});

// silence unused
void accounts;
