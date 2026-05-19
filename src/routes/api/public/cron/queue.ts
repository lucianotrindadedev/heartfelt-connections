// POST /api/public/cron/queue — processa fila de mensagens com debounce
// Chamado pelo pg_cron a cada minuto via pg_net.
import { createFileRoute } from "@tanstack/react-router";
import { processQueue } from "@/lib/message-queue.server";

function validateCronSecret(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  return request.headers.get("x-cron-secret") === secret;
}

export const Route = createFileRoute("/api/public/cron/queue")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        if (!validateCronSecret(request)) {
          return new Response("Unauthorized", { status: 401 });
        }
        const result = await processQueue();
        return Response.json({ ok: true, ...result });
      },
    },
  },
});
