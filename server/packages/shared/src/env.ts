import { z } from "zod";

const schema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("production"),
  LOG_LEVEL: z.string().default("info"),
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
  PGCRYPTO_KEY: z.string().min(16),
  JWT_SECRET: z.string().min(16),
  HELENA_HMAC_SECRET: z.string().min(16),
  ADMIN_API_KEY: z.string().min(8),
  PUBLIC_BASE_URL: z.string().url(),
  PANEL_PORT: z.coerce.number().default(8787),
  ENGINE_PORT: z.coerce.number().default(8788),
  WEBHOOK_DEBOUNCE_MS: z.coerce.number().default(20_000),
  SCHEDULER_TZ: z.string().default("America/Sao_Paulo"),
  OPENROUTER_DEFAULT_MODEL: z.string().default("x-ai/grok-4-fast"),
  SPLITTER_MODEL: z.string().default("x-ai/grok-4-fast"),
  GROQ_API_KEY: z.string().optional(),  // For audio transcription (Whisper)
  OPENAI_API_KEY: z.string().optional(),  // For image analysis (GPT-4o-mini)
  SUPABASE_URL: z.string().optional(),  // For temp file storage
  SUPABASE_SERVICE_ROLE_KEY: z.string().optional(),  // For temp file storage
  FORMATTER_MODEL: z.string().default("x-ai/grok-4.1-fast"),  // For WhatsApp formatting
  MONITOR_MODEL: z.string().default("x-ai/grok-4.1-fast"),  // For notification agent
});

export const env = schema.parse(process.env);
export type Env = z.infer<typeof schema>;
