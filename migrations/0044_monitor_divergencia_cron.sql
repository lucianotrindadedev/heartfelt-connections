-- 0044_monitor_divergencia_cron.sql
-- Agenda o monitor de DIVERGÊNCIA de agendamento: audita, 1x/dia, se a data que
-- o agente afirmou ao lead no texto bate com a data efetivamente agendada
-- (booked_slot_iso). Divergências viram telemetria [monitor:telemetry]
-- event="divergencia_agenda" (caso Costa Lima Recreio, Melissa).
--
-- Endpoint: POST /api/public/cron/monitor-divergencia (guardado por x-cron-secret).
-- Reusa app.base_url / app.cron_secret já configurados para os demais crons.
-- ============================================================

do $$
begin
  if exists (select 1 from cron.job where jobname = 'monitor-divergencia-tick') then
    perform cron.unschedule('monitor-divergencia-tick');
  end if;
end $$;

select cron.schedule(
  'monitor-divergencia-tick',
  '30 3 * * *',  -- 03:30 BRT (06:30 UTC) diariamente, logo após a distillation.
  $cron$
  select net.http_post(
    url     := current_setting('app.base_url') || '/api/public/cron/monitor-divergencia',
    headers := jsonb_build_object(
      'Content-Type','application/json',
      'x-cron-secret', current_setting('app.cron_secret')
    ),
    body    := '{"window_days": 3}'::jsonb,
    timeout_milliseconds := 120000  -- 2min
  );
  $cron$
);

-- Verificacao
select jobname, schedule, active from cron.job where jobname = 'monitor-divergencia-tick';
