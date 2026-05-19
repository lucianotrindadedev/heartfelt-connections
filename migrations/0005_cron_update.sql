-- Migração: Atualizar/criar jobs pg_cron para fila, follow-up e warm-up
-- Requer extensões pg_cron e pg_net ativas no Supabase.
-- Execute após 0004_tools_integrations.sql

-- Defina a variável de ambiente CRON_SECRET no seu servidor TanStack e
-- substitua <BASE_URL> pela URL pública da aplicação (ex: https://sarai.exemplo.com.br)
-- ou configure app.base_url no PostgreSQL:
--   ALTER DATABASE postgres SET app.base_url = 'https://sarai.exemplo.com.br';
--   ALTER DATABASE postgres SET app.cron_secret = 'seu_cron_secret_aqui';

-- ============================================================
-- REMOVER JOBS ANTIGOS SE EXISTIREM
-- ============================================================
select cron.unschedule('followup-tick') where exists (
  select 1 from cron.job where jobname = 'followup-tick'
);
select cron.unschedule('warmup-tick') where exists (
  select 1 from cron.job where jobname = 'warmup-tick'
);

-- ============================================================
-- PROCESSADOR DA FILA DE MENSAGENS (a cada 1 minuto)
-- ============================================================
select cron.schedule(
  'queue-tick',
  '* * * * *',
  $$
  select net.http_post(
    url     := current_setting('app.base_url') || '/api/public/cron/queue',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', current_setting('app.cron_secret')
    ),
    body    := '{}'::jsonb
  )
  $$
);

-- ============================================================
-- FOLLOW-UP (a cada 10 minutos, das 8h às 21h)
-- ============================================================
select cron.schedule(
  'followup-tick',
  '*/10 8-21 * * *',
  $$
  select net.http_post(
    url     := current_setting('app.base_url') || '/api/public/cron/followup',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', current_setting('app.cron_secret')
    ),
    body    := '{}'::jsonb
  )
  $$
);

-- ============================================================
-- WARM-UP (a cada 10 minutos, das 7h às 21h)
-- ============================================================
select cron.schedule(
  'warmup-tick',
  '*/10 7-21 * * *',
  $$
  select net.http_post(
    url     := current_setting('app.base_url') || '/api/public/cron/warmup',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', current_setting('app.cron_secret')
    ),
    body    := '{}'::jsonb
  )
  $$
);
