// GET /api/public/auth/google/callback
// Recebe o code do Google OAuth2, troca por tokens e salva criptografados.
// Renderiza página de sucesso que fecha o popup automaticamente.
import { createFileRoute } from "@tanstack/react-router";
import { getSelfhost } from "@/integrations/selfhost/client.server";
import { encryptValue } from "@/lib/crypto.server";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const USERINFO_URL = "https://www.googleapis.com/oauth2/v2/userinfo";

export const Route = createFileRoute("/api/public/auth/google/callback")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const url = new URL(request.url);
        const code = url.searchParams.get("code");
        const state = url.searchParams.get("state"); // accountId
        const error = url.searchParams.get("error");

        if (error || !code || !state) {
          return htmlResponse(false, error ?? "Parâmetros inválidos");
        }

        try {
          // Troca code por tokens
          const tokenRes = await fetch(TOKEN_URL, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
              code,
              client_id: process.env.GOOGLE_CLIENT_ID ?? "",
              client_secret: process.env.GOOGLE_CLIENT_SECRET ?? "",
              redirect_uri: process.env.GOOGLE_REDIRECT_URI ?? `${url.origin}/api/public/auth/google/callback`,
              grant_type: "authorization_code",
            }),
          });

          if (!tokenRes.ok) {
            throw new Error(`Token exchange failed: ${tokenRes.status}`);
          }

          const tokens = (await tokenRes.json()) as {
            access_token?: string;
            refresh_token?: string;
            expires_in?: number;
          };

          if (!tokens.access_token || !tokens.refresh_token) {
            throw new Error("Tokens ausentes na resposta do Google");
          }

          // Busca email do usuário
          const infoRes = await fetch(USERINFO_URL, {
            headers: { Authorization: `Bearer ${tokens.access_token}` },
          });
          const info = infoRes.ok
            ? ((await infoRes.json()) as { email?: string })
            : null;

          // Busca o calendário primário do usuário (nome amigável p/ UI)
          let primaryCalendarId = "primary";
          let primaryCalendarName: string | null = null;
          try {
            const calRes = await fetch(
              "https://www.googleapis.com/calendar/v3/users/me/calendarList?minAccessRole=writer",
              { headers: { Authorization: `Bearer ${tokens.access_token}` } },
            );
            if (calRes.ok) {
              const calJson = (await calRes.json()) as {
                items?: { id: string; summary: string; primary?: boolean }[];
              };
              const primary = (calJson.items ?? []).find((c) => c.primary);
              if (primary) {
                primaryCalendarId = primary.id;
                primaryCalendarName = primary.summary;
              }
            }
          } catch {
            // segue com fallback "primary"
          }

          const expiresAt = new Date(
            Date.now() + (tokens.expires_in ?? 3600) * 1000,
          ).toISOString();

          const sb = getSelfhost();
          await sb.from("google_calendar_tokens").upsert(
            {
              account_id: state,
              access_token_enc: await encryptValue(tokens.access_token),
              refresh_token_enc: await encryptValue(tokens.refresh_token),
              email: info?.email ?? null,
              calendar_id: primaryCalendarId,
              calendar_name: primaryCalendarName,
              expires_at: expiresAt,
              ativo: true,
              atualizado_em: new Date().toISOString(),
            },
            { onConflict: "account_id" },
          );

          return htmlResponse(true, null, info?.email ?? null);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          return htmlResponse(false, msg);
        }
      },
    },
  },
});

function htmlResponse(success: boolean, errorMsg: string | null, email?: string | null) {
  const html = success
    ? `<!DOCTYPE html>
<html lang="pt-BR">
<head><meta charset="UTF-8"><title>Google Calendar Conectado</title>
<style>body{font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#f0fdf4;}
.card{text-align:center;padding:2rem;background:white;border-radius:1rem;box-shadow:0 4px 24px #0001;}
h2{color:#16a34a;margin:0 0 .5rem;}p{color:#555;}</style></head>
<body><div class="card">
<h2>✅ Google Calendar conectado!</h2>
<p>${email ? `Conta: <strong>${email}</strong>` : "Conexão realizada com sucesso."}</p>
<p>Esta janela será fechada automaticamente...</p>
</div>
<script>setTimeout(()=>{window.close();},2000);</script>
</body></html>`
    : `<!DOCTYPE html>
<html lang="pt-BR">
<head><meta charset="UTF-8"><title>Erro</title>
<style>body{font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#fef2f2;}
.card{text-align:center;padding:2rem;background:white;border-radius:1rem;box-shadow:0 4px 24px #0001;}
h2{color:#dc2626;margin:0 0 .5rem;}p{color:#555;font-size:.9rem;}</style></head>
<body><div class="card">
<h2>❌ Erro ao conectar</h2>
<p>${errorMsg ?? "Erro desconhecido"}</p>
<p>Feche esta janela e tente novamente.</p>
</div></body></html>`;

  return new Response(html, {
    headers: { "Content-Type": "text/html; charset=utf-8" },
    status: success ? 200 : 400,
  });
}
