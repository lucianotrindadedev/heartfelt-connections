-- Add clinicexpress to integration_type enum
ALTER TYPE integration_type ADD VALUE IF NOT EXISTS 'clinicexpress';

-- Create agent_templates table
CREATE TABLE IF NOT EXISTS agent_templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL,
  description TEXT,
  integration_key TEXT NOT NULL,
  required_integrations JSONB NOT NULL DEFAULT '[]'::jsonb,
  optional_integrations JSONB NOT NULL DEFAULT '[]'::jsonb,
  default_tools JSONB NOT NULL DEFAULT '[]'::jsonb,
  default_prompt TEXT NOT NULL DEFAULT '',
  tool_instructions TEXT NOT NULL DEFAULT '',
  followup_defaults JSONB NOT NULL DEFAULT '{}'::jsonb,
  warmup_defaults JSONB NOT NULL DEFAULT '{}'::jsonb,
  credential_fields JSONB NOT NULL DEFAULT '[]'::jsonb,
  enabled BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Seed templates
INSERT INTO agent_templates (key, label, description, integration_key, required_integrations, optional_integrations, default_tools, credential_fields, followup_defaults, warmup_defaults)
VALUES
  ('clinicorp_dental', 'Clínica [Clinicorp]', 'Template para clínicas que usam o software Clinicorp', 'clinicorp',
   '["helena_crm", "clinicorp", "openrouter"]'::jsonb,
   '["google_drive", "elevenlabs", "evolution_api", "central360", "groq"]'::jsonb,
   '["refletir", "listar_tags", "add_tags", "buscar_paciente", "criar_paciente", "buscar_horarios", "criar_agendamento", "buscar_agendamentos", "cancelar_agendamento", "buscar_status", "alterar_status", "escalar_humano", "listar_arquivos", "enviar_arquivo"]'::jsonb,
   '[
     {"key": "api_token", "label": "Token API (Base64)", "type": "password", "required": true, "placeholder": "Ex: bWFnbnVtOm..."},
     {"key": "subscriber_id", "label": "Subscriber ID", "type": "text", "required": true, "placeholder": "Ex: magnum"},
     {"key": "business_id", "label": "Business ID", "type": "text", "required": true, "placeholder": "Ex: 5576666615382016"},
     {"key": "code_link", "label": "Code Link (Agendamento Online)", "type": "text", "required": true, "placeholder": "Ex: 43855"},
     {"key": "agenda_id", "label": "ID do Profissional/Agenda", "type": "text", "required": false, "placeholder": "Ex: 5652391183777792"}
   ]'::jsonb,
   '{"cron": "*/10 8-21 * * *", "max": 2, "follow_ups_horas": [1, 5]}'::jsonb,
   '{"wu1": 96, "wu2": 72, "wu3": 48, "wu4": 24, "wu5": 2}'::jsonb
  ),
  ('clinicexpress', 'Clínica [Clinic Express]', 'Template para clínicas que usam o Clinic Express', 'clinicexpress',
   '["helena_crm", "clinicexpress", "openrouter"]'::jsonb,
   '["google_drive", "elevenlabs", "evolution_api", "central360", "groq"]'::jsonb,
   '["refletir", "listar_tags", "add_tags", "ce_buscar_paciente", "ce_criar_paciente", "ce_buscar_horarios", "ce_criar_agendamento", "ce_buscar_agendamentos", "ce_remarcar", "ce_cancelar", "escalar_humano", "listar_arquivos", "enviar_arquivo"]'::jsonb,
   '[
     {"key": "token", "label": "Token API", "type": "password", "required": true, "placeholder": "Ex: h1OuGgHpS0..."}
   ]'::jsonb,
   '{"cron": "*/10 8-21 * * *", "max": 2, "follow_ups_horas": [1, 5]}'::jsonb,
   '{"wu1": 96, "wu2": 72, "wu3": 48, "wu4": 24, "wu5": 2}'::jsonb
  ),
  ('clinup', 'Clínica [Clinup]', 'Template para clínicas que usam o Sistema Clinup', 'clinup',
   '["helena_crm", "clinup", "openrouter"]'::jsonb,
   '["google_drive", "elevenlabs", "evolution_api", "central360", "groq"]'::jsonb,
   '["refletir", "listar_tags", "add_tags", "cu_buscar_paciente", "cu_criar_paciente", "cu_buscar_datas", "cu_buscar_horarios", "cu_criar_consulta", "cu_buscar_consultas", "cu_gerir_consultas", "escalar_humano", "listar_arquivos", "enviar_arquivo"]'::jsonb,
   '[
     {"key": "api_token", "label": "Token API", "type": "password", "required": true, "placeholder": "Ex: 4465c73f-ff06-..."},
     {"key": "profissional_id", "label": "ID do Profissional", "type": "text", "required": false, "placeholder": "ID do profissional padrão"}
   ]'::jsonb,
   '{"cron": "*/10 8-21 * * *", "max": 2, "follow_ups_horas": [1, 5]}'::jsonb,
   '{"wu1": 96, "wu2": 72, "wu3": 48, "wu4": 24, "wu5": 2}'::jsonb
  ),
  ('google_calendar', 'Clínica [Google Agenda]', 'Template para clínicas que usam Google Calendar', 'google_calendar',
   '["helena_crm", "google_calendar", "openrouter"]'::jsonb,
   '["google_drive", "elevenlabs", "evolution_api", "central360", "groq"]'::jsonb,
   '["refletir", "listar_tags", "add_tags", "gc_buscar_eventos", "gc_criar_evento", "gc_cancelar_evento", "gc_buscar_horarios_livres", "escalar_humano", "listar_arquivos", "enviar_arquivo"]'::jsonb,
   '[
     {"key": "oauth", "label": "Conta Google", "type": "google_oauth", "required": true, "description": "Conecte sua conta Google para acessar o Calendar"},
     {"key": "calendar_id", "label": "ID da Agenda", "type": "text", "required": true, "placeholder": "Ex: primary ou email@gmail.com"}
   ]'::jsonb,
   '{"cron": "*/10 8-21 * * *", "max": 2, "follow_ups_horas": [1, 5]}'::jsonb,
   '{"wu1": 96, "wu2": 72, "wu3": 48, "wu4": 24, "wu5": 2}'::jsonb
  )
ON CONFLICT (key) DO NOTHING;
