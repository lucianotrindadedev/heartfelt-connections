-- Multicanal: Instagram / Messenger sem telefone na entrada; sessão como chave primária.
-- Se o índice único falhar por duplicatas, rode 0016_deduplicate_conversations_before_session_index.sql

alter table public.conversations
  add column if not exists helena_contact_id text,
  add column if not exists channel text not null default 'whatsapp',
  add column if not exists channel_identifier text,
  add column if not exists lead_phone text;

comment on column public.conversations.phone is 'Identificador interno (telefone BR ou channel:prefix:id)';
comment on column public.conversations.lead_phone is 'WhatsApp coletado ou do CRM — usado no Clinicorp';
comment on column public.conversations.channel is 'whatsapp | instagram | messenger | unknown';

-- Índice criado na 0016 após deduplicação (ou aqui em banco novo sem duplicatas)
-- create unique index idx_conversations_agent_session ...
