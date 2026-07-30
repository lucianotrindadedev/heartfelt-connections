-- Migração: integração Google Sheets — planilhas como fonte de consulta do
-- agente (tabela de preços, procedimentos, convênios...).
--
-- Por que uma tabela/token PRÓPRIOS em vez de reaproveitar google_calendar_tokens:
--   1. O refresh_token já salvo foi emitido só com escopos de Calendar. O Google
--      não adiciona escopo a um token existente — ler planilha exige consentimento
--      novo. Guardar aqui evita obrigar TODA conta conectada a reconectar a agenda.
--   2. Conta que não usa Google Calendar (ex.: MF Beauty, que agenda no Clinic
--      Experts) precisa da planilha sem ligar o `ativo` da agenda — que é o flag
--      que injeta as tools de agendamento do GCal.
-- As credenciais do app (GOOGLE_CLIENT_ID/SECRET/REDIRECT) são as MESMAS.
--
-- `planilhas`: array de { "label": "Preços", "spreadsheet_id": "1AbC...",
-- "aba": "Tabela!A1:F500", "descricao": "Tabela de preços dos procedimentos" }
-- Mesmo espírito do array `agendas` de google_calendar_tokens (migrations/0033):
-- o `label` vira enum na tool e a `descricao` explica ao agente quando usar cada uma.

create table if not exists public.google_sheets_config (
  account_id        text primary key references public.accounts(id) on delete cascade,
  access_token_enc  text,
  refresh_token_enc text,
  email             text,                            -- conta Google que autorizou (só p/ exibir na UI)
  planilhas         jsonb not null default '[]'::jsonb,
  expires_at        timestamptz,
  ativo             boolean not null default false,
  atualizado_em     timestamptz not null default now()
);

create trigger trg_google_sheets_touch before update on public.google_sheets_config
  for each row execute function public.touch_updated_at();
