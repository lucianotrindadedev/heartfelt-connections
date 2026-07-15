import { createFileRoute } from "@tanstack/react-router";
import { ensureAgentQueueWorker } from "@/lib/agent-queue-redis.server";
import { isRedisAgentQueueActive, isRedisConfigured } from "@/lib/redis.server";

export const Route = createFileRoute("/api/health")({
  server: {
    handlers: {
      GET: async () => {
        if (isRedisAgentQueueActive()) {
          ensureAgentQueueWorker();
        }
        return Response.json({
          ok: true,
          // Commit do build (injetado no bundle pelo build-vercel.mjs). Permite
          // conferir de fora QUAL versão está no ar — sem isso, saber se um
          // deploy realmente subiu era adivinhação.
          commit: process.env.BUILD_COMMIT ?? "unknown",
          redis: isRedisConfigured(),
          redis_worker: isRedisAgentQueueActive(),
        });
      },
    },
  },
});
