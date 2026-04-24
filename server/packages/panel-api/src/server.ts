import { Hono } from "hono";
import { cors } from "hono/cors";
import { env, logger, db, agentTemplates } from "@sarai/shared";
import { eq } from "drizzle-orm";
import { authRoute } from "./routes/auth";
import { accountsRoute } from "./routes/accounts";
import { agentsRoute } from "./routes/agents";
import { integrationsRoute } from "./routes/integrations";
import { conversationsRoute } from "./routes/conversations";
import { runsRoute } from "./routes/runs";
import { statsRoute } from "./routes/stats";
import { testsRoute } from "./routes/tests";
import { adminRoute } from "./routes/admin";

const app = new Hono();

app.use(
  "*",
  cors({
    origin: (o) => o ?? "*",
    allowHeaders: ["Authorization", "Content-Type", "X-Admin-Token"],
    allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  }),
);

app.get("/health", (c) => c.json({ ok: true, svc: "panel-api" }));

app.route("/api/auth", authRoute);
app.route("/api/accounts", accountsRoute);
app.route("/api/agents", agentsRoute);
app.route("/api/conversations", conversationsRoute);
app.route("/api/test", testsRoute);
app.route("/api/admin", adminRoute);

// Public templates list (accessible with session auth)
app.get("/api/templates", async (c) => {
  const rows = await db.select({
    id: agentTemplates.id,
    key: agentTemplates.key,
    label: agentTemplates.label,
    description: agentTemplates.description,
    integrationKey: agentTemplates.integrationKey,
    requiredIntegrations: agentTemplates.requiredIntegrations,
    optionalIntegrations: agentTemplates.optionalIntegrations,
    credentialFields: agentTemplates.credentialFields,
    enabled: agentTemplates.enabled,
  }).from(agentTemplates).where(eq(agentTemplates.enabled, true));
  return c.json(rows);
});

// /api/accounts/:id/integrations e runs são montados dentro de accountsRoute
void integrationsRoute;
void runsRoute;
void statsRoute;

logger.info({ port: env.PANEL_PORT }, "panel-api starting");

export default { port: env.PANEL_PORT, fetch: app.fetch };
