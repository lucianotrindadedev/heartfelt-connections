-- 0011_followup_sequence_cron.sql
-- Agenda execução do cron de follow-up SEQUÊNCIA a cada 5 minutos.
-- O endpoint /api/public/cron/followup-sequence verifica todos os steps
-- elegíveis e dispara as mensagens.

select cron.unschedule('followup-sequence-tick') where exists (
  select 1 from cron.job where jobname = 'followup-sequence-tick'
);

select cron.schedule(
  'followup-sequence-tick',
  '*/5 * * * *',
  $$
  select net.http_post(
    url     := current_setting('app.base_url') || '/api/public/cron/followup-sequence',
    headers := jsonb_build_object('Content-Type','application/json','x-cron-secret', current_setting('app.cron_secret')),
    body    := '{}'::jsonb
  );
  $$
);
