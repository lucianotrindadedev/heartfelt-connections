-- Notificações de agendamento via Evolution API.
--
-- Reusa a mesma config da escalada humana (agent_escalation.evolution_instance
-- + grupo_alerta), adicionando um toggle independente para ligar/desligar as
-- notificações de agendamento sem afetar a escalada humana.
--
-- Quando um agendamento é confirmado (appointment_id criado), o orquestrador
-- envia uma mensagem para o grupo configurado, se notificar_agendamentos=true.

alter table public.agent_escalation
  add column if not exists notificar_agendamentos boolean not null default false;

comment on column public.agent_escalation.notificar_agendamentos is
  'Se true, envia notificação ao grupo (evolution_instance + grupo_alerta) quando um agendamento é confirmado/cancelado/remarcado.';
