-- 0040_clinicorp_agenda_id_text.sql
-- O "Code Link" da agenda online do Clinicorp pode ser ALFANUMÉRICO (ex.: "bomfim"),
-- mas a coluna agenda_id estava como bigint → salvar um code_link com letras dava
-- "invalid input syntax for type bigint". O código já lê o valor como string
-- (String(agenda_id) → code_link na URL), então trocar para text é seguro.

alter table clinicorp_config
  alter column agenda_id type text using agenda_id::text;
