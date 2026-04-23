import { Hono } from "hono";
import { requireSession } from "../middleware/auth";

export const testsRoute = new Hono();
testsRoute.use("*", requireSession);

testsRoute.post("/:integration", async (c) => {
  // Stub — cada integração ganha seu próprio test runner.
  return c.json({ ok: true, details: "stub: implementar por integração" });
});
