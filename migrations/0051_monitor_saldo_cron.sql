-- 0051_monitor_saldo_cron.sql
-- Agenda o monitor PREVENTIVO de saldo da OpenRouter: 2x/dia lê o saldo da
-- chave de cada conta e avisa o grupo de notificações quando cai abaixo do
-- limite (padrão US$ 5 — ajustável em OPENROUTER_LOW_BALANCE_USD).
--
-- Motivo: com o saldo zerado TODA chamada do agente falha. O corte que silencia
-- a IA e chama a atendente (ver 0050_credit_guard.sql) só age depois que algum
-- lead já ficou sem resposta automática — este aviso chega antes disso.
--
-- Mesmo horário do monitor de integrações: início e fim do expediente.
-- Endpoint: POST /api/public/cron/monitor-saldo (guardado por x-cron-secret).
-- ============================================================

do $$
begin
  if exists (select 1 from cron.job where jobname = 'monitor-saldo-tick') then
    perform cron.unschedule('monitor-saldo-tick');
  end if;
end $$;

select cron.schedule(
  'monitor-saldo-tick',
  '0 11,20 * * *',  -- 08:00 e 17:00 BRT (11:00/20:00 UTC)
  $cron$
  select net.http_post(
    url     := current_setting('app.base_url') || '/api/public/cron/monitor-saldo',
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
select jobname, schedule, active from cron.job where jobname = 'monitor-saldo-tick';
