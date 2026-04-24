import { Hono } from "hono";
import { env, logger } from "@sarai/shared";
import { webhookRoute } from "./webhook";
import "./queue"; // boot inbound worker
import "./automations"; // boot clinicorp + tag event workers

const app = new Hono();

app.get("/health", (c) => c.json({ ok: true, svc: "engine" }));
app.route("/webhook", webhookRoute);

logger.info({ port: env.ENGINE_PORT }, "engine starting");
export default { port: env.ENGINE_PORT, fetch: app.fetch };
