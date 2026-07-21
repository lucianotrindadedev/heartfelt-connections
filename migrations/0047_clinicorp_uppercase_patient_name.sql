-- Opção "cadastrar nome do paciente em MAIÚSCULAS" no Clinicorp.
-- Uma das clínicas exige que o título do agendamento (que é o nome do paciente)
-- seja gravado todo em letra maiúscula. Quando ligado, o nome enviado ao criar o
-- paciente no Clinicorp vai em UPPERCASE; desligado (padrão), mantém como veio.
-- Afeta só o que é gravado no Clinicorp — a mensagem de confirmação ao lead
-- continua com o nome normal.

alter table public.clinicorp_config
  add column if not exists uppercase_patient_name boolean not null default false;
