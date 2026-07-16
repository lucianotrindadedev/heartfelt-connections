-- 0045_monitor_integracoes_cron.sql
-- Agenda o monitor de SAÚDE das integrações de agenda: verifica, 2x/dia, se as
-- integrações ATIVAS (Google Calendar, Clinicorp, Clinic Experts) ainda
-- respondem. Integração quebrada vira telemetria [monitor:telemetry]
-- event="integracao_agenda_quebrada".
--
-- Motivo: um refresh_token do Google é revogado e MORRE EM SILÊNCIO — o agente
-- só descobre quando um lead pede horário, e ninguém é avisado. Em 16/07/2026,
-- 2 das 5 contas com Google Calendar ativo estavam nesse estado havia dias.
--
-- 2x/dia (e não 1x) porque a janela entre a integração cair e alguém notar é o
-- prejuízo: são horas de leads recebendo "não consegui buscar os horários".
--
-- Endpoint: POST /api/public/cron/monitor-integracoes (guardado por x-cron-secret).
-- Reusa app.base_url / app.cron_secret já configurados para os demais crons.
-- ============================================================

do $$
begin
  if exists (select 1 from cron.job where jobname = 'monitor-integracoes-tick') then
    perform cron.unschedule('monitor-integracoes-tick');
  end if;
end $$;

select cron.schedule(
  'monitor-integracoes-tick',
  '0 11,20 * * *',  -- 08:00 e 17:00 BRT (11:00/20:00 UTC): início e fim do expediente.
  $cron$
  select net.http_post(
    url     := current_setting('app.base_url') || '/api/public/cron/monitor-integracoes',
    headers := jsonb_build_object(
      'Content-Type','application/json',
      'x-cron-secret', current_setting('app.cron_secret')
    ),
    body    := '{}'::jsonb,
    timeout_milliseconds := 120000  -- 2min
  );
  $cron$
);

-- Verificacao
select jobname, schedule, active from cron.job where jobname = 'monitor-integracoes-tick';
