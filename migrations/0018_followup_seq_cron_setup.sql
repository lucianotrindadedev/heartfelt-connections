-- 0018_followup_seq_cron_setup.sql
-- Setup completo e idempotente do pg_cron para a sequência de follow-up.
--
-- Rode este arquivo INTEIRO no Supabase SQL Editor. Ele:
--   1. Garante extensões pg_cron + pg_net
--   2. Configura app.base_url e app.cron_secret no DB (PRECISA EDITAR ABAIXO)
--   3. (Re)agenda o job followup-sequence-tick a cada 1 minuto
--   4. Faz um disparo de teste imediato
--   5. Cria view cron_jobs_view pra inspecionar via PostgREST

-- ============================================================
-- 1. EXTENSÕES (idempotente — só cria se não existir)
-- ============================================================
create extension if not exists pg_cron;
create extension if not exists pg_net;

-- ============================================================
-- 2. SETTINGS DO BANCO  ⚠️  EDITE AS DUAS LINHAS ABAIXO  ⚠️
--    (deixe os valores reais — não use placeholders)
-- ============================================================
alter database postgres
  set app.base_url = 'https://mjh4librzxgo4lr2grblb0p6.72.62.104.184.sslip.io';

alter database postgres
  set app.cron_secret = 'c408fbfb2ed53b5b85b41f38087e69e7d2cad5664fcb4307';

-- Importante: ALTER DATABASE só pega para NOVAS sessões. Force reload das settings
-- de jobs já agendados desagendando e reagendando (passo 3).

-- ============================================================
-- 3. (RE)AGENDA o job — desagenda se existir, depois agenda
-- ============================================================
do $$
begin
  if exists (select 1 from cron.job where jobname = 'followup-sequence-tick') then
    perform cron.unschedule('followup-sequence-tick');
  end if;
end
$$;

select cron.schedule(
  'followup-sequence-tick',
  '* * * * *', -- a cada 1 minuto (era */5; agora 1 pra granularidade fina)
  $cron$
  select net.http_post(
    url     := current_setting('app.base_url') || '/api/public/cron/followup-sequence',
    headers := jsonb_build_object(
      'Content-Type','application/json',
      'x-cron-secret', current_setting('app.cron_secret')
    ),
    body    := '{}'::jsonb,
    timeout_milliseconds := 30000
  );
  $cron$
);

-- ============================================================
-- 4. DISPARO IMEDIATO DE TESTE
--    (não espera 1 minuto pelo cron — manda agora)
-- ============================================================
select net.http_post(
  url     := current_setting('app.base_url') || '/api/public/cron/followup-sequence',
  headers := jsonb_build_object(
    'Content-Type','application/json',
    'x-cron-secret', current_setting('app.cron_secret')
  ),
  body    := '{}'::jsonb,
  timeout_milliseconds := 30000
) as test_request_id;

-- ============================================================
-- 5. VIEW DE INSPEÇÃO (expõe cron.job via PostgREST)
-- ============================================================
create or replace view public.cron_jobs_view as
select jobid, jobname, schedule, active, database, command
from cron.job;

grant select on public.cron_jobs_view to anon, authenticated, service_role;

-- ============================================================
-- 6. VERIFICAÇÕES — rode estes selects depois pra confirmar
-- ============================================================
-- a) job agendado e ativo?
select jobname, schedule, active from cron.job where jobname = 'followup-sequence-tick';

-- b) settings carregadas? (deve retornar a URL e o secret)
select current_setting('app.base_url') as base_url,
       current_setting('app.cron_secret') as cron_secret;

-- c) últimas execuções do job — sucesso / erro / mensagem
select start_time, status, return_message
from cron.job_run_details
where jobid = (select jobid from cron.job where jobname = 'followup-sequence-tick')
order by start_time desc
limit 10;

-- d) últimas chamadas HTTP feitas pelo pg_net (resposta do servidor)
--    Versão 1: pg_net moderno (>= 0.8) usa net._http_response + join na fila
select
  r.id,
  r.created,
  q.url,
  r.status_code,
  r.content_type,
  left(r.content::text, 200) as content_preview,
  r.timed_out,
  r.error_msg
from net._http_response r
left join net.http_request_queue q on q.id = r.id
order by r.created desc
limit 10;

-- Se a query acima der erro de coluna/tabela inexistente, use UMA das alternativas:
-- (sem informação de URL — só pra confirmar que houve resposta HTTP)
--   select id, created, status_code, timed_out, error_msg,
--          left(coalesce(content::text, ''), 200) as content_preview
--   from net._http_response order by created desc limit 10;
-- ou descubra as colunas reais com:
--   select column_name from information_schema.columns
--   where table_schema='net' and table_name='_http_response';
