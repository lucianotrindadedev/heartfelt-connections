import { Worker } from "bullmq";
import { redis, env, logger } from "@sarai/shared";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Worker do agente. Substitui o "wait 20s + select" do n8n.
 * - Lock distribuído por `agent:phone` (Redis SETNX, TTL 120s).
 * - Debounce: dorme WEBHOOK_DEBOUNCE_MS, abandona se chegou job mais novo.
 * - Drena mensagens, chama LLM, divide, envia.
 */
export const worker = new Worker(
  "inbound",
  async (job) => {
    const { agentId, phone } = job.data as { agentId: string; phone: string };
    const lockKey = `lock:${agentId}:${phone}`;
    const acquired = await redis.set(lockKey, "1", "EX", 120, "NX");
    if (!acquired) {
      logger.debug({ agentId, phone }, "another worker is processing");
      return;
    }
    try {
      await sleep(env.WEBHOOK_DEBOUNCE_MS);
      // TODO: checar jobs mais novos para o mesmo agent:phone e abortar se houver.
      // TODO: getAgentConfig(agentId) — cache Redis 60s
      // TODO: runAgent + splitAndSend + logRun
      logger.info({ agentId, phone }, "processed inbound (stub)");
    } finally {
      await redis.del(lockKey);
    }
  },
  { connection: redis, concurrency: 10 },
);

worker.on("failed", (job, err) => {
  logger.error({ jobId: job?.id, err: err.message }, "inbound job failed");
});
