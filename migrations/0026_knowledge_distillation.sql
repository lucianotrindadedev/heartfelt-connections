-- 0026_knowledge_distillation.sql
-- Auto-distillation de FAQs a partir de conversas. Adiciona:
--   - status de revisao em knowledge_documents (approved/auto_pending/quarantine/rejected)
--   - metadados de confianca, frequencia e PII
--   - tabela de audit de execucoes (knowledge_distillation_runs)
--   - colunas de config por agente (frequencia minima, confianca minima,
--     quarentena, max auto-approve por run, schedule)

-- ============================================================
-- 1. knowledge_documents: novas colunas
-- ============================================================
alter table public.knowledge_documents
  add column if not exists review_status text not null default 'approved'
    check (review_status in ('approved','auto_pending','quarantine','rejected')),
  add column if not exists confidence numeric(3,2),
  add column if not exists frequency int,
  add column if not exists pii_detected boolean default false,
  add column if not exists quarantine_until timestamptz,
  add column if not exists distilled_question text;

-- Permite 'auto_distilled' como source_type (FAQ extraida automaticamente).
-- Reaplica o CHECK pra incluir o novo valor.
alter table public.knowledge_documents
  drop constraint if exists knowledge_documents_source_type_check;
alter table public.knowledge_documents
  add constraint knowledge_documents_source_type_check
  check (source_type in ('pdf','url','instagram','text','auto_distilled'));

create index if not exists idx_kdocs_review_status
  on public.knowledge_documents (agent_id, review_status, quarantine_until);

-- ============================================================
-- 2. Tabela de audit das execucoes de distillation
-- ============================================================
create table if not exists public.knowledge_distillation_runs (
  id                  uuid primary key default gen_random_uuid(),
  agent_id            uuid not null references public.agents(id) on delete cascade,
  account_id          text not null references public.accounts(id) on delete cascade,
  started_at          timestamptz not null default now(),
  finished_at         timestamptz,
  conversations_scanned int default 0,
  q_and_a_pairs       int default 0,
  clusters_found      int default 0,
  faqs_extracted      int default 0,
  faqs_auto_approved  int default 0,
  faqs_pending        int default 0,
  faqs_duplicates     int default 0,
  faqs_pii_blocked    int default 0,
  cost_usd            numeric(10,6) default 0,
  tokens_in           int default 0,
  tokens_out          int default 0,
  status              text not null default 'running'
    check (status in ('running','success','failed')),
  error               text
);
create index if not exists idx_kdistill_runs_agent
  on public.knowledge_distillation_runs (agent_id, started_at desc);

-- ============================================================
-- 3. Marca conversas ja processadas (evita reprocessar tudo a cada run)
-- ============================================================
alter table public.conversations
  add column if not exists distilled_until timestamptz;

-- ============================================================
-- 4. Config de distillation por agente (em settings JSON e tambem
--    como columns dedicadas pra facilitar query)
-- ============================================================
alter table public.agents
  add column if not exists distillation_enabled boolean default false,
  add column if not exists distillation_min_frequency int default 5,
  add column if not exists distillation_min_confidence numeric(3,2) default 0.9,
  add column if not exists distillation_quarantine_hours int default 24,
  add column if not exists distillation_max_auto_approve_per_run int default 3,
  add column if not exists distillation_schedule text default 'weekly'
    check (distillation_schedule in ('weekly','daily','manual'));

-- ============================================================
-- 5. Job pg_cron — verifica de hora em hora quais agentes tem
--    distillation_schedule != 'manual' e dispara conforme a janela.
--    O endpoint server-side filtra qual agente esta na hora de rodar.
-- ============================================================
do $$
begin
  if exists (select 1 from cron.job where jobname = 'knowledge-distillation-tick') then
    perform cron.unschedule('knowledge-distillation-tick');
  end if;
end $$;

select cron.schedule(
  'knowledge-distillation-tick',
  '0 3 * * *',  -- 03:00 BRT (06:00 UTC) diariamente. Endpoint decide quem roda.
  $cron$
  select net.http_post(
    url     := current_setting('app.base_url') || '/api/public/cron/knowledge-distiller',
    headers := jsonb_build_object(
      'Content-Type','application/json',
      'x-cron-secret', current_setting('app.cron_secret')
    ),
    body    := '{}'::jsonb,
    timeout_milliseconds := 300000  -- 5min: distillation pode ser longo
  );
  $cron$
);

-- Verificacao
select jobname, schedule, active from cron.job where jobname = 'knowledge-distillation-tick';
