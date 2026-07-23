-- 0048_retomar_slot_offer_cron.sql
-- Gatilho de RETOMADA de conversas paradas em SLOT_OFFER.
--
-- O agente só age quando CHEGA mensagem do lead. Quando ele termina um turno
-- prometendo algo ("deixa eu verificar e já te mostro") sem chamar a tool,
-- ninguém o re-aciona e a conversa morre em silêncio — o lead fica esperando
-- horários que nunca chegam (caso Odonto Carioca Campo Grande, 21 98817-7687).
--
-- 1) coluna de controle anti-loop em conversation_state
-- 2) agendamento pg_cron do endpoint que re-executa o turno
--
-- Endpoint: POST /api/public/cron/retomar-slot-offer (guardado por x-cron-secret).
-- Reusa app.base_url / app.cron_secret já configurados para os demais crons.
-- ============================================================

-- 1. Contador de retomadas por conversa (teto no endpoint, default 1).
--    Fica em conversation_state (e não em conversations.meta) porque o turno do
--    agente reescreve o meta inteiro e apagaria o contador.
alter table public.conversation_state
  add column if not exists retomadas_slot_offer int not null default 0;

comment on column public.conversation_state.retomadas_slot_offer is
  'Quantas vezes o cron de retomada re-acionou o agente nesta conversa (anti-loop).';

-- 2. Agendamento: a cada 10 min, das 8h às 21h BRT (11–24 UTC) — mesma janela
--    de atendimento do followup-tick, para não retomar conversa de madrugada.
do $$
begin
  if exists (select 1 from cron.job where jobname = 'retomar-slot-offer-tick') then
    perform cron.unschedule('retomar-slot-offer-tick');
  end if;
end $$;

select cron.schedule(
  'retomar-slot-offer-tick',
  '*/10 11-23 * * *',  -- a cada 10 min, 08:00–20:59 BRT
  $cron$
  select net.http_post(
    url     := current_setting('app.base_url') || '/api/public/cron/retomar-slot-offer',
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
select jobname, schedule, active from cron.job where jobname = 'retomar-slot-offer-tick';
