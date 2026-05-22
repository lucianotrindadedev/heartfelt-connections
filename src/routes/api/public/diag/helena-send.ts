// POST /api/public/diag/helena-send
// Header: x-cron-secret: <CRON_SECRET>
// Body: { accountId: "...", text: "...", phone?: "...", sessionId?: "..." }
//
// Faz um envio de teste pelo Helena CRM usando a config da conta — sem rodar
// agente nem split. Útil para diagnosticar 400/401 da Helena isoladamente.
import { createFileRoute } from "@tanstack/react-router";
import { loadHelenaAccount, sendHelenaText } from "@/lib/helena.server";

function validateSecret(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  return request.headers.get("x-cron-secret") === secret;
}

export const Route = createFileRoute("/api/public/diag/helena-send")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        if (!validateSecret(request)) {
          return new Response("Unauthorized", { status: 401 });
        }

        let body: {
          accountId?: string;
          text?: string;
          phone?: string;
          sessionId?: string;
          viaWhatsApp?: boolean;
        };
        try {
          body = await request.json();
        } catch {
          return new Response("Invalid JSON", { status: 400 });
        }

        const accountId = body.accountId?.trim();
        const text = body.text?.trim();
        if (!accountId || !text) {
          return new Response("accountId and text required", { status: 400 });
        }

        try {
          const account = await loadHelenaAccount(accountId);
          const result = await sendHelenaText(account, {
            phone: body.phone,
            text,
            sessionId: body.sessionId,
            viaWhatsApp: body.viaWhatsApp ?? false,
          });

          // Retorna o token mascarado (last 4) para sabermos qual está em uso
          const tokenSuffix = account.token.slice(-4);

          return Response.json({
            ok: result.ok,
            status: result.status,
            response_body: result.body,
            using: {
              account_id: account.id,
              base_url: account.baseUrl,
              token_last4: `••${tokenSuffix}`,
            },
            sent: { phone: body.phone, sessionId: body.sessionId, viaWhatsApp: body.viaWhatsApp },
          });
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          return Response.json({ ok: false, error: msg }, { status: 500 });
        }
      },
    },
  },
});
