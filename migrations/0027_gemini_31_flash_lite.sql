-- 0027_gemini_31_flash_lite.sql
-- Padroniza Gemini 2.5 Flash → Gemini 3.1 Flash Lite (GA, OpenRouter).

-- Novos defaults em account_llm_config
alter table public.account_llm_config
  alter column default_model    set default 'google/gemini-3.1-flash-lite',
  alter column splitter_model   set default 'google/gemini-3.1-flash-lite',
  alter column formatter_model  set default 'google/gemini-3.1-flash-lite',
  alter column rag_gate_model   set default 'google/gemini-3.1-flash-lite';

-- Contas existentes ainda no 2.5 Flash (ou preview do 3.1 Lite)
update public.account_llm_config
   set default_model = 'google/gemini-3.1-flash-lite'
 where default_model in (
   'google/gemini-2.5-flash',
   'google/gemini-2.5-flash-lite',
   'google/gemini-3.1-flash-lite-preview'
 );

update public.account_llm_config
   set splitter_model = 'google/gemini-3.1-flash-lite'
 where splitter_model in (
   'google/gemini-2.5-flash',
   'google/gemini-2.5-flash-lite',
   'google/gemini-3.1-flash-lite-preview'
 );

update public.account_llm_config
   set formatter_model = 'google/gemini-3.1-flash-lite'
 where formatter_model in (
   'google/gemini-2.5-flash',
   'google/gemini-2.5-flash-lite',
   'google/gemini-3.1-flash-lite-preview'
 );

update public.account_llm_config
   set rag_gate_model = 'google/gemini-3.1-flash-lite'
 where rag_gate_model in (
   'google/gemini-2.5-flash',
   'google/gemini-2.5-flash-lite',
   'google/gemini-3.1-flash-lite-preview'
 );

-- Override por agente
update public.agents
   set llm_model_override = 'google/gemini-3.1-flash-lite'
 where llm_model_override in (
   'google/gemini-2.5-flash',
   'google/gemini-2.5-flash-lite',
   'google/gemini-3.1-flash-lite-preview'
 );

-- Substitui slugs legados em cadeias de fallback
update public.account_llm_config
   set fallback_models = (
     select coalesce(array_agg(
       case
         when m in (
           'google/gemini-2.5-flash',
           'google/gemini-2.5-flash-lite',
           'google/gemini-3.1-flash-lite-preview'
         ) then 'google/gemini-3.1-flash-lite'
         else m
       end
     ), '{}'::text[])
     from unnest(fallback_models) as m
   )
 where fallback_models && array[
   'google/gemini-2.5-flash',
   'google/gemini-2.5-flash-lite',
   'google/gemini-3.1-flash-lite-preview'
 ]::text[];

select account_id, default_model, splitter_model, rag_gate_model
  from public.account_llm_config
 order by account_id;
