import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { requireSession } from "../middleware/auth";
import { db, agents, env } from "@sarai/shared";

export const agentsRoute = new Hono<{ Variables: { accountId: string } }>();
agentsRoute.use("*", requireSession);

agentsRoute.patch("/:id", (c) => c.json({ ok: true }));
agentsRoute.get("/:id/followup", (c) => c.json({}));
agentsRoute.patch("/:id/followup", (c) => c.json({ ok: true }));
agentsRoute.get("/:id/warmup", (c) => c.json({}));
agentsRoute.patch("/:id/warmup", (c) => c.json({ ok: true }));
agentsRoute.get("/:id/media", (c) => c.json([]));
agentsRoute.post("/:id/media", (c) => c.json({ ok: true }));
agentsRoute.delete("/:id/media/:mediaId", (c) => c.json({ ok: true }));
agentsRoute.get("/:id/automations", (c) => c.json([]));
agentsRoute.post("/:id/automations", (c) => c.json({ ok: true }));
agentsRoute.delete("/:id/automations/:ruleId", (c) => c.json({ ok: true }));

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
