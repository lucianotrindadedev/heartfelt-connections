-- Migração: integração Clinic Experts (clinicaexperts.com.br) — 4º provedor de
-- agenda ao lado de Clinicorp/Clinup/Google Calendar.
--
-- A API do Clinic Experts (GET /professionals) não expõe o expediente de cada
-- profissional — por isso guardamos isso nós mesmos, um item por profissional
-- selecionado, no mesmo espírito do array `agendas` de google_calendar_tokens
-- (ver migrations/0004 e o painel "Google Agendas" no embed). Cada item de
-- `professionals`: { "uuid": "...", "name": "...", "duracao_minutos": 40,
-- "business_hours_json": "{...}" } — mesmo formato semana usado pelo
-- componente BusinessHoursEditor do embed.

create table if not exists public.clinic_experts_config (
  account_id       text primary key references public.accounts(id) on delete cascade,
  api_token_enc    text,                          -- Bearer token encriptado
  procedure_id     integer,                       -- procedimento padrão (available-hours + create-booking)
  procedure_name   text,                          -- rótulo cacheado do procedimento acima
  duracao_consulta int not null default 40,       -- minutos, fallback quando o profissional não tem duração própria
  professionals    jsonb not null default '[]'::jsonb,
  ativo            boolean not null default false,
  atualizado_em    timestamptz not null default now()
);
create trigger trg_clinic_experts_touch before update on public.clinic_experts_config
  for each row execute function public.touch_updated_at();

-- Libera o novo integration_type para o sistema de templates de prompt.
alter table public.prompt_templates drop constraint if exists prompt_templates_integration_type_check;
alter table public.prompt_templates add constraint prompt_templates_integration_type_check
  check (integration_type in ('clinicorp', 'google_calendar', 'clinup', 'clinic_experts'));
