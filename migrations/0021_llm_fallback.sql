-- 0021_llm_fallback.sql
-- Cadeia de modelos fallback + modelo do RAG Gate.

alter table account_llm_config
  add column if not exists fallback_models text[] default
    array['openai/gpt-4o-mini', 'x-ai/grok-4-fast']::text[],
  add column if not exists rag_gate_model text default 'x-ai/grok-4-fast';

comment on column account_llm_config.fallback_models is
  'Lista ordenada de modelos a tentar se o default_model falhar (5xx, timeout, content vazio).';
comment on column account_llm_config.rag_gate_model is
  'Modelo barato usado pelo RAG Gate pra decidir se a mensagem precisa de busca na base de conhecimento.';
