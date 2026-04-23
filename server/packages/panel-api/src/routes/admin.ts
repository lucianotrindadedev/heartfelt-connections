import { Hono } from "hono";
import { requireAdmin } from "../middleware/auth";

export const adminRoute = new Hono();
adminRoute.use("*", requireAdmin);

adminRoute.get("/accounts", (c) => c.json([]));
adminRoute.post("/accounts", (c) => c.json({ ok: true }));
adminRoute.get("/accounts/:id/agents", (c) => c.json([]));
adminRoute.post("/accounts/:id/agents", (c) => c.json({ ok: true }));
