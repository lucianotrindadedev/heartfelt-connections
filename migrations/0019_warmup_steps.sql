-- 0019_warmup_steps.sql
-- Nova sequência de warm-up (lembretes de consulta) modelada como steps,
-- igual ao follow-up. Cada step define:
--   - quanto tempo ANTES da consulta dispara (valor + unidade)
--   - qual template Helena usar (busca por nome via /chat/v1/template)
--   - janela de tolerância em minutos (se o cron rodar atrasado)
--
-- Funciona para qualquer source de agendamento ativo na conta (Clinicorp,
-- Google Calendar, Clinup), via adapter no servidor.

create table if not exists warmup_steps (
  id uuid primary key default gen_random_uuid(),
  agent_id uuid not null references agents(id) on delete cascade,
  ordem int not null,
  enabled boolean not null default true,

  -- Tempo antes da consulta (ex.: 24 hours, 2 hours, 30 minutes)
  time_before_value int not null default 24,
  time_before_unit text not null default 'hours'
    check (time_before_unit in ('minutes','hours','days')),

  -- Template Helena identificado pelo Name (ex.: "WU1", "lembrete-24h")
  -- A resolução pra templateId acontece no momento do envio (via API Helena)
  helena_template_name text not null,

  -- Janela de tolerância em minutos. Default 30: se o cron rodar até 30min
  -- após o sendAt previsto, ainda dispara.
  window_minutes int not null default 30,

  -- Opcional: só dispara para agendamentos com este status (ex.: ['Agendado','Confirmado'])
  -- NULL = todos os status
  appointment_status_filter text[],

  criado_em timestamptz default now(),
  updated_at timestamptz default now()
);

create unique index if not exists warmup_steps_agent_ordem
  on warmup_steps(agent_id, ordem);
create index if not exists warmup_steps_enabled
  on warmup_steps(agent_id) where enabled = true;

-- Log + dedupe de envios. UNIQUE(step_id, source, external_id) garante
-- que o mesmo step nunca dispara duas vezes pro mesmo agendamento.
create table if not exists warmup_sends (
  id uuid primary key default gen_random_uuid(),
  step_id uuid not null references warmup_steps(id) on delete cascade,
  agent_id uuid not null,
  account_id text not null,

  source text not null,           -- 'clinicorp' | 'google_calendar' | 'clinup'
  external_id text not null,      -- ID do agendamento no provider
  appointment_start timestamptz not null,
  patient_phone text,
  patient_name text,

  helena_template_id text,        -- ID resolvido no momento do envio
  helena_session_id text,         -- sessão usada para o send

  sent_at timestamptz default now(),
  status text not null,           -- 'sent' | 'failed'
  error text
);

create unique index if not exists warmup_sends_dedupe
  on warmup_sends(step_id, source, external_id) where status = 'sent';
create index if not exists warmup_sends_account_time
  on warmup_sends(account_id, sent_at desc);
