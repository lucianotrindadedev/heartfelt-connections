import { Hono } from "hono";
import { requireSession } from "../middleware/auth";

export const conversationsRoute = new Hono();
conversationsRoute.use("*", requireSession);
conversationsRoute.get("/:id/messages", (c) => c.json([]));
