-- 0012_agent_media.sql
-- Mídias do agente (imagens, vídeos, áudios) que ele pode enviar durante
-- conversa via tool 'enviar_midia'. Arquivos ficam no Supabase Storage.

create table if not exists public.agent_media (
  id           uuid primary key default gen_random_uuid(),
  agent_id     uuid not null references public.agents(id) on delete cascade,
  -- 'slug' curto e único por agente — usado pelo LLM ('antes_depois_implante')
  slug         text not null,
  -- Título humano e descrição de quando usar (entra no contexto do LLM)
  title        text not null,
  description  text,
  -- URL pública (Supabase Storage). Se for Google Drive no futuro, ainda
  -- precisamos resolver para URL pública antes de mandar para a Helena.
  file_url     text not null,
  -- Caminho no bucket (para deletar quando for excluído da UI)
  storage_path text,
  mime_type    text,
  file_size    int,
  width        int,
  height       int,
  duration_s   int,
  -- Tipo lógico (image, video, audio, document) — derivado do mime mas
  -- mantido aqui para facilitar UI sem reparse.
  media_type   text not null default 'image' check (media_type in ('image','video','audio','document')),
  criado_em    timestamptz not null default now(),
  atualizado_em timestamptz not null default now()
);

-- slug único por agente
create unique index if not exists uq_agent_media_slug
  on public.agent_media (agent_id, slug);
create index if not exists idx_agent_media_agent
  on public.agent_media (agent_id, criado_em desc);

drop trigger if exists trg_agent_media_touch on public.agent_media;
create trigger trg_agent_media_touch before update on public.agent_media
  for each row execute function public.touch_updated_at();

-- Histórico de envios (auditoria + idempotência)
create table if not exists public.agent_media_sends (
  id              uuid primary key default gen_random_uuid(),
  media_id        uuid not null references public.agent_media(id) on delete cascade,
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  agent_id        uuid not null references public.agents(id) on delete cascade,
  sent_at         timestamptz not null default now(),
  status          text not null default 'sent',
  error           text,
  caption         text
);
create index if not exists idx_media_sends_conv
  on public.agent_media_sends (conversation_id, sent_at desc);
