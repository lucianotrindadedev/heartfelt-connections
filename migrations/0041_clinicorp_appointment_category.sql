-- Categoria de Agendamento do Clinicorp (cor + descrição).
-- O painel de integração passa a permitir escolher UMA categoria de agendamento
-- (endpoint GET /appointment/list_categories → [{ id, Description, Color }]). O
-- create_appointment_by_api passa a enviar CategoryColor + CategoryDescription
-- da categoria selecionada, para o agendamento aparecer com a cor correta na
-- agenda do Clinicorp.
--
-- Guardamos os três valores (id p/ o seletor saber o que está escolhido;
-- description + color p/ o create enviar direto, sem uma chamada extra por
-- agendamento). Seleção ÚNICA — diferente de dentist_person_id (jsonb array).

alter table public.clinicorp_config
  add column if not exists category_id          text,
  add column if not exists category_description text,
  add column if not exists category_color       text;
