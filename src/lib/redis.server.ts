import IORedis from "ioredis";

/** BullMQ exige maxRetriesPerRequest: null no ioredis. */
export function createRedisConnection(label: string): IORedis {
  const url = process.env.REDIS_URL?.trim();
  if (!url) {
    throw new Error("REDIS_URL não configurada");
  }
  return new IORedis(url, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
    connectionName: `iasarai:${label}`,
  });
}

export function isRedisConfigured(): boolean {
  return !!process.env.REDIS_URL?.trim();
}

/** Worker BullMQ no mesmo processo (Coolify). */
export function isRedisAgentQueueActive(): boolean {
  return isRedisConfigured() && process.env.REDIS_QUEUE_WORKER === "true";
}
