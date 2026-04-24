import { Hono } from "hono";
import { requireSession } from "../middleware/auth";
import { db, integrations, env, HelenaClient } from "@sarai/shared";
import { eq, and, sql } from "drizzle-orm";

export const testsRoute = new Hono<{ Variables: { accountId: string } }>();
testsRoute.use("*", requireSession);

testsRoute.post("/:integration", async (c) => {
  const accountId = c.get("accountId");
  const intType = c.req.param("integration");

  // Get the integration config
  const [intRow] = await db.select()
    .from(integrations)
    .where(and(eq(integrations.accountId, accountId), eq(integrations.type, intType as any)));

  if (!intRow) return c.json({ ok: false, error: "Integration not configured" }, 404);

  // Decrypt config
  const [decrypted] = await db.execute(
    sql`SELECT pgp_sym_decrypt(${intRow.configEnc}::bytea, ${env.PGCRYPTO_KEY}) as config`
  );
  if (!decrypted?.config) return c.json({ ok: false, error: "Could not decrypt config" }, 500);

  const config = JSON.parse(decrypted.config as string);

  try {
    switch (intType) {
      case "helena_crm": {
        const helena = new HelenaClient({ baseUrl: config.base_url, token: config.token });
        const tags = await helena.listTags();
        return c.json({ ok: true, details: `Connected. ${tags.items?.length || 0} tags found.` });
      }
      case "openrouter": {
        const res = await fetch("https://openrouter.ai/api/v1/models", {
          headers: { Authorization: `Bearer ${config.api_key}` },
        });
        return c.json({ ok: res.ok, details: res.ok ? "API key valid" : `HTTP ${res.status}` });
      }
      case "clinicorp": {
        const url = new URL("https://api.clinicorp.com/rest/v1/appointment/status_list");
        url.searchParams.set("subscriber_id", config.subscriber_id || "");
        const res = await fetch(url.toString(), {
          headers: { Authorization: `Basic ${config.api_token}`, accept: "application/json" },
        });
        return c.json({ ok: res.ok, details: res.ok ? "Connected to Clinicorp" : `HTTP ${res.status}` });
      }
      case "groq": {
        const res = await fetch("https://api.groq.com/openai/v1/models", {
          headers: { Authorization: `Bearer ${config.api_key}` },
        });
        return c.json({ ok: res.ok, details: res.ok ? "API key valid" : `HTTP ${res.status}` });
      }
      case "evolution_api": {
        // Evolution only used for group alerts, test basic connectivity
        const res = await fetch(`${config.base_url}/instance/connectionState/${config.instance_name}`, {
          headers: { apikey: config.api_key },
        });
        const data = await res.json().catch(() => ({}));
        return c.json({ ok: res.ok, details: res.ok ? `State: ${data.state || "unknown"}` : `HTTP ${res.status}` });
      }
      default:
        return c.json({ ok: true, details: `No test runner for '${intType}' yet` });
    }
  } catch (e: any) {
    return c.json({ ok: false, error: e.message });
  }
});
