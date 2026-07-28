-- Migração: múltiplos profissionais no Clinup.
--
-- O Clinup era modelado com UM profissional por conta (`agenda_id`, usado como
-- `profissionalId` nas chamadas). Clínicas reais têm vários — a Implanto Master
-- tem 7 — e a API expõe todos em GET /profissionais:
--   [{"nome":"Ariane Lopes","id":3497}, {"nome":"Eduardo Gomes","id":1057}, …]
--
-- Mesmo formato de `clinic_experts_config.professionals` (migration 0042), com
-- UMA diferença: o identificador do Clinup é um INTEIRO (`id`), não um uuid.
-- Cada item: { "id": 3497, "name": "Ariane Lopes", "duracao_minutos": 30,
-- "business_hours_json": "{...}" } — o business_hours_json é o mesmo formato
-- semana do BusinessHoursEditor do embed.
--
-- Diferença importante em relação ao Clinic Experts: a API do Clinup JÁ devolve
-- os horários livres reais de cada profissional (GET /horas?profissionalId=&data=
-- respeita a agenda dele — medido: profissionais diferentes devolvem grades
-- diferentes, e alguns devolvem vazio). Portanto `business_hours_json` aqui é
-- RESTRIÇÃO opcional ("só ofereça este profissional nestes dias/horas"), não a
-- fonte do expediente. Vazio = confia 100% na API.
--
-- `agenda_id` fica preservado como legado: contas já configuradas com um único
-- profissional continuam funcionando enquanto ninguém preenche `professionals`.

alter table public.clinup_config
  add column if not exists professionals jsonb not null default '[]'::jsonb;

comment on column public.clinup_config.professionals is
  'Profissionais habilitados para o agente: [{id:int, name, duracao_minutos?, business_hours_json?}]. Vazio = usa agenda_id (legado, 1 profissional).';

comment on column public.clinup_config.agenda_id is
  'LEGADO: profissionalId único. Preferir `professionals`. Mantido como fallback para contas antigas.';
