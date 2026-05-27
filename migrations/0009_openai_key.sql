-- 0009_openai_key.sql
-- Permite cada conta ter sua própria chave OpenAI (usada para embeddings do RAG).
-- Antes era só env var do servidor — agora a chave também pode ser por conta.
-- Resolução: account.openai_api_key_enc → env OPENAI_API_KEY (fallback).

alter table public.account_secrets
  add column if not exists openai_api_key_enc bytea,
  add column if not exists openai_last4 text;
