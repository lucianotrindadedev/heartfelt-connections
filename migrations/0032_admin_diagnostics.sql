-- Funções de diagnóstico para o painel admin (somente service_role).
-- Tamanho do banco, tamanho por tabela e consumo agregado por conta
-- (joins feitos no Postgres — messages → conversations → agents → account).

-- Tamanho total do banco (bytes)
create or replace function public.admin_db_size()
returns bigint
language sql
security definer
set search_path = public
as $$
  select pg_database_size(current_database());
$$;

-- Top tabelas por tamanho total (dados + índices)
create or replace function public.admin_table_sizes()
returns table(
  table_name   text,
  total_bytes  bigint,
  total_pretty text,
  row_estimate bigint
)
language sql
security definer
set search_path = public
as $$
  select
    c.relname::text,
    pg_total_relation_size(c.oid)::bigint,
    pg_size_pretty(pg_total_relation_size(c.oid)),
    c.reltuples::bigint
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind = 'r'
  order by pg_total_relation_size(c.oid) desc
  limit 25;
$$;

-- Consumo agregado por conta (conversas, mensagens, turns LLM, custo, atividade)
create or replace function public.admin_account_usage()
returns table(
  account_id    text,
  nome          text,
  conversations bigint,
  messages      bigint,
  agent_runs    bigint,
  cost_usd      numeric,
  last_activity timestamptz
)
language sql
security definer
set search_path = public
as $$
  select
    a.id::text,
    a.nome::text,
    (select count(*) from conversations c
       join agents ag on ag.id = c.agent_id
      where ag.account_id = a.id),
    (select count(*) from messages m
       join conversations c on c.id = m.conversation_id
       join agents ag on ag.id = c.agent_id
      where ag.account_id = a.id),
    (select count(*) from agent_runs r where r.account_id = a.id),
    coalesce((select sum(cost_usd_estimate) from agent_runs r where r.account_id = a.id), 0),
    (select max(criado_em) from agent_runs r where r.account_id = a.id)
  from accounts a
  order by 5 desc;
$$;

grant execute on function public.admin_db_size()        to service_role;
grant execute on function public.admin_table_sizes()    to service_role;
grant execute on function public.admin_account_usage()  to service_role;
