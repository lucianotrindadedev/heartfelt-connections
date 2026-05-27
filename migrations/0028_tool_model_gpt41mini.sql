-- 0028_tool_model_gpt41mini.sql
-- Modelo dedicado para tool calling no scheduler (GPT-4.1 mini).

alter table public.account_llm_config
  add column if not exists tool_model text default 'openai/gpt-4.1-mini';

comment on column public.account_llm_config.tool_model is
  'Modelo OpenRouter para tool calling (scheduler: listar_horarios, criar_agendamento). Reply continua em default_model.';

update public.account_llm_config
   set tool_model = 'openai/gpt-4.1-mini'
 where tool_model is null
    or tool_model in (
      'google/gemini-2.5-flash',
      'google/gemini-2.5-flash-lite',
      'google/gemini-3.1-flash-lite',
      'google/gemini-3.1-flash-lite-preview'
    );

select account_id, default_model, tool_model, splitter_model
  from public.account_llm_config
 order by account_id;
