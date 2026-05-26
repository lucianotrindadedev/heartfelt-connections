-- 0024_default_gemini_flash.sql
-- Migra modelo padrao para Google Gemini 2.5 Flash. Remove o
-- x-ai/grok-4-fast que foi deprecado pela xAI (causa 404 da OpenRouter
-- com a mensagem 'Grok 4 Fast is deprecated').
--
-- Novo padrao:
--   default_model   = google/gemini-2.5-flash       (rapido, barato, bom em PT-BR)
--   splitter_model  = google/gemini-2.5-flash
--   formatter_model = google/gemini-2.5-flash
--   fallback_models = [openai/gpt-4o-mini, anthropic/claude-haiku-4.5]
--   rag_gate_model  = google/gemini-2.5-flash
--
-- Fallback chain diversifica providers (Google → OpenAI → Anthropic),
-- evitando que uma queda do Google deixe a conta inteira sem agente.

-- ============================================================
-- 1. Atualiza os DEFAULTS das colunas (afeta novas contas)
-- ============================================================
alter table public.account_llm_config
  alter column default_model    set default 'google/gemini-2.5-flash',
  alter column splitter_model   set default 'google/gemini-2.5-flash',
  alter column formatter_model  set default 'google/gemini-2.5-flash',
  alter column fallback_models  set default array['openai/gpt-4o-mini', 'anthropic/claude-haiku-4.5']::text[],
  alter column rag_gate_model   set default 'google/gemini-2.5-flash';

-- ============================================================
-- 2. Atualiza registros EXISTENTES que estao com o modelo deprecado
-- ============================================================
update public.account_llm_config
   set default_model = 'google/gemini-2.5-flash'
 where default_model = 'x-ai/grok-4-fast' or default_model is null;

update public.account_llm_config
   set splitter_model = 'google/gemini-2.5-flash'
 where splitter_model = 'x-ai/grok-4-fast' or splitter_model is null;

update public.account_llm_config
   set formatter_model = 'google/gemini-2.5-flash'
 where formatter_model = 'x-ai/grok-4-fast' or formatter_model is null;

update public.account_llm_config
   set rag_gate_model = 'google/gemini-2.5-flash'
 where rag_gate_model = 'x-ai/grok-4-fast' or rag_gate_model is null;

-- Remove x-ai/grok-4-fast de quaisquer fallback chains existentes;
-- substitui por claude-haiku-4.5 se a chain ficar curta demais.
update public.account_llm_config
   set fallback_models = (
     select coalesce(array_agg(m), array[]::text[])
       from unnest(fallback_models) m
      where m <> 'x-ai/grok-4-fast'
   )
 where 'x-ai/grok-4-fast' = any(fallback_models);

-- Se algum registro ficou com fallback vazio apos a limpeza, restaura
-- a chain padrao.
update public.account_llm_config
   set fallback_models = array['openai/gpt-4o-mini', 'anthropic/claude-haiku-4.5']::text[]
 where fallback_models is null
    or cardinality(fallback_models) = 0;

-- ============================================================
-- 3. Verificacao
-- ============================================================
select account_id, default_model, fallback_models, rag_gate_model
from public.account_llm_config
order by account_id
limit 50;
