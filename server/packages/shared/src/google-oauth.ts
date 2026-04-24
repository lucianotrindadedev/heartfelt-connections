/**
 * Google OAuth2 helper for Google Calendar integration.
 * 
 * Flow:
 * 1. Frontend calls GET /api/oauth/google/url?accountId=X → returns consent URL
 * 2. User authorizes in popup → Google redirects to /api/oauth/google/callback?code=X&state=accountId
 * 3. Backend exchanges code for tokens → saves encrypted in integrations table
 * 4. Frontend polls /api/accounts/:id/integrations to see google_calendar is configured
 * 5. Engine uses access_token (auto-refreshed) to call Google Calendar API
 */

import { env } from "./env";

const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";

const SCOPES = [
  "https://www.googleapis.com/auth/calendar",
  "https://www.googleapis.com/auth/calendar.events",
].join(" ");

export function getGoogleRedirectUri(): string {
  return `${env.PUBLIC_BASE_URL}/api/oauth/google/callback`;
}

/**
 * Generate the Google OAuth consent URL.
 * The `state` parameter carries the accountId so we know who authorized.
 */
export function getGoogleConsentUrl(accountId: string): string {
  if (!env.GOOGLE_CLIENT_ID) throw new Error("GOOGLE_CLIENT_ID not configured");
  
  const params = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: getGoogleRedirectUri(),
    response_type: "code",
    scope: SCOPES,
    access_type: "offline",      // Get refresh_token
    prompt: "consent",           // Force consent to always get refresh_token
    state: accountId,
  });
  
  return `${GOOGLE_AUTH_URL}?${params.toString()}`;
}

/**
 * Exchange authorization code for access + refresh tokens.
 */
export async function exchangeGoogleCode(code: string): Promise<{
  access_token: string;
  refresh_token: string;
  expires_in: number;
  token_type: string;
  scope: string;
}> {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
    throw new Error("Google OAuth credentials not configured");
  }
  
  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri: getGoogleRedirectUri(),
      grant_type: "authorization_code",
    }),
  });
  
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Google token exchange failed: ${res.status} ${text}`);
  }
  
  return res.json();
}

/**
 * Refresh an expired access token using the refresh token.
 */
export async function refreshGoogleToken(refreshToken: string): Promise<{
  access_token: string;
  expires_in: number;
}> {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
    throw new Error("Google OAuth credentials not configured");
  }
  
  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      refresh_token: refreshToken,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      grant_type: "refresh_token",
    }),
  });
  
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Google token refresh failed: ${res.status} ${text}`);
  }
  
  return res.json();
}

/**
 * Get a valid access token, refreshing if necessary.
 * The config object should contain: access_token, refresh_token, expires_at (epoch ms)
 */
export async function getValidGoogleToken(config: {
  access_token: string;
  refresh_token: string;
  expires_at: number;
}): Promise<{ access_token: string; refreshed: boolean; newConfig?: typeof config }> {
  // If token expires in less than 5 minutes, refresh it
  const fiveMinutes = 5 * 60 * 1000;
  if (Date.now() + fiveMinutes < config.expires_at) {
    return { access_token: config.access_token, refreshed: false };
  }
  
  const result = await refreshGoogleToken(config.refresh_token);
  const newConfig = {
    access_token: result.access_token,
    refresh_token: config.refresh_token, // refresh_token doesn't change
    expires_at: Date.now() + (result.expires_in * 1000),
  };
  
  return { access_token: result.access_token, refreshed: true, newConfig };
}

/**
 * List Google Calendar calendars for the user (to let them pick which calendar).
 */
export async function listGoogleCalendars(accessToken: string): Promise<Array<{ id: string; summary: string; primary?: boolean }>> {
  const res = await fetch("https://www.googleapis.com/calendar/v3/users/me/calendarList", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  
  if (!res.ok) throw new Error(`Failed to list calendars: ${res.status}`);
  const data = await res.json();
  return (data.items || []).map((c: any) => ({
    id: c.id,
    summary: c.summary,
    primary: c.primary || false,
  }));
}
