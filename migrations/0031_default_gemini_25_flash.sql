-- 0031_default_gemini_25_flash.sql
-- Reverte o padrão dos agentes: Gemini 3.1 Flash Lite → Gemini 2.5 Flash.
-- (Inverte o que a 0027 fez.) Atinge default da coluna + contas existentes
-- que estavam no 3.1 Flash Lite + cadeias de fallback.

-- Novos defaults em account_llm_config
alter table public.account_llm_config
  alter column default_model    set default 'google/gemini-2.5-flash',
  alter column splitter_model   set default 'google/gemini-2.5-flash',
  alter column formatter_model  set default 'google/gemini-2.5-flash',
  alter column rag_gate_model   set default 'google/gemini-2.5-flash';

-- Contas existentes no 3.1 Flash Lite → 2.5 Flash
update public.account_llm_config
   set default_model = 'google/gemini-2.5-flash'
 where default_model in ('google/gemini-3.1-flash-lite', 'google/gemini-3.1-flash-lite-preview');

update public.account_llm_config
   set splitter_model = 'google/gemini-2.5-flash'
 where splitter_model in ('google/gemini-3.1-flash-lite', 'google/gemini-3.1-flash-lite-preview');

update public.account_llm_config
   set formatter_model = 'google/gemini-2.5-flash'
 where formatter_model in ('google/gemini-3.1-flash-lite', 'google/gemini-3.1-flash-lite-preview');

update public.account_llm_config
   set rag_gate_model = 'google/gemini-2.5-flash'
 where rag_gate_model in ('google/gemini-3.1-flash-lite', 'google/gemini-3.1-flash-lite-preview');

-- Override por agente
update public.agents
   set llm_model_override = 'google/gemini-2.5-flash'
 where llm_model_override in ('google/gemini-3.1-flash-lite', 'google/gemini-3.1-flash-lite-preview');

-- Substitui slugs legados nas cadeias de fallback
update public.account_llm_config
   set fallback_models = (
     select coalesce(array_agg(
       case
         when m in ('google/gemini-3.1-flash-lite', 'google/gemini-3.1-flash-lite-preview')
           then 'google/gemini-2.5-flash'
         else m
       end
     ), '{}'::text[])
     from unnest(fallback_models) as m
   )
 where fallback_models && array[
   'google/gemini-3.1-flash-lite',
   'google/gemini-3.1-flash-lite-preview'
 ]::text[];
