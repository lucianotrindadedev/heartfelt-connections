// POST /api/public/cron/drain-conversation — executa agente após debounce (fallback sem waitUntil)
import { createFileRoute } from "@tanstack/react-router";
import { scheduleConversationAgentTurn } from "@/lib/schedule-agent-turn.server";
import { runAgentTurn, ConversationLockedError } from "@/lib/agent-turn.server";

function validateCronSecret(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  return request.headers.get("x-cron-secret") === secret;
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export const Route = createFileRoute("/api/public/cron/drain-conversation")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        if (!validateCronSecret(request)) {
          return new Response("Unauthorized", { status: 401 });
        }

        const body = (await request.json()) as {
          conversation_id?: string;
          not_before_ms?: number;
          lock_retry?: number;
        };

        const conversationId = body.conversation_id?.trim();
        if (!conversationId) {
          return new Response("conversation_id required", { status: 400 });
        }

        const notBefore = body.not_before_ms ?? Date.now();
        const lockRetry = body.lock_retry ?? 0;

        const maxWait = 45_000;
        const started = Date.now();
        while (Date.now() < notBefore && Date.now() - started < maxWait) {
          await delay(500);
        }

        try {
          await runAgentTurn(conversationId);
          return Response.json({ ok: true, conversation_id: conversationId });
        } catch (e) {
          if (e instanceof ConversationLockedError) {
            scheduleConversationAgentTurn(
              conversationId,
              4,
              lockRetry + 1,
            );
            return Response.json({
              ok: true,
              deferred: "locked",
              conversation_id: conversationId,
            });
          }
          console.error("[drain-conversation] falhou:", e);
          return Response.json(
            { ok: false, error: e instanceof Error ? e.message : String(e) },
            { status: 500 },
          );
        }
      },
    },
  },
});
