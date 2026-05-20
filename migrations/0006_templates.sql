-- Tabela de templates de prompt para o painel de treinamento
CREATE TABLE IF NOT EXISTS prompt_templates (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  nome            TEXT        NOT NULL,
  descricao       TEXT        NOT NULL DEFAULT '',
  cover_url       TEXT,
  system_prompt   TEXT        NOT NULL DEFAULT '',
  integration_type TEXT,          -- NULL | 'clinicorp' | 'google_calendar' | 'clinup'
  categoria       TEXT        NOT NULL DEFAULT 'geral',
  ordem           INT         NOT NULL DEFAULT 0,
  ativo           BOOLEAN     NOT NULL DEFAULT true,
  criado_em       TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em   TIMESTAMPTZ NOT NULL DEFAULT now()
);
