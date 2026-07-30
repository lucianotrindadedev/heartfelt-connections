-- 0050_credit_guard.sql
-- Estado do SALDO da OpenRouter por conta.
--
-- Motivo: quando o saldo da chave acaba, a OpenRouter devolve 402 e TODA chamada
-- do agente falha. Antes, o orquestrador tratava isso como qualquer outro erro e
-- mandava ao lead "Desculpe, tive uma instabilidade técnica" — o cliente da
-- clínica lia isso como bug do produto, e ninguém era avisado do saldo.
--
-- Agora a falta de saldo NÃO fala com o lead: o contato é etiquetado
-- "IA Desligada" (atendente humana assume) e um alerta vai ao grupo de
-- notificações. Esta tabela serve para (a) não repetir o mesmo alerta a cada
-- mensagem que chega (cooldown por tipo de alerta) e (b) guardar o último saldo
-- lido pelo monitor preventivo (cron monitor-saldo).
--
-- Uma linha por conta. Nada aqui bloqueia a IA sozinho — o bloqueio real é a
-- etiqueta no contato, que a atendente remove quando o saldo volta.

create table if not exists public.account_credit_state (
  account_id              text primary key references public.accounts(id) on delete cascade,
  -- Última vez que uma chamada falhou por falta de saldo (402).
  last_sem_saldo_at       timestamptz,
  -- Último alerta "saldo esgotado" enviado ao grupo (cooldown de 30min).
  last_alert_sem_saldo_at timestamptz,
  -- Último alerta "saldo baixo" enviado ao grupo (cooldown de 12h).
  last_alert_baixo_at     timestamptz,
  -- Saldo em USD na última leitura do monitor preventivo.
  last_balance_usd        numeric,
  -- Mensagem crua do último erro de saldo (truncada) — diagnóstico.
  last_error              text,
  atualizado_em           timestamptz not null default now()
);

create trigger trg_account_credit_state_touch before update on public.account_credit_state
  for each row execute function public.touch_updated_at();
