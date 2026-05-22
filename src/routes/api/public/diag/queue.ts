// GET /api/public/diag/queue?x-cron-secret=...
//
// Diagnóstico do estado da fila de agent turns: env vars, conexão Redis,
// itens pendentes no pg_cron message_queue, agents inativos, etc.
import { createFileRoute } from "@tanstack/react-router";
import { getSelfhost } from "@/integrations/selfhost/client.server";
import { isRedisConfigured, isRedisAgentQueueActive } from "@/lib/redis.server";

function validateSecret(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const url = new URL(request.url);
  return (
    request.headers.get("x-cron-secret") === secret ||
    url.searchParams.get("secret") === secret
  );
}

export const Route = createFileRoute("/api/public/diag/queue")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        if (!validateSecret(request)) {
          return new Response("Unauthorized", { status: 401 });
        }

        const env = {
          REDIS_URL_configured: !!process.env.REDIS_URL,
          REDIS_QUEUE_WORKER: process.env.REDIS_QUEUE_WORKER ?? null,
          CRON_SECRET_configured: !!process.env.CRON_SECRET,
          APP_BASE_URL: process.env.APP_BASE_URL ?? null,
          GOOGLE_CLIENT_ID_configured: !!process.env.GOOGLE_CLIENT_ID,
          GROQ_API_KEY_configured: !!process.env.GROQ_API_KEY,
        };

        const redis = {
          configured: isRedisConfigured(),
          workerShouldRun: isRedisAgentQueueActive(),
        };

        // Estado do pg_cron message_queue
        const sb = getSelfhost();
        const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
        const [pending, recentProcessed] = await Promise.all([
          sb
            .from("message_queue")
            .select("id, conversation_id, execute_at, created_at", { count: "exact" })
            .eq("processed", false)
            .lte("execute_at", new Date().toISOString())
            .order("execute_at", { ascending: true })
            .limit(10),
          sb
            .from("message_queue")
            .select("id, processed_at, created_at", { count: "exact" })
            .eq("processed", true)
            .gte("created_at", oneHourAgo)
            .order("created_at", { ascending: false })
            .limit(5),
        ]);

        // Tentativa simples: ping Redis (apenas se configurado)
        let redisPing: string | null = null;
        if (isRedisConfigured()) {
          try {
            const { createRedisConnection } = await import("@/lib/redis.server");
            const r = createRedisConnection("diag");
            const result = await Promise.race([
              r.ping(),
              new Promise<string>((_, reject) =>
                setTimeout(() => reject(new Error("ping timeout 3s")), 3000),
              ),
            ]);
            redisPing = String(result);
            await r.quit();
          } catch (e) {
            redisPing = `ERROR: ${e instanceof Error ? e.message : String(e)}`;
          }
        }

        return Response.json({
          ok: true,
          now: new Date().toISOString(),
          env,
          redis,
          redis_ping: redisPing,
          message_queue: {
            pending_count: pending.count ?? 0,
            pending_sample: pending.data ?? [],
            processed_last_hour: recentProcessed.count ?? 0,
            processed_sample: recentProcessed.data ?? [],
          },
        });
      },
    },
  },
});
