-- 0035_followup_seq_cron_5min.sql
-- Reagenda o cron de follow-up SEQUÊNCIA para a cada 5 minutos (era 1 minuto).
-- A frequência de 1 min causava ticks sobrepostos (geração contextual passa de
-- 60s) — a duplicação já está coberta pelo lock por conversa, mas 5 min reduz a
-- sobreposição e a carga. Granularidade de 5 min é suficiente para follow-up.

-- Idempotente: desagenda antes de agendar.
do $$
begin
  if exists (select 1 from cron.job where jobname = 'followup-sequence-tick') then
    perform cron.unschedule('followup-sequence-tick');
  end if;
end
$$;

select cron.schedule(
  'followup-sequence-tick',
  '*/5 * * * *', -- a cada 5 minutos
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

-- Verificação
select jobname, schedule, active from cron.job where jobname = 'followup-sequence-tick';
