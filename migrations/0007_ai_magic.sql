-- 0007_ai_magic.sql
-- Histórico de solicitações ao AI Magic (assistente de edição de prompt).
-- Cada linha = 1 pedido do usuário + resposta do assistente.

create table if not exists public.ai_magic_requests (
  id uuid primary key default gen_random_uuid(),
  account_id text not null references public.accounts(id) on delete cascade,
  agent_id uuid not null references public.agents(id) on delete cascade,

  -- Solicitação do usuário
  user_message text not null,

  -- Snapshot do prompt no momento do pedido (para auditoria)
  prompt_before text not null,

  -- Resposta do assistente
  summary text,                          -- resumo curto das mudanças
  proposed_prompt text,                  -- prompt completo proposto
  sections_changed jsonb default '[]'::jsonb, -- lista de seções alteradas
  reasoning text,                        -- 1-2 frases explicando

  -- Estado
  applied boolean not null default false,
  applied_at timestamptz,

  -- Métricas LLM
  model text,
  tokens_in int,
  tokens_out int,
  cost_usd numeric,
  latency_ms int,

  -- Erros (se houver)
  error text,

  criado_em timestamptz not null default now()
);

create index if not exists idx_ai_magic_agent on public.ai_magic_requests (agent_id, criado_em desc);
create index if not exists idx_ai_magic_account on public.ai_magic_requests (account_id, criado_em desc);
