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
        // Commit do que está REALMENTE no ar. Ordem: BUILD_COMMIT (injetado no
        // bundle pelo build-vercel.mjs) → variáveis que o Coolify/CI setam no
        // runtime do container (SOURCE_COMMIT etc.) → "unknown". A do build
        // vinha "unknown" porque o container de build não tinha git/.git; a de
        // runtime costuma estar presente e resolve isso.
        const commit =
          process.env.BUILD_COMMIT ||
          process.env.SOURCE_COMMIT ||
          process.env.COOLIFY_GIT_COMMIT_SHA ||
          process.env.GIT_COMMIT_SHA ||
          process.env.GIT_SHA ||
          "unknown";
        return Response.json({
          ok: true,
          commit,
          redis: isRedisConfigured(),
          redis_worker: isRedisAgentQueueActive(),
        });
      },
    },
  },
});
