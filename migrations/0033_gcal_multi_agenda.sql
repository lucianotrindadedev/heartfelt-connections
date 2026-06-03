-- Múltiplas agendas no Google Calendar.
--
-- Hoje cada conta usa UM calendário (google_calendar_tokens.calendar_id).
-- Esta coluna permite o agente escolher entre VÁRIAS agendas conforme a
-- situação descrita no prompt (ex: "Consultório" vs "Telemedicina").
--
-- Formato (array de objetos):
--   [
--     { "label": "Consultório",  "calendar_id": "abc@group.calendar.google.com",
--       "descricao": "consultas presenciais e exames de imagem" },
--     { "label": "Telemedicina", "calendar_id": "xyz@group.calendar.google.com",
--       "descricao": "retornos e segunda opinião online" }
--   ]
--
-- Back-compat: vazio ([]) → o agente usa calendar_id (comportamento atual,
-- agenda única). 1 item → agenda única (sem necessidade de escolha). 2+ itens
-- → o agente recebe o parâmetro `agenda` (enum dos labels) e decide qual usar.

alter table public.google_calendar_tokens
  add column if not exists agendas jsonb not null default '[]'::jsonb;

comment on column public.google_calendar_tokens.agendas is
  'Lista de agendas selecionadas [{label, calendar_id, descricao}]. Vazio = usa calendar_id (agenda única). 2+ = agente escolhe via parâmetro agenda conforme o prompt.';
