-- 0008_knowledge_rag.sql
-- Base de Conhecimento (RAG) por agente.
-- Cada agente tem sua própria base. Documentos viram chunks com embedding
-- vetorial para busca por similaridade.

create extension if not exists vector;

-- Documentos fonte (1 doc = 1 PDF, 1 URL, etc).
create table if not exists public.knowledge_documents (
  id              uuid primary key default gen_random_uuid(),
  agent_id        uuid not null references public.agents(id) on delete cascade,
  source_type     text not null check (source_type in ('pdf', 'url', 'instagram', 'text')),
  source_ref      text,                                   -- URL ou nome do arquivo
  title           text,
  status          text not null default 'pending'
                  check (status in ('pending', 'indexing', 'ready', 'failed')),
  content_preview text,                                   -- primeiros ~500 chars
  total_chars     int default 0,
  total_chunks    int default 0,
  error           text,
  criado_em       timestamptz not null default now(),
  atualizado_em   timestamptz not null default now()
);
create index if not exists idx_kdocs_agent on public.knowledge_documents (agent_id, criado_em desc);

-- Chunks vetorizados (embedding 1536d = text-embedding-3-small).
create table if not exists public.knowledge_chunks (
  id          uuid primary key default gen_random_uuid(),
  document_id uuid not null references public.knowledge_documents(id) on delete cascade,
  agent_id    uuid not null references public.agents(id) on delete cascade,
  ordem       int not null,
  chunk_text  text not null,
  token_count int,
  embedding   vector(1536),
  criado_em   timestamptz not null default now()
);
create index if not exists idx_kchunks_doc on public.knowledge_chunks (document_id, ordem);
create index if not exists idx_kchunks_agent on public.knowledge_chunks (agent_id);

-- Índice HNSW para busca por similaridade (cosseno).
-- m=16, ef_construction=64 — defaults equilibrados para coleções até ~1M chunks.
create index if not exists idx_kchunks_embedding_hnsw
  on public.knowledge_chunks
  using hnsw (embedding vector_cosine_ops);

-- Trigger de atualizado_em
create or replace function public.touch_kdoc_updated_at()
returns trigger language plpgsql as $$
begin
  new.atualizado_em = now();
  return new;
end;
$$;
drop trigger if exists trg_kdoc_touch on public.knowledge_documents;
create trigger trg_kdoc_touch before update on public.knowledge_documents
  for each row execute function public.touch_kdoc_updated_at();
