import { Hono } from "hono";
import { requireSession } from "../middleware/auth";

// Stub mínimo — implementar queries Drizzle ao integrar.
export const accountsRoute = new Hono();

accountsRoute.use("*", requireSession);

accountsRoute.get("/:id/stats", (c) =>
  c.json({ agents_active: 0, messages_24h: 0, estimated_cost_24h_usd: 0, queue_size: 0 }),
);
accountsRoute.get("/:id/agents", (c) => c.json([]));
accountsRoute.get("/:id/integrations", (c) => c.json([]));
accountsRoute.put("/:id/integrations", (c) => c.json({ ok: true }));
accountsRoute.get("/:id/conversations", (c) => c.json([]));
accountsRoute.get("/:id/runs", (c) => c.json([]));
