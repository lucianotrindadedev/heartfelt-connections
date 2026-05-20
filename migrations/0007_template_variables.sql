-- Adiciona suporte a variáveis configuráveis nos templates
ALTER TABLE prompt_templates ADD COLUMN IF NOT EXISTS variables JSONB NOT NULL DEFAULT '[]';
