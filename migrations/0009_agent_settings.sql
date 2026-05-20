-- Adiciona coluna settings JSONB ao agente (perfil básico do assistente)
ALTER TABLE agents ADD COLUMN IF NOT EXISTS settings JSONB NOT NULL DEFAULT '{}';
