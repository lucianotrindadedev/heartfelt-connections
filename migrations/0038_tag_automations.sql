-- 0038_tag_automations.sql
-- Automações de etiqueta (tag → ação) configuráveis pelo dono do agente.
--
-- Caso de uso: "quando a etiqueta X for adicionada ao contato no CRM Helena,
-- adicionar o contato na sequência (cadência) Y". O disparo vem de um webhook
-- dedicado (/api/public/webhook/helena-automation/$accountId) que o usuário
-- registra no CRM Helena. A avaliação RECARREGA as tags atuais do contato via
-- API, então independe do shape exato do evento — basta um identificador
-- (contactId, sessionId ou telefone).

create table if not exists agent_tag_automations (
  id uuid primary key default gen_random_uuid(),
  agent_id uuid not null references agents(id) on delete cascade,
  enabled boolean not null default true,

  -- Gatilho: nome da etiqueta no CRM (comparação sem acento/caixa).
  trigger_tag text not null,

  -- Ação. Por ora só 'add_to_sequence' (extensível: 'remove_from_sequence' etc).
  action_type text not null default 'add_to_sequence'
    check (action_type in ('add_to_sequence', 'remove_from_sequence')),

  -- Alvo: sequência (cadência) Helena. id é usado na API; name é denormalizado
  -- só para exibir na UI sem refazer o fetch.
  sequence_id text,
  sequence_name text,

  criado_em timestamptz default now(),
  atualizado_em timestamptz default now()
);

create index if not exists agent_tag_automations_agent
  on agent_tag_automations(agent_id);
create index if not exists agent_tag_automations_enabled
  on agent_tag_automations(agent_id) where enabled = true;

-- Log + dedupe de execuções. UNIQUE(automation_id, contact_id) garante que a
-- mesma regra só dispara UMA vez por contato (evita re-adicionar à sequência a
-- cada evento de webhook).
create table if not exists tag_automation_runs (
  id uuid primary key default gen_random_uuid(),
  automation_id uuid not null references agent_tag_automations(id) on delete cascade,
  agent_id uuid not null,
  contact_id text not null,
  trigger_tag text,
  status text not null,            -- 'done' | 'failed'
  error text,
  executed_at timestamptz default now()
);

create unique index if not exists tag_automation_runs_dedupe
  on tag_automation_runs(automation_id, contact_id) where status = 'done';
create index if not exists tag_automation_runs_agent_time
  on tag_automation_runs(agent_id, executed_at desc);
