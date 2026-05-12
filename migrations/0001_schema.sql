-- Promptfy / Helena — schema completo (self-hosted Supabase)
-- Cole no SQL Editor do seu Supabase self-hosted (uma única vez).
-- RLS desligado em todas as tabelas: tudo é acessado pelo service_role no servidor TanStack.

create extension if not exists pgcrypto;

-- ============================================================
-- HELPERS
-- ============================================================
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.atualizado_em = now();
  return new;
end$$;

-- ============================================================
-- ACCOUNTS
-- ============================================================
create table if not exists public.accounts (
  id              text primary key,                 -- = id_conta Helena
  nome            text not null,
  helena_base_url text,
  helena_token_enc bytea,                           -- pgp_sym_encrypt
  criado_em       timestamptz not null default now(),
  atualizado_em   timestamptz not null default now()
);
create trigger trg_accounts_touch before update on public.accounts
  for each row execute function public.touch_updated_at();

-- ============================================================
-- SECRETS POR CONTA (OpenRouter / ElevenLabs / Groq / Evolution)
-- ============================================================
create table if not exists public.account_secrets (
  account_id              text primary key references public.accounts(id) on delete cascade,
  openrouter_api_key_enc  bytea,
  openrouter_last4        text,
  elevenlabs_api_key_enc  bytea,
  elevenlabs_last4        text,
  groq_api_key_enc        bytea,
  groq_last4              text,
  evolution_api_key_enc   bytea,
  evolution_last4         text,
  atualizado_em           timestamptz not null default now()
);
create trigger trg_secrets_touch before update on public.account_secrets
  for each row execute function public.touch_updated_at();

-- ============================================================
-- CONFIG LLM POR CONTA
-- ============================================================
create table if not exists public.account_llm_config (
  account_id      text primary key references public.accounts(id) on delete cascade,
  default_model   text not null default 'x-ai/grok-4-fast',
  splitter_model  text not null default 'x-ai/grok-4-fast',
  formatter_model text not null default 'x-ai/grok-4-fast',
  max_tokens      int  not null default 1024,
  temperature     numeric not null default 0.7,
  atualizado_em   timestamptz not null default now()
);
create trigger trg_llm_touch before update on public.account_llm_config
  for each row execute function public.touch_updated_at();

-- ============================================================
-- CONFIG VOZ POR CONTA (ElevenLabs)
-- ============================================================
create table if not exists public.account_voice_config (
  account_id          text primary key references public.accounts(id) on delete cascade,
  elevenlabs_voice_id text,
  model_id            text not null default 'eleven_turbo_v2_5',
  stability           numeric not null default 0.5,
  similarity          numeric not null default 0.75,
  style               numeric not null default 0,
  speaker_boost       boolean not null default true,
  atualizado_em       timestamptz not null default now()
);
create trigger trg_voice_touch before update on public.account_voice_config
  for each row execute function public.touch_updated_at();

-- ============================================================
-- AGENTS (1 por conta no MVP)
-- ============================================================
create table if not exists public.agents (
  id                  uuid primary key default gen_random_uuid(),
  account_id          text not null references public.accounts(id) on delete cascade,
  nome                text not null default 'Assistente Virtual',
  ativo               boolean not null default true,
  system_prompt       text not null default '',
  llm_model_override  text,
  webhook_secret      text not null default encode(gen_random_bytes(24),'hex'),
  template_id         uuid,
  imagem_destaque_url text,
  criado_em           timestamptz not null default now(),
  atualizado_em       timestamptz not null default now(),
  unique (account_id)
);
create trigger trg_agents_touch before update on public.agents
  for each row execute function public.touch_updated_at();

-- ============================================================
-- TEMPLATES (admin)
-- ============================================================
create table if not exists public.prompt_templates (
  id              uuid primary key default gen_random_uuid(),
  nome            text not null,
  descricao       text,
  conteudo        text not null default '',
  imagem_destaque_url text,
  criado_em       timestamptz not null default now(),
  atualizado_em   timestamptz not null default now()
);
create trigger trg_templates_touch before update on public.prompt_templates
  for each row execute function public.touch_updated_at();

-- ============================================================
-- FOLLOW-UP
-- ============================================================
create table if not exists public.agent_followup (
  agent_id        uuid primary key references public.agents(id) on delete cascade,
  ativo           boolean not null default false,
  delay_minutos   int not null default 30,
  max_tentativas  int not null default 3,
  prompts         text[] not null default array[]::text[],
  atualizado_em   timestamptz not null default now()
);
create trigger trg_followup_touch before update on public.agent_followup
  for each row execute function public.touch_updated_at();

-- ============================================================
-- WARM-UP (Clinicorp / agendamentos)
-- ============================================================
create table if not exists public.agent_warmup (
  agent_id        uuid primary key references public.agents(id) on delete cascade,
  ativo           boolean not null default false,
  wu1_horas_antes int not null default 72,  prompt_wu1 text default '',
  wu2_horas_antes int not null default 48,  prompt_wu2 text default '',
  wu3_horas_antes int not null default 24,  prompt_wu3 text default '',
  wu4_horas_antes int not null default 4,   prompt_wu4 text default '',
  wu5_horas_antes int not null default 1,   prompt_wu5 text default '',
  atualizado_em   timestamptz not null default now()
);
create trigger trg_warmup_touch before update on public.agent_warmup
  for each row execute function public.touch_updated_at();

create table if not exists public.warmup_sent (
  id              uuid primary key default gen_random_uuid(),
  account_id      text not null references public.accounts(id) on delete cascade,
  appointment_id  text not null,
  reminder_type   text not null,                    -- WU1..WU5
  enviado_em      timestamptz not null default now(),
  unique (account_id, appointment_id, reminder_type)
);

-- ============================================================
-- ÁUDIO (transcrição / TTS)
-- ============================================================
create table if not exists public.agent_audio (
  agent_id        uuid primary key references public.agents(id) on delete cascade,
  habilitado      boolean not null default false,
  transcrever_in  boolean not null default true,    -- Groq Whisper
  responder_out   boolean not null default false,   -- ElevenLabs TTS
  atualizado_em   timestamptz not null default now()
);
create trigger trg_audio_touch before update on public.agent_audio
  for each row execute function public.touch_updated_at();

-- ============================================================
-- WHATSAPP (Evolution API)
-- ============================================================
create table if not exists public.channels_whatsapp (
  agent_id        uuid primary key references public.agents(id) on delete cascade,
  status          text not null default 'desconectado',  -- desconectado | conectando | conectado
  evolution_url   text,
  instance_name   text,
  numero          text,
  qrcode          text,
  atualizado_em   timestamptz not null default now()
);
create trigger trg_wa_touch before update on public.channels_whatsapp
  for each row execute function public.touch_updated_at();

-- ============================================================
-- FILAS DE TRANSFERÊNCIA
-- ============================================================
create table if not exists public.queues (
  id              uuid primary key default gen_random_uuid(),
  agent_id        uuid not null references public.agents(id) on delete cascade,
  nome            text not null,
  descricao       text,
  ativo           boolean not null default true,
  criado_em       timestamptz not null default now()
);

-- ============================================================
-- WEB CHAT
-- ============================================================
create table if not exists public.webchat_config (
  agent_id        uuid primary key references public.agents(id) on delete cascade,
  habilitado      boolean not null default false,
  token_publico   text not null default encode(gen_random_bytes(16),'hex'),
  cor_primaria    text not null default '#2563eb',
  titulo          text not null default 'Atendimento',
  mensagem_inicial text not null default 'Olá! Como posso ajudar?',
  atualizado_em   timestamptz not null default now()
);
create trigger trg_webchat_touch before update on public.webchat_config
  for each row execute function public.touch_updated_at();

-- ============================================================
-- MÍDIA / BASE DE CONHECIMENTO
-- ============================================================
create table if not exists public.media_assets (
  id              uuid primary key default gen_random_uuid(),
  agent_id        uuid not null references public.agents(id) on delete cascade,
  nome            text not null,
  url             text not null,
  tipo            text,                              -- image | doc | audio | video
  tamanho_bytes   bigint,
  criado_em       timestamptz not null default now()
);

-- ============================================================
-- CONVERSAS / MENSAGENS / ESTADO
-- ============================================================
create table if not exists public.conversations (
  id                uuid primary key default gen_random_uuid(),
  agent_id          uuid not null references public.agents(id) on delete cascade,
  phone             text not null,
  helena_session_id text,
  status            text not null default 'ativa',
  meta              jsonb not null default '{}'::jsonb,
  criado_em         timestamptz not null default now(),
  atualizado_em     timestamptz not null default now(),
  unique (agent_id, phone)
);
create trigger trg_conv_touch before update on public.conversations
  for each row execute function public.touch_updated_at();

create table if not exists public.messages (
  id              uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  role            text not null,                     -- user | assistant | system
  content         text not null default '',
  audio_url       text,
  meta            jsonb not null default '{}'::jsonb,
  criado_em       timestamptz not null default now()
);
create index if not exists idx_messages_conv_time on public.messages (conversation_id, criado_em desc);

create table if not exists public.conversation_state (
  conversation_id       uuid primary key references public.conversations(id) on delete cascade,
  lock_conversa         boolean not null default false,
  aguardando_followup   boolean not null default false,
  numero_followup       int not null default 0,
  last_user_message_at  timestamptz,
  last_followup_at      timestamptz,
  atualizado_em         timestamptz not null default now()
);
create trigger trg_state_touch before update on public.conversation_state
  for each row execute function public.touch_updated_at();

-- ============================================================
-- LOG DE EXECUÇÕES (LLM / TTS / STT) — base de custos
-- ============================================================
create table if not exists public.agent_runs (
  id                 uuid primary key default gen_random_uuid(),
  account_id         text not null references public.accounts(id) on delete cascade,
  agent_id           uuid references public.agents(id) on delete set null,
  conversation_id    uuid references public.conversations(id) on delete set null,
  provider           text not null,                  -- openrouter | elevenlabs | groq
  model              text,
  latency_ms         int,
  tokens_in          int,
  tokens_out         int,
  cost_usd_estimate  numeric(10,6) default 0,
  error              text,
  criado_em          timestamptz not null default now()
);
create index if not exists idx_runs_account_time on public.agent_runs (account_id, criado_em desc);

-- ============================================================
-- VIEW DE CUSTO DIÁRIO
-- ============================================================
create or replace view public.llm_usage_daily as
  select
    account_id,
    date_trunc('day', criado_em)::date as dia,
    provider,
    count(*)                          as requests,
    sum(coalesce(tokens_in,0))        as tokens_in,
    sum(coalesce(tokens_out,0))       as tokens_out,
    sum(coalesce(cost_usd_estimate,0)) as cost_usd
  from public.agent_runs
  group by 1,2,3;

-- ============================================================
-- FUNÇÕES DE CRYPTO (chaves de API por conta)
-- ============================================================
-- Use sempre via SQL com a chave em sessão:
--   set local app.pgcrypto_key = '<PGCRYPTO_KEY>';
-- O servidor TanStack faz isso a cada conexão.

create or replace function public.enc(plain text)
returns bytea language sql stable as $$
  select pgp_sym_encrypt(plain, current_setting('app.pgcrypto_key'))
$$;

create or replace function public.dec(cipher bytea)
returns text language sql stable as $$
  select case when cipher is null then null
              else pgp_sym_decrypt(cipher, current_setting('app.pgcrypto_key'))
         end
$$;

-- ============================================================
-- RPCs DE CRIPTOGRAFIA (chave passada como parâmetro)
-- O servidor TanStack chama via supabase.rpc() passando PGCRYPTO_KEY.
-- ============================================================
create or replace function public.pgp_sym_encrypt_b64(plain text, key text)
returns text language sql stable as $$
  select encode(pgp_sym_encrypt(plain, key), 'base64')
$$;

create or replace function public.pgp_sym_decrypt_b64(cipher_b64 text, key text)
returns text language sql stable as $$
  select case when cipher_b64 is null or cipher_b64 = '' then null
              else pgp_sym_decrypt(decode(cipher_b64,'base64'), key)
         end
$$;
