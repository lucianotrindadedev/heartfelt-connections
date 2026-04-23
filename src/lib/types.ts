/**
 * Tipos compartilhados entre frontend e backend.
 * Mantenha em sincronia com o schema Postgres em server/db/schema.sql.
 */

export type AgentKind = "main" | "followup" | "warmup";

export type AgentTemplate =
  | "clinicorp_dental"
  | "google_calendar_generic"
  | "clinup"
  | "custom";

export type IntegrationType =
  | "helena_crm"
  | "clinicorp"
  | "google_calendar"
  | "google_drive"
  | "clinup"
  | "elevenlabs"
  | "openrouter"
  | "evolution_api"
  | "central360"
  | "groq";

export interface Account {
  id: string;
  name: string;
  crm_base_api: string | null;
  crm_token_set: boolean;
  created_at: string;
}

export interface Agent {
  id: string;
  account_id: string;
  name: string;
  kind: AgentKind;
  template: AgentTemplate;
  enabled: boolean;
  llm_provider: string;
  llm_model: string;
  system_prompt: string;
  voice_settings: Record<string, unknown> | null;
  tools: string[];
  created_at: string;
}

export interface AgentWebhook {
  agent_id: string;
  inbound_url: string;
  inbound_token: string;
}

export interface Integration {
  id: string;
  account_id: string;
  type: IntegrationType;
  config_preview: Record<string, string>;
  has_secrets: boolean;
  updated_at: string;
}

export interface FollowupConfig {
  agent_id: string;
  enabled: boolean;
  cron_expression: string;
  max_followups: number;
  prompts: string[];
}

export interface WarmupConfig {
  agent_id: string;
  enabled: boolean;
  tempo_wu1: number;
  tempo_wu2: number;
  tempo_wu3: number;
  tempo_wu4: number;
  tempo_wu5: number;
  prompts: { wu1: string; wu2: string; wu3: string; wu4: string; wu5: string };
  subscriber_id: string | null;
  business_id: string | null;
}

export interface MediaAsset {
  id: string;
  agent_id: string;
  name: string;
  description: string;
  source: "gdrive" | "supabase_storage";
  external_id: string;
  mime_type: string;
}

export interface AutomationRule {
  id: string;
  agent_id: string;
  trigger: "tag_changed" | "appointment_status";
  conditions: Record<string, unknown>;
  actions: Array<Record<string, unknown>>;
  enabled: boolean;
}

export interface AgentRun {
  id: string;
  agent_id: string;
  conversation_id: string | null;
  phone: string | null;
  status: "ok" | "error" | "skipped";
  latency_ms: number;
  cost_usd: number;
  tokens_in: number;
  tokens_out: number;
  tools_called: string[];
  error: string | null;
  created_at: string;
}

export interface Conversation {
  id: string;
  agent_id: string;
  phone: string;
  helena_session_id: string | null;
  helena_contact_id: string | null;
  status: string;
  updated_at: string;
}

export interface Message {
  id: string;
  conversation_id: string;
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  tool_calls: unknown;
  created_at: string;
}

export interface DashboardStats {
  agents_active: number;
  messages_24h: number;
  estimated_cost_24h_usd: number;
  queue_size: number;
}
