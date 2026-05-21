-- Migração: separa Code Link (agenda_id) de Dentist_PersonId na clinicorp_config
-- agenda_id = Code Link da agenda online (liberação de horários por API)
-- dentist_person_id = ID do profissional selecionado para filtrar agendamentos

ALTER TABLE public.clinicorp_config
  ADD COLUMN IF NOT EXISTS dentist_person_id bigint;  -- opcional: Dentist_PersonId do profissional

-- agenda_id permanece como Code Link (sem remoção para não quebrar dados existentes)
COMMENT ON COLUMN public.clinicorp_config.agenda_id IS 'Code Link da agenda online (liberação de horários por API)';
COMMENT ON COLUMN public.clinicorp_config.dentist_person_id IS 'Person_Id do profissional selecionado (opcional, filtra agenda)';
