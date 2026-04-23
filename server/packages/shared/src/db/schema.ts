import {
  bigserial,
  boolean,
  customType,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
  index,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

const bytea = customType<{ data: Buffer; default: false }>({
  dataType: () => "bytea",
});

export const integrationType = pgEnum("integration_type", [
  "helena_crm",
  "clinicorp",
  "google_calendar",
  "google_drive",
  "clinup",
  "elevenlabs",
  "openrouter",
  "evolution_api",
  "central360",
  "groq",
]);

export const agentKind = pgEnum("agent_kind", ["main", "followup", "warmup"]);

export const accounts = pgTable("accounts", {
  id: text("id").primaryKey(), // helena account_id
  name: text("name").notNull(),
  crmBaseApi: text("crm_base_api"),
  crmTokenEnc: bytea("crm_token_enc"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const integrations = pgTable(
  "integrations",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    accountId: text("account_id")
      .references(() => accounts.id, { onDelete: "cascade" })
      .notNull(),
    type: integrationType("type").notNull(),
    configEnc: bytea("config_enc").notNull(),
    configPreview: jsonb("config_preview").default({}).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({ uniq: unique().on(t.accountId, t.type) }),
);

export const agents = pgTable("agents", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  accountId: text("account_id")
    .references(() => accounts.id, { onDelete: "cascade" })
    .notNull(),
  name: text("name").notNull(),
  kind: agentKind("kind").notNull(),
  template: text("template").notNull(),
  enabled: boolean("enabled").default(true).notNull(),
  llmProvider: text("llm_provider").default("openrouter").notNull(),
  llmModel: text("llm_model").default("x-ai/grok-4-fast").notNull(),
  systemPrompt: text("system_prompt").notNull(),
  voiceSettings: jsonb("voice_settings"),
  tools: jsonb("tools").default([]).notNull(),
  webhookSecret: text("webhook_secret")
    .default(sql`encode(gen_random_bytes(16),'hex')`)
    .notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const agentFollowupConfig = pgTable("agent_followup_config", {
  agentId: uuid("agent_id")
    .primaryKey()
    .references(() => agents.id, { onDelete: "cascade" }),
  enabled: boolean("enabled").default(true).notNull(),
  cronExpression: text("cron_expression").default("*/10 8-21 * * *").notNull(),
  maxFollowups: integer("max_followups").default(3).notNull(),
  prompts: jsonb("prompts").default([]).notNull(),
});

export const agentWarmupConfig = pgTable("agent_warmup_config", {
  agentId: uuid("agent_id")
    .primaryKey()
    .references(() => agents.id, { onDelete: "cascade" }),
  enabled: boolean("enabled").default(true).notNull(),
  tempoWu1: integer("tempo_wu1").default(96).notNull(),
  tempoWu2: integer("tempo_wu2").default(72).notNull(),
  tempoWu3: integer("tempo_wu3").default(48).notNull(),
  tempoWu4: integer("tempo_wu4").default(24).notNull(),
  tempoWu5: integer("tempo_wu5").default(2).notNull(),
  prompts: jsonb("prompts").default({}).notNull(),
  subscriberId: text("subscriber_id"),
  businessId: text("business_id"),
});

export const agentAutomationRules = pgTable("agent_automation_rules", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  agentId: uuid("agent_id")
    .references(() => agents.id, { onDelete: "cascade" })
    .notNull(),
  trigger: text("trigger").notNull(),
  conditions: jsonb("conditions").default({}).notNull(),
  actions: jsonb("actions").default([]).notNull(),
  enabled: boolean("enabled").default(true).notNull(),
});

export const mediaAssets = pgTable("media_assets", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  agentId: uuid("agent_id")
    .references(() => agents.id, { onDelete: "cascade" })
    .notNull(),
  name: text("name").notNull(),
  description: text("description"),
  source: text("source").notNull(),
  externalId: text("external_id"),
  mimeType: text("mime_type"),
});

export const conversations = pgTable(
  "conversations",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    agentId: uuid("agent_id")
      .references(() => agents.id, { onDelete: "cascade" })
      .notNull(),
    phone: text("phone").notNull(),
    helenaSessionId: text("helena_session_id"),
    helenaContactId: text("helena_contact_id"),
    status: text("status").default("active").notNull(),
    meta: jsonb("meta").default({}).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({ uniqAgentPhone: unique().on(t.agentId, t.phone) }),
);

export const messages = pgTable("messages", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  conversationId: uuid("conversation_id")
    .references(() => conversations.id, { onDelete: "cascade" })
    .notNull(),
  role: text("role").notNull(),
  content: text("content").notNull(),
  toolCalls: jsonb("tool_calls"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const conversationState = pgTable(
  "conversation_state",
  {
    conversationId: uuid("conversation_id")
      .primaryKey()
      .references(() => conversations.id, { onDelete: "cascade" }),
    lockConversa: boolean("lock_conversa").default(false).notNull(),
    aguardandoFollowup: boolean("aguardando_followup").default(false).notNull(),
    numeroFollowup: integer("numero_followup").default(0).notNull(),
    lastUserMessageAt: timestamp("last_user_message_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    awaitingIdx: index("idx_state_awaiting_followup")
      .on(t.conversationId)
      .where(sql`${t.aguardandoFollowup} = true`),
  }),
);

export const warmupSent = pgTable(
  "warmup_sent",
  {
    accountId: text("account_id").notNull(),
    appointmentId: text("appointment_id").notNull(),
    reminderType: text("reminder_type").notNull(),
    sentAt: timestamp("sent_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({ pk: primaryKey({ columns: [t.accountId, t.appointmentId, t.reminderType] }) }),
);

export const agentRuns = pgTable("agent_runs", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  agentId: uuid("agent_id")
    .references(() => agents.id, { onDelete: "cascade" })
    .notNull(),
  conversationId: uuid("conversation_id"),
  phone: text("phone"),
  status: text("status").notNull(),
  latencyMs: integer("latency_ms"),
  tokensIn: integer("tokens_in"),
  tokensOut: integer("tokens_out"),
  costUsd: numeric("cost_usd", { precision: 12, scale: 6 }).default("0").notNull(),
  toolsCalled: jsonb("tools_called").default([]).notNull(),
  error: text("error"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});
