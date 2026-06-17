-- 0034_default_models.sql
-- Defaults de LLM para NOVOS agentes/contas (account_llm_config).
-- Pedido do produto:
--   default_model   = google/gemini-3.5-flash
--   splitter_model  = openai/gpt-4.1-mini
--   formatter_model = openai/gpt-4.1-mini
--   rag_gate_model  = openai/gpt-4.1-mini
--   tool_model      = openai/gpt-4.1-mini
--   fallback_models = [openai/gpt-4.1-mini]
--
-- Só altera o DEFAULT das colunas (vale para linhas novas). NÃO toca em contas
-- existentes — quem já configurou seus modelos continua como está.

alter table public.account_llm_config
  alter column default_model    set default 'google/gemini-3.5-flash',
  alter column splitter_model   set default 'openai/gpt-4.1-mini',
  alter column formatter_model  set default 'openai/gpt-4.1-mini',
  alter column rag_gate_model   set default 'openai/gpt-4.1-mini',
  alter column tool_model       set default 'openai/gpt-4.1-mini',
  alter column fallback_models  set default array['openai/gpt-4.1-mini']::text[];
