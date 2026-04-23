-- ============================================================
-- Sarai Platform — schema inicial
-- Aplicar com: bun run db:migrate (drizzle-kit migrate)
-- ou diretamente: psql "$DATABASE_URL" -f 0000_init.sql
-- ============================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------- ENUMS ----------
DO $$ BEGIN
  CREATE TYPE "integration_type" AS ENUM (
    'helena_crm','clinicorp','google_calendar','google_drive','clinup',
    'elevenlabs','openrouter','evolution_api','central360','groq'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "agent_kind" AS ENUM ('main','followup','warmup');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ---------- ACCOUNTS ----------
CREATE TABLE IF NOT EXISTS "accounts" (
  "id"            text PRIMARY KEY,
  "name"          text NOT NULL,
  "crm_base_api"  text,
  "crm_token_enc" bytea,
  "created_at"    timestamptz NOT NULL DEFAULT now()
);

-- ---------- INTEGRATIONS ----------
CREATE TABLE IF NOT EXISTS "integrations" (
  "id"             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "account_id"    text NOT NULL REFERENCES "accounts"("id") ON DELETE CASCADE,
  "type"          "integration_type" NOT NULL,
  "config_enc"    bytea NOT NULL,
  "config_preview" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "updated_at"    timestamptz NOT NULL DEFAULT now(),
  UNIQUE ("account_id","type")
);

-- ---------- AGENTS ----------
CREATE TABLE IF NOT EXISTS "agents" (
  "id"            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "account_id"    text NOT NULL REFERENCES "accounts"("id") ON DELETE CASCADE,
  "name"          text NOT NULL,
  "kind"          "agent_kind" NOT NULL,
  "template"      text NOT NULL,
  "enabled"       boolean NOT NULL DEFAULT true,
  "llm_provider"  text NOT NULL DEFAULT 'openrouter',
  "llm_model"     text NOT NULL DEFAULT 'x-ai/grok-4-fast',
  "system_prompt" text NOT NULL,
  "voice_settings" jsonb,
  "tools"         jsonb NOT NULL DEFAULT '[]'::jsonb,
  "webhook_secret" text NOT NULL DEFAULT encode(gen_random_bytes(16),'hex'),
  "created_at"    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_agents_account ON "agents"("account_id");

-- ---------- FOLLOWUP CONFIG ----------
CREATE TABLE IF NOT EXISTS "agent_followup_config" (
  "agent_id"        uuid PRIMARY KEY REFERENCES "agents"("id") ON DELETE CASCADE,
  "enabled"         boolean NOT NULL DEFAULT true,
  "cron_expression" text NOT NULL DEFAULT '*/10 8-21 * * *',
  "max_followups"   integer NOT NULL DEFAULT 3,
  "prompts"         jsonb NOT NULL DEFAULT '[]'::jsonb
);

-- ---------- WARMUP CONFIG ----------
CREATE TABLE IF NOT EXISTS "agent_warmup_config" (
  "agent_id"      uuid PRIMARY KEY REFERENCES "agents"("id") ON DELETE CASCADE,
  "enabled"       boolean NOT NULL DEFAULT true,
  "tempo_wu1"     integer NOT NULL DEFAULT 96,
  "tempo_wu2"     integer NOT NULL DEFAULT 72,
  "tempo_wu3"     integer NOT NULL DEFAULT 48,
  "tempo_wu4"     integer NOT NULL DEFAULT 24,
  "tempo_wu5"     integer NOT NULL DEFAULT 2,
  "prompts"       jsonb NOT NULL DEFAULT '{}'::jsonb,
  "subscriber_id" text,
  "business_id"   text
);

-- ---------- AUTOMATION RULES ----------
CREATE TABLE IF NOT EXISTS "agent_automation_rules" (
  "id"         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "agent_id"   uuid NOT NULL REFERENCES "agents"("id") ON DELETE CASCADE,
  "trigger"    text NOT NULL,
  "conditions" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "actions"    jsonb NOT NULL DEFAULT '[]'::jsonb,
  "enabled"    boolean NOT NULL DEFAULT true
);

-- ---------- MEDIA ASSETS ----------
CREATE TABLE IF NOT EXISTS "media_assets" (
  "id"          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "agent_id"    uuid NOT NULL REFERENCES "agents"("id") ON DELETE CASCADE,
  "name"        text NOT NULL,
  "description" text,
  "source"      text NOT NULL,
  "external_id" text,
  "mime_type"   text
);

-- ---------- CONVERSATIONS ----------
CREATE TABLE IF NOT EXISTS "conversations" (
  "id"                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "agent_id"           uuid NOT NULL REFERENCES "agents"("id") ON DELETE CASCADE,
  "phone"              text NOT NULL,
  "helena_session_id"  text,
  "helena_contact_id"  text,
  "status"             text NOT NULL DEFAULT 'active',
  "meta"               jsonb NOT NULL DEFAULT '{}'::jsonb,
  "updated_at"         timestamptz NOT NULL DEFAULT now(),
  UNIQUE ("agent_id","phone")
);

-- ---------- MESSAGES ----------
CREATE TABLE IF NOT EXISTS "messages" (
  "id"              bigserial PRIMARY KEY,
  "conversation_id" uuid NOT NULL REFERENCES "conversations"("id") ON DELETE CASCADE,
  "role"            text NOT NULL,
  "content"         text NOT NULL,
  "tool_calls"      jsonb,
  "created_at"      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_messages_conv_created ON "messages"("conversation_id","created_at" DESC);

-- ---------- CONVERSATION STATE ----------
CREATE TABLE IF NOT EXISTS "conversation_state" (
  "conversation_id"      uuid PRIMARY KEY REFERENCES "conversations"("id") ON DELETE CASCADE,
  "lock_conversa"        boolean NOT NULL DEFAULT false,
  "aguardando_followup"  boolean NOT NULL DEFAULT false,
  "numero_followup"      integer NOT NULL DEFAULT 0,
  "last_user_message_at" timestamptz,
  "updated_at"           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_state_awaiting_followup
  ON "conversation_state"("conversation_id")
  WHERE "aguardando_followup" = true;

-- ---------- WARMUP SENT ----------
CREATE TABLE IF NOT EXISTS "warmup_sent" (
  "account_id"     text NOT NULL,
  "appointment_id" text NOT NULL,
  "reminder_type"  text NOT NULL,
  "sent_at"        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("account_id","appointment_id","reminder_type")
);

-- ---------- AGENT RUNS ----------
CREATE TABLE IF NOT EXISTS "agent_runs" (
  "id"              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "agent_id"        uuid NOT NULL REFERENCES "agents"("id") ON DELETE CASCADE,
  "conversation_id" uuid,
  "phone"           text,
  "status"          text NOT NULL,
  "latency_ms"      integer,
  "tokens_in"       integer,
  "tokens_out"      integer,
  "cost_usd"        numeric(12,6) NOT NULL DEFAULT 0,
  "tools_called"    jsonb NOT NULL DEFAULT '[]'::jsonb,
  "error"           text,
  "created_at"      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_runs_agent_created ON "agent_runs"("agent_id","created_at" DESC);
