import IORedis from "ioredis";
import { env } from "./env";

export const redis = new IORedis(env.REDIS_URL, {
  maxRetriesPerRequest: null, // required by BullMQ
  enableReadyCheck: false,
  lazyConnect: true, // Only connect when needed
});

redis.on("error", (err) => {
  console.warn(`[redis] Warning: Connection error for ${env.REDIS_URL.split("@")[1] || "unknown host"}:`, err.message);
});

export const bullConnection = { connection: redis };
