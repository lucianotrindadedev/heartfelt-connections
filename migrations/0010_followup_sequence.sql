-- 0010_followup_sequence.sql
-- Follow-up em sequência: cada agente tem N steps numerados que vão sendo
-- enviados a cada X tempo de inatividade do lead. Suporta 2 modos por step:
--   - 'message': texto fixo
--   - 'contextual': sub-agente gera mensagem baseada na conversa

create table if not exists public.followup_steps (
  id            uuid primary key default gen_random_uuid(),
  agent_id      uuid not null references public.agents(id) on delete cascade,
  ordem         int not null,                    -- 1, 2, 3, ... ordem da sequência
  enabled       boolean not null default true,

  -- Tempo de espera ANTES desse step disparar:
  --   step 1: tempo após a última msg do lead
  --   step N (N>1): tempo após o envio do step N-1
  delay_value   int not null default 60,
  delay_unit    text not null default 'minutes' check (delay_unit in ('minutes','hours','days')),

  -- Modo
  mode          text not null default 'message' check (mode in ('message','contextual')),
  message_text  text,                              -- usado se mode='message'
  contextual_instruction text,                     -- usado se mode='contextual'

  -- Janela permitida para envio (opcional — null = qualquer horário)
  window_start_hour int default 8,                 -- 0-23
  window_end_hour   int default 20,
  -- Dias permitidos: array com keys ['dom','seg','ter','qua','qui','sex','sab']
  -- null/empty = qualquer dia
  allowed_days  jsonb default '["seg","ter","qua","qui","sex"]'::jsonb,

  criado_em     timestamptz not null default now(),
  atualizado_em timestamptz not null default now()
);

-- Cada agente tem no máximo 1 step por ordem (não tem ordem duplicada)
create unique index if not exists uq_followup_step_order
  on public.followup_steps (agent_id, ordem);

create index if not exists idx_followup_agent
  on public.followup_steps (agent_id, ordem);

-- Trigger atualizado_em
drop trigger if exists trg_followup_step_touch on public.followup_steps;
create trigger trg_followup_step_touch before update on public.followup_steps
  for each row execute function public.touch_updated_at();

-- ── Histórico de envios ───────────────────────────────────────────────────
-- Cada vez que um step é disparado para uma conversa, grava aqui.
-- Usado para: idempotência (não disparar 2x o mesmo step), métricas e debug.
create table if not exists public.followup_step_runs (
  id              uuid primary key default gen_random_uuid(),
  step_id         uuid not null references public.followup_steps(id) on delete cascade,
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  agent_id        uuid not null references public.agents(id) on delete cascade,
  sent_at         timestamptz not null default now(),
  message_sent    text,                          -- texto enviado (resolvido)
  status          text not null default 'sent',  -- sent | failed
  error           text
);
create index if not exists idx_followup_runs_conv
  on public.followup_step_runs (conversation_id, sent_at desc);
create index if not exists idx_followup_runs_step_conv
  on public.followup_step_runs (step_id, conversation_id);
