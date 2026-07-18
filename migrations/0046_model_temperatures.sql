-- 0046_model_temperatures.sql
-- Temperatura POR MODELO (por conta), inclusive nos modelos de fallback.
-- Mapa jsonb { "<model_id>": <temperatura 0..2> }, ex.:
--   { "google/gemini-3.5-flash": 0.3, "openai/gpt-4.1-mini": 0.2 }
-- Quando um modelo NÃO está no mapa, usa account_llm_config.temperature
-- (temperatura padrão da conta). A chave é o model id do OpenRouter e vale
-- tanto para o modelo principal quanto para os de fallback (a resolução é
-- feita por modelo em cada chamada LLM).
alter table public.account_llm_config
  add column if not exists model_temperatures jsonb not null default '{}'::jsonb;

comment on column public.account_llm_config.model_temperatures is
  'Temperatura por modelo (chave = model id OpenRouter, ex.: "openai/gpt-4.1-mini"). Aplica-se ao modelo principal e aos de fallback. Modelo ausente usa a coluna temperature (padrão da conta).';
