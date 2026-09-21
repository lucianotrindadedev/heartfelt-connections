import { createFileRoute } from "@tanstack/react-router";
import { ensureAgentQueueWorker } from "@/lib/agent-queue-redis.server";
import { isRedisAgentQueueActive, isRedisConfigured } from "@/lib/redis.server";
import { resolveDeployCommit } from "@/lib/build-commit";

export const Route = createFileRoute("/api/health")({
  server: {
    handlers: {
      GET: async () => {
        if (isRedisAgentQueueActive()) {
          ensureAgentQueueWorker();
        }
        // Commit do que está REALMENTE no ar, e DE ONDE ele veio — o porquê de
        // cada fonte e do campo commit_source está em @/lib/build-commit.
        //
        // process.env.BUILD_COMMIT é substituído literalmente pelo `define` do
        // esbuild (build-vercel.mjs), então precisa aparecer escrito assim aqui.
        const { commit, source: commitSource } = resolveDeployCommit([
          ["build", process.env.BUILD_COMMIT],
          ["SOURCE_COMMIT", process.env.SOURCE_COMMIT],
          ["COOLIFY_GIT_COMMIT_SHA", process.env.COOLIFY_GIT_COMMIT_SHA],
          ["GIT_COMMIT_SHA", process.env.GIT_COMMIT_SHA],
          ["GIT_SHA", process.env.GIT_SHA],
        ]);

        return Response.json({
          ok: true,
          commit,
          commit_source: commitSource,
          redis: isRedisConfigured(),
          redis_worker: isRedisAgentQueueActive(),
        });
      },
    },
  },
});
