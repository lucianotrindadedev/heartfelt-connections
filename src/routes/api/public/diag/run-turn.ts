// POST /api/public/diag/run-turn
// Body: { conversation_id: "..." }
// Header: x-cron-secret: <CRON_SECRET>
//
// Força execução do agent turn direto (sem fila). Útil para destravar
// conversas quando o worker BullMQ está caído ou para diagnosticar erros
// que estão sendo silenciados.
import { createFileRoute } from "@tanstack/react-router";
import { runAgentTurn, ConversationLockedError } from "@/lib/agent-turn.server";

function validateSecret(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  return request.headers.get("x-cron-secret") === secret;
}

export const Route = createFileRoute("/api/public/diag/run-turn")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        if (!validateSecret(request)) {
          return new Response("Unauthorized", { status: 401 });
        }

        let body: { conversation_id?: string };
        try {
          body = (await request.json()) as { conversation_id?: string };
        } catch {
          return new Response("Invalid JSON", { status: 400 });
        }

        const conversationId = body.conversation_id?.trim();
        if (!conversationId) {
          return new Response("conversation_id required", { status: 400 });
        }

        const startedAt = Date.now();
        try {
          await runAgentTurn(conversationId);
          return Response.json({
            ok: true,
            conversation_id: conversationId,
            duration_ms: Date.now() - startedAt,
          });
        } catch (e) {
          if (e instanceof ConversationLockedError) {
            return Response.json({
              ok: false,
              reason: "locked",
              conversation_id: conversationId,
            });
          }
          const msg = e instanceof Error ? e.message : String(e);
          const stack = e instanceof Error ? e.stack : undefined;
          console.error("[diag-run-turn] falhou:", e);
          return Response.json(
            {
              ok: false,
              error: msg,
              stack: stack?.slice(0, 1500),
              conversation_id: conversationId,
            },
            { status: 500 },
          );
        }
      },
    },
  },
});
