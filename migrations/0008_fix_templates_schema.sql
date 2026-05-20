-- Alinha colunas do prompt_templates com o código da aplicação
ALTER TABLE prompt_templates
  RENAME COLUMN conteudo TO system_prompt;
ALTER TABLE prompt_templates
  RENAME COLUMN imagem_destaque_url TO cover_url;
ALTER TABLE prompt_templates
  ADD COLUMN IF NOT EXISTS integration_type TEXT CHECK (integration_type IN ('clinicorp','google_calendar','clinup')) DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS categoria TEXT NOT NULL DEFAULT 'geral',
  ADD COLUMN IF NOT EXISTS ordem INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS ativo BOOLEAN NOT NULL DEFAULT true;
