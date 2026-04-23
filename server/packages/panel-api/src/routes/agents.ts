import { Hono } from "hono";
import { requireSession } from "../middleware/auth";
import { env } from "@sarai/shared";

export const agentsRoute = new Hono();
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

agentsRoute.get("/:id/webhook", (c) => {
  const id = c.req.param("id");
  return c.json({
    agent_id: id,
    inbound_url: `${env.PUBLIC_BASE_URL}/webhook/${id}`,
    webhook_secret: "<será preenchido pelo banco>",
  });
});
