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
          redis: isRedisConfigured(),
          redis_worker: isRedisAgentQueueActive(),
        });
      },
    },
  },
});
