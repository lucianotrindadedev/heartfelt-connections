-- Migração: corrige tipo das colunas *_enc de BYTEA → TEXT
-- Raiz do problema: pgp_sym_encrypt_b64 retorna TEXT (base64), que era
-- armazenado em coluna BYTEA. O Supabase JS lia o BYTEA como '\x<hex>',
-- que passado ao decode(..., 'base64') do PostgreSQL gerava:
-- "invalid symbol '\' found while decoding base64 sequence"
--
-- A cláusula USING convert_from(col, 'UTF8') converte os bytes armazenados
-- (que são os bytes ASCII da string base64) de volta para TEXT.
-- Valores já criptografados com o formato antigo permanecem válidos.

-- ── accounts ──────────────────────────────────────────────────────────
ALTER TABLE public.accounts
  ALTER COLUMN helena_token_enc TYPE TEXT
    USING CASE WHEN helena_token_enc IS NULL THEN NULL
               ELSE convert_from(helena_token_enc, 'UTF8') END;

-- ── account_secrets ───────────────────────────────────────────────────
ALTER TABLE public.account_secrets
  ALTER COLUMN openrouter_api_key_enc TYPE TEXT
    USING CASE WHEN openrouter_api_key_enc IS NULL THEN NULL
               ELSE convert_from(openrouter_api_key_enc, 'UTF8') END,
  ALTER COLUMN elevenlabs_api_key_enc TYPE TEXT
    USING CASE WHEN elevenlabs_api_key_enc IS NULL THEN NULL
               ELSE convert_from(elevenlabs_api_key_enc, 'UTF8') END,
  ALTER COLUMN groq_api_key_enc TYPE TEXT
    USING CASE WHEN groq_api_key_enc IS NULL THEN NULL
               ELSE convert_from(groq_api_key_enc, 'UTF8') END,
  ALTER COLUMN evolution_api_key_enc TYPE TEXT
    USING CASE WHEN evolution_api_key_enc IS NULL THEN NULL
               ELSE convert_from(evolution_api_key_enc, 'UTF8') END;

-- ── google_calendar_tokens ────────────────────────────────────────────
ALTER TABLE public.google_calendar_tokens
  ALTER COLUMN access_token_enc TYPE TEXT
    USING CASE WHEN access_token_enc IS NULL THEN NULL
               ELSE convert_from(access_token_enc, 'UTF8') END,
  ALTER COLUMN refresh_token_enc TYPE TEXT
    USING CASE WHEN refresh_token_enc IS NULL THEN NULL
               ELSE convert_from(refresh_token_enc, 'UTF8') END;

-- ── clinicorp_config ──────────────────────────────────────────────────
ALTER TABLE public.clinicorp_config
  ALTER COLUMN api_token_enc TYPE TEXT
    USING CASE WHEN api_token_enc IS NULL THEN NULL
               ELSE convert_from(api_token_enc, 'UTF8') END;

-- ── clinup_config ─────────────────────────────────────────────────────
ALTER TABLE public.clinup_config
  ALTER COLUMN api_token_enc TYPE TEXT
    USING CASE WHEN api_token_enc IS NULL THEN NULL
               ELSE convert_from(api_token_enc, 'UTF8') END;

-- ── agent_escalation ──────────────────────────────────────────────────
ALTER TABLE public.agent_escalation
  ALTER COLUMN evolution_key_enc TYPE TEXT
    USING CASE WHEN evolution_key_enc IS NULL THEN NULL
               ELSE convert_from(evolution_key_enc, 'UTF8') END;
