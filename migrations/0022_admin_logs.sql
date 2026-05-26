-- 0022_admin_logs.sql
-- View unificada para o painel admin enxergar tudo que aconteceu numa conta:
-- turnos de agente, envios de follow-up e envios de warm-up.
--
-- Cada linha tem: tipo, status, timestamp, modelo, tokens, custo, erro.
-- Usado pelo admin pra debugar conta sem precisar SSH no servidor.

drop view if exists public.admin_logs_view;

create view public.admin_logs_view as
-- 1. Turnos de agente (qualifier/scheduler)
select
  ar.id::text                            as id,
  'agent_turn'::text                     as kind,
  ar.account_id                          as account_id,
  ar.agent_id                            as agent_id,
  ar.conversation_id                     as conversation_id,
  case
    when ar.error is null then 'success'
    else 'failed'
  end                                    as status,
  ar.criado_em                           as created_at,
  ar.model                               as model,
  ar.provider                            as provider,
  ar.latency_ms                          as latency_ms,
  coalesce(ar.tokens_in, 0)              as tokens_in,
  coalesce(ar.tokens_out, 0)             as tokens_out,
  coalesce(ar.cost_usd_estimate, 0)::numeric as cost_usd,
  ar.error                               as error,
  null::text                             as detail
from public.agent_runs ar

union all

-- 2. Follow-up sequence runs
select
  fsr.id::text                           as id,
  'followup'::text                       as kind,
  a.account_id                           as account_id,
  fsr.agent_id                           as agent_id,
  fsr.conversation_id                    as conversation_id,
  fsr.status                             as status,
  fsr.sent_at                            as created_at,
  null::text                             as model,
  'helena'::text                         as provider,
  null::int                              as latency_ms,
  0::int                                 as tokens_in,
  0::int                                 as tokens_out,
  0::numeric                             as cost_usd,
  fsr.error                              as error,
  fsr.message_sent                       as detail
from public.followup_step_runs fsr
left join public.agents a on a.id = fsr.agent_id

union all

-- 3. Warm-up sends (template Helena por antecedência da consulta)
select
  ws.id::text                            as id,
  'warmup'::text                         as kind,
  ws.account_id                          as account_id,
  ws.agent_id                            as agent_id,
  null::uuid                             as conversation_id,
  ws.status                              as status,
  ws.sent_at                             as created_at,
  null::text                             as model,
  'helena_template'::text                as provider,
  null::int                              as latency_ms,
  0::int                                 as tokens_in,
  0::int                                 as tokens_out,
  0::numeric                             as cost_usd,
  ws.error                               as error,
  concat(
    'paciente=', coalesce(ws.patient_name, '—'),
    ' phone=', coalesce(ws.patient_phone, '—'),
    ' source=', ws.source,
    ' template_id=', coalesce(ws.helena_template_id, '—')
  )                                      as detail
from public.warmup_sends ws;

-- Exponibiliza via PostgREST (apenas service_role já tem; libera service+admin via Sarai)
grant select on public.admin_logs_view to anon, authenticated, service_role;

-- View agregada de custo diário corrigida (a antiga usava nomes diferentes
-- dos que o painel admin lê). DROP+CREATE porque CREATE OR REPLACE não
-- permite renomear colunas existentes.
drop view if exists public.llm_usage_daily;

create view public.llm_usage_daily as
  select
    account_id,
    date_trunc('day', criado_em)::date as day,
    date_trunc('day', criado_em)::date as dia,  -- alias retrocompat
    provider,
    count(*)                                       as requests,
    sum(coalesce(tokens_in,0))                     as tokens_in_sum,
    sum(coalesce(tokens_out,0))                    as tokens_out_sum,
    sum(coalesce(tokens_in,0) + coalesce(tokens_out,0)) as total_tokens,
    sum(coalesce(cost_usd_estimate,0))             as total_cost_usd,
    sum(coalesce(cost_usd_estimate,0))             as cost_usd  -- alias retrocompat
  from public.agent_runs
  group by 1,2,3,4;

grant select on public.llm_usage_daily to anon, authenticated, service_role;
