-- 0020_warmup_seq_cron.sql
-- Agenda execução do cron de warm-up SEQUÊNCIA a cada 5 minutos.
-- O endpoint /api/public/cron/warmup-sequence varre os steps e dispara
-- os templates Helena.

-- Idempotente: desagenda antes de agendar.
do $$
begin
  if exists (select 1 from cron.job where jobname = 'warmup-sequence-tick') then
    perform cron.unschedule('warmup-sequence-tick');
  end if;
end $$;

select cron.schedule(
  'warmup-sequence-tick',
  '*/5 * * * *',
  $cron$
  select net.http_post(
    url     := current_setting('app.base_url') || '/api/public/cron/warmup-sequence',
    headers := jsonb_build_object(
      'Content-Type','application/json',
      'x-cron-secret', current_setting('app.cron_secret')
    ),
    body    := '{}'::jsonb,
    timeout_milliseconds := 60000
  );
  $cron$
);

-- Verificação
select jobname, schedule, active from cron.job where jobname = 'warmup-sequence-tick';
