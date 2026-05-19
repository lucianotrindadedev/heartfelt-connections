-- Migração: Integrações de ferramentas (Google Calendar, Clinicorp, Clinup, Escalação, Fila)
-- Execute no SQL Editor do Supabase self-hosted após 0001_schema.sql

-- ============================================================
-- GOOGLE CALENDAR OAUTH POR CONTA
-- ============================================================
create table if not exists public.google_calendar_tokens (
  account_id          text primary key references public.accounts(id) on delete cascade,
  access_token_enc    bytea,
  refresh_token_enc   bytea,
  calendar_id         text not null default 'primary',
  calendar_name       text,
  email               text,
  expires_at          timestamptz,
  ativo               boolean not null default true,
  atualizado_em       timestamptz not null default now()
);
create trigger trg_gcal_touch before update on public.google_calendar_tokens
  for each row execute function public.touch_updated_at();

-- ============================================================
-- CONFIGURAÇÃO CLINICORP POR CONTA
-- ============================================================
create table if not exists public.clinicorp_config (
  account_id          text primary key references public.accounts(id) on delete cascade,
  api_token_enc       bytea,                         -- Basic auth base64 encriptado
  subscriber_id       text,
  business_id         bigint,
  agenda_id           bigint,                        -- Dentist_PersonId do profissional
  duracao_consulta    int not null default 40,       -- minutos
  ativo               boolean not null default false,
  atualizado_em       timestamptz not null default now()
);
create trigger trg_clinicorp_touch before update on public.clinicorp_config
  for each row execute function public.touch_updated_at();

-- ============================================================
-- CONFIGURAÇÃO CLINUP POR CONTA
-- ============================================================
create table if not exists public.clinup_config (
  account_id          text primary key references public.accounts(id) on delete cascade,
  api_token_enc       bytea,
  base_url            text,                          -- URL base da instância Clinup
  clinic_id           text,
  agenda_id           text,
  duracao_consulta    int not null default 40,
  ativo               boolean not null default false,
  atualizado_em       timestamptz not null default now()
);
create trigger trg_clinup_touch before update on public.clinup_config
  for each row execute function public.touch_updated_at();

-- ============================================================
-- CONFIGURAÇÃO DE ESCALAÇÃO HUMANA POR AGENTE
-- ============================================================
create table if not exists public.agent_escalation (
  agent_id            uuid primary key references public.agents(id) on delete cascade,
  grupo_alerta        text,                          -- JID do grupo Evolution (ex: 120363...@g.us)
  evolution_url       text,
  evolution_instance  text,
  evolution_key_enc   bytea,
  ativo               boolean not null default true,
  atualizado_em       timestamptz not null default now()
);
create trigger trg_escalation_touch before update on public.agent_escalation
  for each row execute function public.touch_updated_at();

-- ============================================================
-- FILA DE MENSAGENS (DEBOUNCE)
-- ============================================================
create table if not exists public.message_queue (
  id                  uuid primary key default gen_random_uuid(),
  conversation_id     uuid not null references public.conversations(id) on delete cascade,
  execute_at          timestamptz not null,
  processed           boolean not null default false,
  created_at          timestamptz not null default now()
);
create index if not exists idx_mq_conv_pending
  on public.message_queue (conversation_id, processed, execute_at);
create index if not exists idx_mq_execute_at
  on public.message_queue (execute_at) where processed = false;

-- ============================================================
-- ALTERAÇÕES EM TABELAS EXISTENTES
-- ============================================================

-- agent_followup: adicionar prompts separados e array de delays
alter table public.agent_followup
  add column if not exists delay_horas   jsonb not null default '[60, 300]'::jsonb,
  add column if not exists prompt_fu1    text not null default '',
  add column if not exists prompt_fu2    text not null default '';

-- agent_warmup: já tem wu1-wu5 mas com nomes diferentes, garantir campos corretos
alter table public.agent_warmup
  add column if not exists tempo_wu1_h int not null default 96,
  add column if not exists tempo_wu2_h int not null default 72,
  add column if not exists tempo_wu3_h int not null default 48,
  add column if not exists tempo_wu4_h int not null default 24,
  add column if not exists tempo_wu5_h int not null default 2;

-- agents: adicionar debounce configurable
alter table public.agents
  add column if not exists debounce_segundos int not null default 20;
