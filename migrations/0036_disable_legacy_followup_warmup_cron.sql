-- 0036 — Desativa os crons ANTIGOS de follow-up/warm-up.
--
-- Os jobs 'followup-tick' (cron/followup) e 'warmup-tick' (cron/warmup) eram a
-- implementação legada (tabelas agent_followup/agent_warmup). Foram substituídos
-- pelos jobs '*-sequence-tick' (tabelas followup_steps/warmup_steps), mas ambos
-- continuavam agendados — rodando em paralelo e podendo enviar mensagens
-- duplicadas. Nenhum agente usa mais as configs antigas (agent_followup/
-- agent_warmup ativos = 0), então é seguro remover os ticks legados.
--
-- Idempotente: só desagenda se o job existir.

do $$
begin
  if exists (select 1 from cron.job where jobname = 'followup-tick') then
    perform cron.unschedule('followup-tick');
  end if;
  if exists (select 1 from cron.job where jobname = 'warmup-tick') then
    perform cron.unschedule('warmup-tick');
  end if;
end $$;
