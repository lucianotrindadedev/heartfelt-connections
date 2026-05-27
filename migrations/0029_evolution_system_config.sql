-- Configuracao GLOBAL da Evolution API (uma unica instalacao do SAAS).
-- Singleton: usa id=1 como chave fixa. RLS off (somente service_role lê/escreve).
--
-- A escalada humana por agente passa a referenciar:
--   * Credenciais (base_url + api_key) → system_evolution_config (esta tabela)
--   * Instancia + grupo de alerta       → agent_escalation.evolution_instance + grupo_alerta
--
-- As colunas agent_escalation.evolution_url e agent_escalation.evolution_key_enc
-- ficam DEPRECADAS (mantidas no banco por retrocompat — codigo nao le mais).

create table if not exists public.system_evolution_config (
  id              int primary key default 1 check (id = 1),
  base_url        text,
  api_key_enc     text,
  api_key_last4   text,
  atualizado_em   timestamptz not null default now()
);

insert into public.system_evolution_config (id)
values (1)
on conflict (id) do nothing;

alter table public.system_evolution_config enable row level security;

drop policy if exists "system_evolution_config_service_role" on public.system_evolution_config;
create policy "system_evolution_config_service_role"
  on public.system_evolution_config
  for all
  to service_role
  using (true)
  with check (true);

comment on table public.system_evolution_config is
  'Credenciais globais da Evolution API do SAAS (singleton id=1). Cada agent_escalation referencia uma instancia + grupo desta Evolution.';
