# Backend Sarai Platform — Node + Hono + Postgres

Este diretório é onde vai o backend que roda na **sua VPS** (Lovable não roda este processo). O frontend (em `src/`) consome esta API através de `VITE_API_BASE_URL`.

## Stack

- Node 20+
- Hono (HTTP)
- postgres (driver pg)
- Vercel AI SDK (`ai` + `@ai-sdk/openai`/openrouter compat) para o agente
- Zod para validação
- jose para JWT
- pg_cron no Supabase self-hosted para follow-up/warm-up

## Estrutura sugerida

```
server/
├── package.json
├── tsconfig.json
├── .env.example
├── db/
│   ├── schema.sql              # tabelas + RLS + pg_cron jobs
│   ├── seed_clinicorp.sql      # template clinicorp_dental
│   └── client.ts               # pg pool com SET app.account_id
├── src/
│   ├── index.ts                # server Hono
│   ├── auth/
│   │   ├── hmac.ts             # validação assinatura Helena
│   │   └── jwt.ts              # emite/valida JWT da sessão
│   ├── routes/
│   │   ├── auth.ts             # POST /api/auth/exchange
│   │   ├── accounts.ts         # CRUD admin
│   │   ├── agents.ts           # CRUD agente, followup, warmup, media, automations
│   │   ├── integrations.ts     # CRUD com pgcrypto
│   │   ├── conversations.ts
│   │   ├── runs.ts
│   │   ├── stats.ts
│   │   ├── tests.ts            # POST /api/test/<integration>
│   │   └── webhooks.ts         # /webhook/inbound /clinicorp /helena-tags
│   ├── worker/
│   │   ├── queue.ts            # consume message_queue + advisory_lock
│   │   ├── agent.ts            # generateText + tools
│   │   ├── splitter.ts         # quebra de mensagens (fluxo 02)
│   │   └── tools/
│   │       ├── escalar_humano.ts
│   │       ├── enviar_midia.ts
│   │       ├── buscar_contato_helena.ts
│   │       ├── clinicorp.ts
│   │       └── refletir.ts
│   ├── crons/
│   │   ├── followup.ts         # endpoint POST /cron/followup chamado por pg_cron
│   │   └── warmup.ts           # endpoint POST /cron/warmup
│   ├── integrations/
│   │   ├── helena.ts           # cliente do CRM Helena
│   │   ├── openrouter.ts
│   │   ├── elevenlabs.ts
│   │   ├── groq.ts
│   │   ├── clinicorp.ts
│   │   └── evolution.ts
│   └── templates/
│       ├── index.ts
│       └── clinicorp_dental.ts # prompt + tools + defaults
└── README.md (este arquivo)
```

## Variáveis de ambiente (.env.example)

```
PORT=8787
DATABASE_URL=postgres://postgres:postgres@localhost:5432/sarai
HELENA_HMAC_SECRET=<string compartilhada com o Menu Personalizado do Helena>
JWT_SECRET=<32+ bytes>
ADMIN_API_KEY=<chave do painel /admin>
PGCRYPTO_KEY=<chave para encriptar credenciais nas integrations>
PUBLIC_BASE_URL=https://api.suaplataforma.com
```

## Schema (db/schema.sql) — resumo

Crie estas tabelas (todas com RLS via `app.account_id`):

```sql
create extension if not exists pgcrypto;
create extension if not exists pg_cron;

create table accounts (
  id text primary key,            -- helena account_id
  name text not null,
  crm_base_api text,
  crm_token_enc bytea,
  created_at timestamptz default now()
);

create type integration_type as enum (
  'helena_crm','clinicorp','google_calendar','google_drive','clinup',
  'elevenlabs','openrouter','evolution_api','central360','groq'
);

create table integrations (
  id uuid primary key default gen_random_uuid(),
  account_id text references accounts(id) on delete cascade,
  type integration_type not null,
  config_enc bytea not null,      -- pgp_sym_encrypt(jsonb_text, key)
  config_preview jsonb default '{}'::jsonb,
  updated_at timestamptz default now(),
  unique(account_id, type)
);

create type agent_kind as enum ('main','followup','warmup');

create table agents (
  id uuid primary key default gen_random_uuid(),
  account_id text references accounts(id) on delete cascade,
  name text not null,
  kind agent_kind not null,
  template text not null,
  enabled boolean default true,
  llm_provider text default 'openrouter',
  llm_model text default 'x-ai/grok-4-fast',
  system_prompt text not null,
  voice_settings jsonb,
  tools jsonb default '[]'::jsonb,
  created_at timestamptz default now()
);

create table agent_webhooks (
  agent_id uuid primary key references agents(id) on delete cascade,
  inbound_token text unique not null default encode(gen_random_bytes(24),'hex'),
  secret text not null default encode(gen_random_bytes(16),'hex')
);

create table agent_followup_config (
  agent_id uuid primary key references agents(id) on delete cascade,
  enabled boolean default true,
  cron_expression text default '0 */10 8-21 * * *',
  max_followups int default 3,
  prompts jsonb default '[]'::jsonb
);

create table agent_warmup_config (
  agent_id uuid primary key references agents(id) on delete cascade,
  enabled boolean default true,
  tempo_wu1 int default 96, tempo_wu2 int default 72,
  tempo_wu3 int default 48, tempo_wu4 int default 24, tempo_wu5 int default 2,
  prompts jsonb default '{}'::jsonb,
  subscriber_id text, business_id text
);

create table agent_automation_rules (
  id uuid primary key default gen_random_uuid(),
  agent_id uuid references agents(id) on delete cascade,
  trigger text not null, conditions jsonb, actions jsonb,
  enabled boolean default true
);

create table media_assets (
  id uuid primary key default gen_random_uuid(),
  agent_id uuid references agents(id) on delete cascade,
  name text, description text, source text,
  external_id text, mime_type text
);

create table conversations (
  id uuid primary key default gen_random_uuid(),
  agent_id uuid references agents(id) on delete cascade,
  phone text not null,
  helena_session_id text, helena_contact_id text,
  status text default 'active',
  meta jsonb default '{}'::jsonb,
  updated_at timestamptz default now(),
  unique(agent_id, phone)
);

create table messages (
  id bigserial primary key,
  conversation_id uuid references conversations(id) on delete cascade,
  role text, content text, tool_calls jsonb,
  created_at timestamptz default now()
);

create table message_queue (
  id bigserial primary key,
  agent_id uuid references agents(id) on delete cascade,
  phone text, payload jsonb,
  enqueued_at timestamptz default now(),
  consumed_at timestamptz
);

create table conversation_state (
  conversation_id uuid primary key references conversations(id) on delete cascade,
  lock_conversa boolean default false,
  aguardando_followup boolean default false,
  numero_followup int default 0,
  last_user_message_at timestamptz,
  updated_at timestamptz default now()
);

create table warmup_sent (
  account_id text, appointment_id text, reminder_type text,
  sent_at timestamptz default now(),
  primary key (account_id, appointment_id, reminder_type)
);

create table agent_runs (
  id uuid primary key default gen_random_uuid(),
  agent_id uuid references agents(id) on delete cascade,
  conversation_id uuid, phone text,
  status text, latency_ms int,
  cost_usd numeric default 0, tokens_in int, tokens_out int,
  tools_called jsonb default '[]'::jsonb,
  error text, created_at timestamptz default now()
);

-- pg_cron — chama endpoints HTTP do worker
select cron.schedule('followup-tick', '*/10 * * * *',
  $$ select net.http_post(url:='https://api.suaplataforma.com/cron/followup',
       headers:='{"x-cron-secret":"<segredo>"}'::jsonb) $$);
select cron.schedule('warmup-tick', '*/10 * * * *',
  $$ select net.http_post(url:='https://api.suaplataforma.com/cron/warmup',
       headers:='{"x-cron-secret":"<segredo>"}'::jsonb) $$);
```

## Endpoints obrigatórios (consumidos pelo frontend)

Coincidem 1:1 com `src/lib/api.ts` e os componentes em `src/components/account/*`:

- `POST /api/auth/exchange` `{ accountId, userId?, sig?, ts? }` → `{ token, account }`
  - Valida HMAC: `hmac_sha256(HELENA_HMAC_SECRET, "${accountId}.${ts}") === sig`, com janela de 5 min.
- `GET  /api/accounts/:id/stats`
- `GET  /api/accounts/:id/agents`
- `GET  /api/accounts/:id/integrations`
- `PUT  /api/accounts/:id/integrations` `{ type, config }`
- `GET  /api/accounts/:id/conversations`
- `GET  /api/accounts/:id/runs`
- `GET  /api/conversations/:id/messages`
- `PATCH /api/agents/:id`
- `GET/PATCH /api/agents/:id/followup`
- `GET/PATCH /api/agents/:id/warmup`
- `GET/POST/DELETE /api/agents/:id/media[/...]`
- `GET/POST/DELETE /api/agents/:id/automations[/...]`
- `GET  /api/agents/:id/webhook` → `{ inbound_url, inbound_token }`
- `POST /api/test/:integration` `{ account_id }`
- `POST /api/admin/accounts` (header `X-Admin-Token`)
- `GET  /api/admin/accounts`
- `GET/POST /api/admin/accounts/:id/agents`

Webhooks externos:
- `POST /webhook/inbound/:token` (Helena → enfileira em `message_queue`)
- `POST /webhook/clinicorp/:token` (status agendamento)
- `POST /webhook/helena-tags/:token` (mudança de etiqueta)

Cron internos (chamados por pg_cron, autenticação via `x-cron-secret`):
- `POST /cron/followup`
- `POST /cron/warmup`

## Loop do worker (substitui fluxo 01 + 02)

```ts
// Pseudocódigo
async function processQueue(agentId, phone) {
  await pg.query("SELECT pg_advisory_lock(hashtext($1))", [agentId+phone]);
  try {
    await sleep(20_000); // mesmo debounce do n8n
    const newer = await pg.query(
      "SELECT 1 FROM message_queue WHERE agent_id=$1 AND phone=$2 AND consumed_at IS NULL AND enqueued_at > $3",
      [agentId, phone, startTime]
    );
    if (newer.rowCount) return; // outra mensagem chegou, deixa o próximo job processar
    const msgs = await fetchAndConsumeQueue(agentId, phone);
    const concatenated = msgs.map(m => m.payload.text).join("\n");
    const history = await loadHistory(conversationId);
    const result = await generateText({
      model: openrouter(agent.llm_model),
      system: agent.system_prompt,
      messages: [...history, { role: "user", content: concatenated }],
      tools: buildTools(agent.tools, ctx),
      maxSteps: 5,
    });
    const parts = await splitMessage(result.text); // chama LLM secundário
    for (const part of parts) {
      await sleep(part.delayMs);
      await helena.postMessage(conversationId, part.text);
    }
    await saveHistory(conversationId, result);
    await logRun({ status: "ok", ... });
  } finally {
    await pg.query("SELECT pg_advisory_unlock(hashtext($1))", [agentId+phone]);
  }
}
```

## Template clinicorp_dental

Extraído do nó *Agent* do fluxo `01. Agente Sarai`:

```ts
export const clinicorpDental = {
  required_integrations: ["helena_crm", "clinicorp", "evolution_api"],
  optional_integrations: ["google_drive", "elevenlabs", "central360", "groq"],
  default_tools: [
    "escalar_humano", "enviar_midia", "buscar_ou_criar_contato",
    "buscar_agendamentos", "criar_agendamento", "cancelar_agendamento",
    "listar_arquivos", "refletir",
  ],
  default_prompt: `Você é a Sarai, atendente virtual...`, // copiar do fluxo 01
  followup_defaults: { cron: "0 */10 8-21 * * *", max: 3, prompts: [/* ... */] },
  warmup_defaults: { wu1: 96, wu2: 72, wu3: 48, wu4: 24, wu5: 2, prompts: { /* ... */ } },
  automations: [
    { trigger: "tag_changed", conditions: { tag: "FUF Financeiro" }, actions: [{ type: "pause_ai" }] },
  ],
};
```

## Subindo na VPS

```bash
# Postgres (Supabase self-hosted já vem com)
psql $DATABASE_URL -f db/schema.sql
psql $DATABASE_URL -f db/seed_clinicorp.sql

# Backend
cd server
npm install
npm run build
pm2 start dist/index.js --name sarai-api
# ou systemd unit

# Caddy/Nginx com TLS apontando api.suaplataforma.com -> :8787
```

No CRM Helena, crie um Menu Personalizado:
- Tipo: **Página interna**
- URL: `https://seuapp.lovable.app/embed?accountId={{id_da_conta}}&userId={{id_do_usuario}}&ts={{timestamp}}&sig={{hmac_sha256(HELENA_HMAC_SECRET, "{{id_da_conta}}.{{timestamp}}")}}`

Em cada agente criado, cole a URL `inbound_url` (vista na aba **Integrações > CRM Helena**) no webhook de mensagens do CRM.

## Migração dos dados do n8n

Script one-shot que lê `n8n_historico_mensagens`, `n8n_status_atendimento`, `n8n_fila_mensagens` do Supabase atual e copia para o novo schema preservando `session_id` (telefone). Sugerido: `server/scripts/migrate-n8n.ts`.
