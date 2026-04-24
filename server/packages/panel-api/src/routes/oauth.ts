import { Hono } from "hono";
import {
  db, integrations, env,
  getGoogleConsentUrl, exchangeGoogleCode, listGoogleCalendars,
  encrypt,
} from "@sarai/shared";
import { eq, and } from "drizzle-orm";

export const oauthRoute = new Hono();

/**
 * GET /api/oauth/google/url?accountId=X
 * Returns the Google consent URL for the given account.
 * Protected by session auth (the embed panel calls this).
 */
oauthRoute.get("/google/url", async (c) => {
  const accountId = c.req.query("accountId");
  if (!accountId) return c.json({ error: "accountId required" }, 400);
  
  if (!env.GOOGLE_CLIENT_ID) {
    return c.json({ error: "Google OAuth not configured on server" }, 500);
  }
  
  const url = getGoogleConsentUrl(accountId);
  return c.json({ url });
});

/**
 * GET /api/oauth/google/callback?code=X&state=accountId
 * Google redirects here after user authorizes.
 * Exchanges code for tokens, saves to integrations table, returns HTML that closes popup.
 */
oauthRoute.get("/google/callback", async (c) => {
  const code = c.req.query("code");
  const accountId = c.req.query("state");
  const error = c.req.query("error");
  
  if (error) {
    return c.html(`<html><body><script>window.opener?.postMessage({type:'google-oauth-error',error:'${error}'},'*');window.close();</script><p>Authorization cancelled. You can close this window.</p></body></html>`);
  }
  
  if (!code || !accountId) {
    return c.html(`<html><body><p>Missing parameters. Please try again.</p></body></html>`, 400);
  }
  
  try {
    // Exchange code for tokens
    const tokens = await exchangeGoogleCode(code);
    
    // List calendars so user can pick later
    const calendars = await listGoogleCalendars(tokens.access_token);
    
    // Save tokens encrypted in integrations table
    const config = {
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      expires_at: Date.now() + (tokens.expires_in * 1000),
      calendar_id: calendars.find(cal => cal.primary)?.id || "primary",
      calendars, // store the list so frontend can show a picker
    };
    
    const configJson = JSON.stringify(config);
    
    // Upsert the integration
    await db.insert(integrations).values({
      accountId,
      type: "google_calendar",
      configEnc: encrypt(configJson) as any,
      configPreview: {
        calendar_id: config.calendar_id,
        calendars_count: String(calendars.length),
        connected_at: new Date().toISOString(),
      } as any,
    }).onConflictDoUpdate({
      target: [integrations.accountId, integrations.type],
      set: {
        configEnc: encrypt(configJson) as any,
        configPreview: {
          calendar_id: config.calendar_id,
          calendars_count: String(calendars.length),
          connected_at: new Date().toISOString(),
        } as any,
        updatedAt: new Date(),
      },
    });
    
    // Return HTML that notifies the opener and closes the popup
    return c.html(`
      <html>
        <body style="font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;">
          <div style="text-align:center">
            <p style="font-size:18px;color:#22c55e;">Google Calendar conectado!</p>
            <p style="color:#666;font-size:14px;">Agenda: ${config.calendar_id}</p>
            <p style="color:#999;font-size:12px;">Esta janela sera fechada automaticamente...</p>
          </div>
          <script>
            window.opener?.postMessage({
              type: 'google-oauth-success',
              calendarId: '${config.calendar_id}',
              calendarsCount: ${calendars.length}
            }, '*');
            setTimeout(() => window.close(), 2000);
          </script>
        </body>
      </html>
    `);
  } catch (err: any) {
    return c.html(`
      <html>
        <body style="font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;">
          <div style="text-align:center">
            <p style="font-size:18px;color:#ef4444;">Erro na autorizacao</p>
            <p style="color:#666;font-size:14px;">${err.message}</p>
          </div>
          <script>
            window.opener?.postMessage({type:'google-oauth-error',error:'${err.message.replace(/'/g, "\\'")}'},'*');
          </script>
        </body>
      </html>
    `, 500);
  }
});

/**
 * GET /api/oauth/google/calendars?accountId=X
 * Returns the list of calendars for a connected account.
 * Used by the frontend to let the user pick which calendar to use.
 */
oauthRoute.get("/google/calendars", async (c) => {
  const accountId = c.req.query("accountId");
  if (!accountId) return c.json({ error: "accountId required" }, 400);
  
  const [intRow] = await db.select()
    .from(integrations)
    .where(and(eq(integrations.accountId, accountId), eq(integrations.type, "google_calendar" as any)));
  
  if (!intRow) return c.json({ error: "Google Calendar not connected" }, 404);
  
  // Decrypt config
  const { sql } = await import("drizzle-orm");
  const [dec] = await db.execute(
    sql`SELECT pgp_sym_decrypt(${intRow.configEnc}::bytea, ${env.PGCRYPTO_KEY}) as config`
  );
  if (!dec?.config) return c.json({ error: "Could not decrypt config" }, 500);
  
  const config = JSON.parse(dec.config as string);
  return c.json({
    calendars: config.calendars || [],
    selectedCalendarId: config.calendar_id,
  });
});

/**
 * POST /api/oauth/google/select-calendar
 * Updates the selected calendar_id for a connected account.
 */
oauthRoute.post("/google/select-calendar", async (c) => {
  const body = await c.req.json();
  const { accountId, calendarId } = body;
  if (!accountId || !calendarId) return c.json({ error: "accountId and calendarId required" }, 400);
  
  const [intRow] = await db.select()
    .from(integrations)
    .where(and(eq(integrations.accountId, accountId), eq(integrations.type, "google_calendar" as any)));
  
  if (!intRow) return c.json({ error: "Google Calendar not connected" }, 404);
  
  const { sql } = await import("drizzle-orm");
  const [dec] = await db.execute(
    sql`SELECT pgp_sym_decrypt(${intRow.configEnc}::bytea, ${env.PGCRYPTO_KEY}) as config`
  );
  if (!dec?.config) return c.json({ error: "Could not decrypt config" }, 500);
  
  const config = JSON.parse(dec.config as string);
  config.calendar_id = calendarId;
  
  const configJson = JSON.stringify(config);
  await db.update(integrations).set({
    configEnc: encrypt(configJson) as any,
    configPreview: {
      ...intRow.configPreview as any,
      calendar_id: calendarId,
    } as any,
    updatedAt: new Date(),
  }).where(eq(integrations.id, intRow.id));
  
  return c.json({ ok: true, calendar_id: calendarId });
});
