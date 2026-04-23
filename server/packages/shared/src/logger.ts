import pino from "pino";
import { env } from "./env";

export const logger = pino({
  level: env.LOG_LEVEL,
  base: { svc: process.env.SVC_NAME ?? "sarai" },
  timestamp: pino.stdTimeFunctions.isoTime,
});

export type Logger = typeof logger;
