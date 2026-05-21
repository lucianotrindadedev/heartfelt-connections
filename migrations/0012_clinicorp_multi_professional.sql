-- Migração: altera dentist_person_id de bigint para jsonb (suporte a múltiplos profissionais)
-- Converte o valor existente (se houver) em array JSON: 123 → [123]

ALTER TABLE public.clinicorp_config
  ALTER COLUMN dentist_person_id TYPE jsonb
    USING CASE
      WHEN dentist_person_id IS NULL THEN NULL
      ELSE jsonb_build_array(dentist_person_id)
    END;

COMMENT ON COLUMN public.clinicorp_config.dentist_person_id IS
  'Array de Person_Id dos profissionais selecionados (ex: [111, 222]). NULL = todos.';
