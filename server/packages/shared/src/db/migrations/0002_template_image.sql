-- Add image_url column to agent_templates
ALTER TABLE agent_templates ADD COLUMN IF NOT EXISTS image_url text;
