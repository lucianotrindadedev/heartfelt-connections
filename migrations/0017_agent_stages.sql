-- Multi-agent state machine.
--
-- Stages de uma conversa (texto livre por flexibilidade; valores válidos
-- definidos em src/lib/agents/stage.ts):
--   RECEPTION       — primeira mensagem, saudação
--   QUALIFICATION   — SPIN questions, identificação de interesse (UTM)
--   SLOT_OFFER      — listar horários e ofertar
--   NAME_COLLECT    — coletar nome completo + confirmação de compromisso
--   BOOKING         — criar agendamento no sistema da clínica
--   CONFIRMED       — pós-agendamento, agradecimento, aguarda warm-up
--   ESCALATED       — handoff para humano
--
-- lead_data é o "scratch pad" estruturado do agente:
--   { name, interest, selected_slot_iso, dentist_person_id, appointment_id, ... }
--
-- Implementação atual: como o servidor não tem acesso DDL via REST, usamos
-- conversations.meta.stage / conversations.meta.lead_data até que esta
-- migration seja aplicada manualmente. Quando aplicada, o orchestrator
-- migra automaticamente para as colunas dedicadas.

alter table public.conversation_state
  add column if not exists stage text not null default 'RECEPTION',
  add column if not exists lead_data jsonb not null default '{}'::jsonb,
  add column if not exists current_agent text;

create index if not exists conversation_state_stage_idx
  on public.conversation_state (stage)
  where stage in ('QUALIFICATION', 'SLOT_OFFER', 'NAME_COLLECT', 'BOOKING');

comment on column public.conversation_state.stage is
  'Estado da máquina multi-agente. Valores em src/lib/agents/stage.ts';
comment on column public.conversation_state.lead_data is
  'Scratch pad estruturado: name, interest, selected_slot_iso, dentist_person_id, appointment_id.';
comment on column public.conversation_state.current_agent is
  'Qual sub-agente respondeu o último turn (triage|qualifier|scheduler|escalation).';
