-- Corrige duplicatas (agent_id, helena_session_id) antes do índice único da 0015.
-- Rode se a 0015 falhou em: idx_conversations_agent_session

-- Garante colunas da 0015 (idempotente se já rodou parcialmente)
alter table public.conversations
  add column if not exists helena_contact_id text,
  add column if not exists channel text not null default 'whatsapp',
  add column if not exists channel_identifier text,
  add column if not exists lead_phone text;

-- Ranking: mantém a conversa com mais mensagens; desempate por atualizado_em
with ranked as (
  select
    c.id,
    c.agent_id,
    c.helena_session_id,
    row_number() over (
      partition by c.agent_id, c.helena_session_id
      order by
        (select count(*)::bigint from public.messages m where m.conversation_id = c.id) desc,
        c.atualizado_em desc nulls last,
        c.criado_em desc nulls last,
        c.id asc
    ) as rn
  from public.conversations c
  where c.helena_session_id is not null
    and btrim(c.helena_session_id) <> ''
),
pairs as (
  select
    k.id as keep_id,
    d.id as drop_id
  from ranked k
  join ranked d
    on d.agent_id = k.agent_id
   and d.helena_session_id = k.helena_session_id
   and d.rn > 1
   and k.rn = 1
)
-- Mensagens → conversa mantida
update public.messages m
set conversation_id = p.keep_id
from pairs p
where m.conversation_id = p.drop_id;

with ranked as (
  select
    c.id,
    c.agent_id,
    c.helena_session_id,
    row_number() over (
      partition by c.agent_id, c.helena_session_id
      order by
        (select count(*)::bigint from public.messages m where m.conversation_id = c.id) desc,
        c.atualizado_em desc nulls last,
        c.criado_em desc nulls last,
        c.id asc
    ) as rn
  from public.conversations c
  where c.helena_session_id is not null
    and btrim(c.helena_session_id) <> ''
),
pairs as (
  select k.id as keep_id, d.id as drop_id
  from ranked k
  join ranked d
    on d.agent_id = k.agent_id
   and d.helena_session_id = k.helena_session_id
   and d.rn > 1
   and k.rn = 1
)
update public.message_queue mq
set conversation_id = p.keep_id
from pairs p
where mq.conversation_id = p.drop_id;

with ranked as (
  select
    c.id,
    c.agent_id,
    c.helena_session_id,
    row_number() over (
      partition by c.agent_id, c.helena_session_id
      order by
        (select count(*)::bigint from public.messages m where m.conversation_id = c.id) desc,
        c.atualizado_em desc nulls last,
        c.criado_em desc nulls last,
        c.id asc
    ) as rn
  from public.conversations c
  where c.helena_session_id is not null
    and btrim(c.helena_session_id) <> ''
),
pairs as (
  select k.id as keep_id, d.id as drop_id
  from ranked k
  join ranked d
    on d.agent_id = k.agent_id
   and d.helena_session_id = k.helena_session_id
   and d.rn > 1
   and k.rn = 1
)
update public.agent_runs ar
set conversation_id = p.keep_id
from pairs p
where ar.conversation_id = p.drop_id;

-- conversation_state: PK = conversation_id — move ou remove duplicata
with ranked as (
  select
    c.id,
    c.agent_id,
    c.helena_session_id,
    row_number() over (
      partition by c.agent_id, c.helena_session_id
      order by
        (select count(*)::bigint from public.messages m where m.conversation_id = c.id) desc,
        c.atualizado_em desc nulls last,
        c.criado_em desc nulls last,
        c.id asc
    ) as rn
  from public.conversations c
  where c.helena_session_id is not null
    and btrim(c.helena_session_id) <> ''
),
pairs as (
  select k.id as keep_id, d.id as drop_id
  from ranked k
  join ranked d
    on d.agent_id = k.agent_id
   and d.helena_session_id = k.helena_session_id
   and d.rn > 1
   and k.rn = 1
)
delete from public.conversation_state cs
using pairs p
where cs.conversation_id = p.drop_id
  and exists (
    select 1 from public.conversation_state k where k.conversation_id = p.keep_id
  );

with ranked as (
  select
    c.id,
    c.agent_id,
    c.helena_session_id,
    row_number() over (
      partition by c.agent_id, c.helena_session_id
      order by
        (select count(*)::bigint from public.messages m where m.conversation_id = c.id) desc,
        c.atualizado_em desc nulls last,
        c.criado_em desc nulls last,
        c.id asc
    ) as rn
  from public.conversations c
  where c.helena_session_id is not null
    and btrim(c.helena_session_id) <> ''
),
pairs as (
  select k.id as keep_id, d.id as drop_id
  from ranked k
  join ranked d
    on d.agent_id = k.agent_id
   and d.helena_session_id = k.helena_session_id
   and d.rn > 1
   and k.rn = 1
)
update public.conversation_state cs
set conversation_id = p.keep_id
from pairs p
where cs.conversation_id = p.drop_id
  and not exists (
    select 1 from public.conversation_state k where k.conversation_id = p.keep_id
  );

-- Mescla lead_phone / contact_id na conversa mantida
with ranked as (
  select
    c.id,
    c.agent_id,
    c.helena_session_id,
    c.lead_phone,
    c.helena_contact_id,
    row_number() over (
      partition by c.agent_id, c.helena_session_id
      order by
        (select count(*)::bigint from public.messages m where m.conversation_id = c.id) desc,
        c.atualizado_em desc nulls last,
        c.criado_em desc nulls last,
        c.id asc
    ) as rn
  from public.conversations c
  where c.helena_session_id is not null
    and btrim(c.helena_session_id) <> ''
),
keepers as (
  select id as keep_id, agent_id, helena_session_id from ranked where rn = 1
),
agg as (
  select
    k.keep_id,
    max(c.lead_phone) filter (where c.lead_phone is not null and btrim(c.lead_phone) <> '') as lead_phone,
    max(c.helena_contact_id) filter (where c.helena_contact_id is not null and btrim(c.helena_contact_id) <> '') as helena_contact_id
  from keepers k
  join public.conversations c
    on c.agent_id = k.agent_id
   and c.helena_session_id = k.helena_session_id
  group by k.keep_id
)
update public.conversations conv
set
  lead_phone = coalesce(conv.lead_phone, a.lead_phone),
  helena_contact_id = coalesce(conv.helena_contact_id, a.helena_contact_id),
  atualizado_em = now()
from agg a
where conv.id = a.keep_id;

-- Remove conversas duplicadas
with ranked as (
  select
    c.id,
    row_number() over (
      partition by c.agent_id, c.helena_session_id
      order by
        (select count(*)::bigint from public.messages m where m.conversation_id = c.id) desc,
        c.atualizado_em desc nulls last,
        c.criado_em desc nulls last,
        c.id asc
    ) as rn
  from public.conversations c
  where c.helena_session_id is not null
    and btrim(c.helena_session_id) <> ''
)
delete from public.conversations c
using ranked r
where c.id = r.id
  and r.rn > 1;

-- Índice único (falhou na 0015 se havia duplicatas)
drop index if exists public.idx_conversations_agent_session;

create unique index idx_conversations_agent_session
  on public.conversations (agent_id, helena_session_id)
  where helena_session_id is not null and btrim(helena_session_id) <> '';
