# Backend Sarai Platform — Bun Monorepo (engine + scheduler + panel-api)

Este diretório contém o backend que roda na **sua VPS** (Lovable não executa este processo). O frontend (em `src/`) consome a API através de `VITE_API_BASE_URL`.

## Stack

- **Bun 1.x** (runtime + package manager + bundler) — startup ~50ms, ~80MB RAM
- **Hono** (HTTP)
- **Drizzle ORM** + driver `postgres` (typesafe, migrations versionadas)
- **BullMQ + Redis 7** (filas resilientes com retries / dead-letter / métricas)
- **Vercel AI SDK** (`ai` + `@ai-sdk/openai` compat OpenRouter) — `generateText` no agente, `generateObject` na quebra de mensagens
- **Zod** (validação + tools tipadas)
- **jose** (JWT da sessão Helena)
- **pgcrypto** (encriptação de credenciais no Postgres)
- **Luxon** (timezones America/Sao_Paulo)
- **pino** (logs estruturados)

## Topologia (3 processos)

Cada serviço escala independentemente. Em produção, todos rodam em containers Docker atrás de Nginx.

```
┌──────────────────────────────────────────────────────────────┐
│  CRM Helena ──(iframe)──▶ Painel Lovable ──(REST/JWT)──▶     │
│                                                               │
│  ┌─────────────┐   ┌──────────────┐   ┌──────────────────┐  │
│  │ panel-api   │   │ agent-engine │   │ scheduler        │  │
│  │ (Hono+Bun)  │   │ (Bun+BullMQ) │   │ (Bun+setInterval)│  │
│  │ CRUD/auth   │   │ webhook+LLM  │   │ followup/warmup  │  │
│  └──────┬──────┘   └──────┬───────┘   └────────┬─────────┘  │
│         │                 │                    │             │
│         └────────┬────────┴────────────────────┘             │
│                  ▼                                            │
│         ┌─────────────────┐    ┌──────────┐                  │
│         │ Postgres        │    │  Redis 7 │                  │
│         │ (Supabase self) │    │  BullMQ  │                  │
│         │ + pgcrypto      │    │  + cache │                  │
│         └─────────────────┘    └──────────┘                  │
└──────────────────────────────────────────────────────────────┘
```

## Estrutura do monorepo

```
server/
├── package.json              # workspaces: bun
├── bun.lockb
├── docker-compose.yml        # supabase + redis + 3 services + nginx
├── .env.example
├── packages/
│   ├── shared/               # código compartilhado pelos 3 serviços
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   ├── src/
│   │   │   ├── db/
│   │   │   │   ├── schema.ts        # tabelas Drizzle (substitui schema.sql)
│   │   │   │   ├── client.ts        # pg pool com SET app.account_id
│   │   │   │   └── migrations/      # geradas por drizzle-kit
│   │   │   ├── crypto.ts            # wrapper pgp_sym_encrypt
│   │   │   ├── helena.ts            # cliente CRM Helena
│   │   │   ├── redis.ts             # ioredis singleton
│   │   │   ├── logger.ts            # pino
│   │   │   ├── env.ts               # env vars validadas com Zod
│   │   │   └── templates/
│   │   │       ├── index.ts
│   │   │       └── clinicorp_dental.ts
│   │   └── drizzle.config.ts
│   ├── engine/               # SERVIÇO 1 — webhook inbound + worker do agente
│   │   ├── package.json
│   │   ├── Dockerfile
│   │   ├── src/
│   │   │   ├── server.ts            # Bun.serve (Hono)
│   │   │   ├── webhook.ts           # POST /webhook/:agent_id → enqueue
│   │   │   ├── queue.ts             # BullMQ worker (concorrência 1 por agent:phone)
│   │   │   ├── agent.ts             # runAgent() — generateText + tools
│   │   │   ├── sender.ts            # splitAndSend() — generateObject
│   │   │   ├── cache.ts             # Redis: config do agente (TTL 60s)
│   │   │   ├── stt.ts               # Groq Whisper
│   │   │   ├── tts.ts               # ElevenLabs
│   │   │   └── tools/
│   │   │       ├── escalate.ts          # fluxo 05
│   │   │       ├── send_media.ts        # fluxo 03
│   │   │       ├── helena_contact.ts    # fluxo 04
│   │   │       ├── reflect.ts
│   │   │       └── clinicorp/
│   │   │           ├── list_appointments.ts
│   │   │           ├── create_appointment.ts
│   │   │           └── cancel_appointment.ts
│   ├── scheduler/            # SERVIÇO 2 — crons (followup, warmup, automações)
│   │   ├── package.json
│   │   ├── Dockerfile
│   │   ├── src/
│   │   │   ├── index.ts             # setInterval orchestrator
│   │   │   ├── followup.ts          # fluxo 06
│   │   │   ├── warmup.ts            # fluxo 07
│   │   │   └── automations.ts       # fluxo 08 — webhook clinicorp + helena tags
│   └── panel-api/            # SERVIÇO 3 — REST consumido pelo painel Lovable
│       ├── package.json
│       ├── Dockerfile
│       ├── src/
│       │   ├── server.ts            # Hono em Bun
│       │   ├── middleware/
│       │   │   ├── auth.ts          # HMAC + JWT
│       │   │   ├── admin.ts         # X-Admin-Token
│       │   │   └── tenant.ts        # SET app.account_id por request
│       │   └── routes/
│       │       ├── auth.ts          # POST /api/auth/exchange
│       │       ├── accounts.ts
│       │       ├── agents.ts        # CRUD + followup + warmup + media + automations
│       │       ├── integrations.ts
│       │       ├── conversations.ts
│       │       ├── runs.ts
│       │       ├── stats.ts
│       │       ├── tests.ts         # POST /api/test/<integration>
│       │       └── admin.ts
└── scripts/
    ├── migrate-from-n8n.ts          # copia n8n_historico_mensagens etc.
    └── seed-clinicorp.ts            # template de exemplo
```

## Schema (Drizzle — `packages/shared/src/db/schema.ts`)

Resumo das tabelas (todas com RLS por `app.account_id`):

- **accounts** — `id (helena account_id)`, `name`, `crm_base_api`, `crm_token_enc`, `created_at`
- **integrations** — `account_id`, `type`, `config_enc bytea` (pgp_sym_encrypt), `config_preview jsonb`, `updated_at`. UNIQUE `(account_id, type)`.
- **agents** — `id`, `account_id`, `name`, `kind` (main/followup/warmup), `template`, `enabled`, `llm_provider`, `llm_model`, `system_prompt`, `voice_settings jsonb`, `tools jsonb`, `webhook_secret` *(consolidado do agent_webhooks)*, `created_at`
- **agent_followup_config** — `agent_id`, `enabled`, `cron_expression`, `max_followups`, `prompts jsonb`
- **agent_warmup_config** — `agent_id`, `enabled`, `tempo_wu1..wu5` (horas), `prompts jsonb`, `subscriber_id`, `business_id`
- **agent_automation_rules** — `agent_id`, `trigger`, `conditions jsonb`, `actions jsonb`, `enabled`
- **media_assets** — `agent_id`, `name`, `description`, `source`, `external_id`, `mime_type`
- **conversations** — `agent_id`, `phone`, `helena_session_id`, `helena_contact_id`, `status`, `meta jsonb`, UNIQUE `(agent_id, phone)`
- **messages** — `conversation_id`, `role`, `content`, `tool_calls jsonb`, `created_at`
- **conversation_state** — `conversation_id PK`, `lock_conversa`, `aguardando_followup`, `numero_followup`, `last_user_message_at`. **Índice parcial** `WHERE aguardando_followup = TRUE`.
- **warmup_sent** — PK `(account_id, appointment_id, reminder_type)` para dedupe
- **agent_runs** — `agent_id`, `conversation_id`, `phone`, `status`, `latency_ms`, `tokens_in`, `tokens_out`, `cost_usd numeric`, `tools_called jsonb`, `error`, `created_at`

Campos `*_enc bytea` armazenam credenciais com `pgp_sym_encrypt(jsonb_text, env.PGCRYPTO_KEY)`. Nunca em texto puro.

## Fila + encavalamento (BullMQ)

Substitui o `wait 20s + select` do n8n por:

1. `POST /webhook/:agent_id` → `queue.add("inbound", { agent_id, phone, payload }, { jobId: ${agent_id}:${phone}:${nanoid()} })`.
2. **Worker** com `concurrency: N`, mas usando `Worker` group por `agent_id:phone` (lock distribuído via `redis SETNX agent:phone TTL=120s`).
3. Worker faz `await sleep(20_000)`. Se chegou outro job para o mesmo `agent:phone` durante o sleep (verificado via `queue.getJobs(['waiting'])`), o job atual é marcado como skipped e o último vence — replica o "encavalamento".
4. Concatena payloads, carrega histórico, chama LLM, divide mensagens (`generateObject`), envia via Helena com delay por palavras.
5. Retries automáticos com backoff exponencial. Falhas finais vão para `failed` queue → alerta no Slack/Discord.

## Cache de config (Redis, TTL 60s)

`getAgentConfig(agentId)`:
- `GET agent:cfg:<id>` → se hit, retorna.
- Senão `SELECT` com Drizzle, `SET agent:cfg:<id> EX 60` e retorna.
- Invalidação no `PATCH /api/agents/:id` (`DEL agent:cfg:<id>`).

Reduz queries massivamente (1 query a cada 60s por agente em vez de 1 por mensagem).

## Endpoints (consumidos pelo frontend)

Mantém compatibilidade 1:1 com `src/lib/api.ts`. **Mudança importante**: webhook URL agora é `/webhook/<agent_id>` autenticado por header `x-webhook-secret`.

- `POST /api/auth/exchange` `{ accountId, userId?, sig?, ts? }` → `{ token, account }`
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
- `GET  /api/agents/:id/webhook` → `{ inbound_url: "<base>/webhook/<id>", webhook_secret }`
- `POST /api/test/:integration` `{ account_id }`
- `POST /api/admin/accounts` (header `X-Admin-Token`)
- `GET  /api/admin/accounts`
- `GET/POST /api/admin/accounts/:id/agents`

Webhooks externos (no `engine`):
- `POST /webhook/:agent_id` (header `x-webhook-secret`) — Helena → enfileira no BullMQ
- `POST /webhook/clinicorp/:agent_id` (header `x-webhook-secret`)
- `POST /webhook/helena-tags/:agent_id` (header `x-webhook-secret`)

Health-checks:
- `GET /health` em cada serviço (panel-api, engine, scheduler)

## Variáveis de ambiente (.env.example)

```
# Comum
NODE_ENV=production
LOG_LEVEL=info
DATABASE_URL=postgres://postgres:postgres@db:5432/sarai
REDIS_URL=redis://redis:6379
PGCRYPTO_KEY=<32 bytes>
JWT_SECRET=<32+ bytes>
HELENA_HMAC_SECRET=<segredo do Menu Personalizado Helena>
ADMIN_API_KEY=<chave do painel /admin>
PUBLIC_BASE_URL=https://api.suaplataforma.com

# panel-api
PANEL_PORT=8787

# engine
ENGINE_PORT=8788
WEBHOOK_DEBOUNCE_MS=20000

# scheduler
SCHEDULER_TICK_MS=60000

# integrações default (sobrescritas por conta)
OPENROUTER_DEFAULT_MODEL=x-ai/grok-4-fast
SPLITTER_MODEL=x-ai/grok-4-fast
```

## Loop do agente (substitui fluxos 01 + 02)

```ts
// packages/engine/src/queue.ts (pseudocódigo)
const worker = new Worker("inbound", async (job) => {
  const { agent_id, phone } = job.data;
  const lockKey = `lock:${agent_id}:${phone}`;
  const acquired = await redis.set(lockKey, "1", "EX", 120, "NX");
  if (!acquired) return; // outro worker está cuidando

  try {
    await sleep(WEBHOOK_DEBOUNCE_MS);
    const newer = await queue.getJobs(["waiting", "active"])
      .then(js => js.some(j => j.data.agent_id === agent_id && j.data.phone === phone && j.id !== job.id));
    if (newer) return; // o próximo job processa tudo

    const msgs = await drainPending(agent_id, phone);
    const cfg = await getAgentConfig(agent_id);
    const history = await loadHistory(conversationId);
    const result = await generateText({
      model: openrouter(cfg.llm_model),
      system: cfg.system_prompt,
      messages: [...history, { role: "user", content: msgs.map(m => m.text).join("\n") }],
      tools: buildTools(cfg.tools, ctx),
      maxSteps: 5,
    });
    const { parts } = await generateObject({
      model: openrouter(env.SPLITTER_MODEL),
      schema: z.object({ parts: z.array(z.object({ text: z.string(), delayMs: z.number() })).max(5) }),
      prompt: SPLITTER_PROMPT(result.text),
    });
    for (const part of parts) {
      await sleep(part.delayMs);
      await helena.postMessage(conversationId, part.text);
    }
    await saveHistory(conversationId, result);
    await logRun({ status: "ok", latency_ms, tokens_in, tokens_out, cost_usd });
  } finally {
    await redis.del(lockKey);
  }
}, { connection: redis, concurrency: 10 });
```

## Scheduler (substitui fluxos 06 + 07 + 08)

```ts
// packages/scheduler/src/index.ts
import { CronJob } from "cron";
new CronJob("*/10 8-21 * * *", runFollowupTick, null, true, "America/Sao_Paulo");
new CronJob("*/10 * * * *", runWarmupTick, null, true, "America/Sao_Paulo");
```

`runFollowupTick`: query no índice parcial → para cada conversa, chama o agente `followup` com prompt da sequência → envia → incrementa contador.

`runWarmupTick`: para cada agente `warmup` ativo, busca `appointment/list` no Clinicorp dos próximos 4 dias, calcula janela com `tempo_wu1..5`, evita duplicatas via `warmup_sent`, executa prompt da WU correspondente.

## docker-compose.yml (esqueleto)

```yaml
services:
  db:
    image: supabase/postgres:15
    environment: { POSTGRES_PASSWORD: ${POSTGRES_PASSWORD} }
    volumes: [pgdata:/var/lib/postgresql/data]
  redis:
    image: redis:7-alpine
    command: redis-server --appendonly yes
    volumes: [redisdata:/data]
  panel-api:
    build: ./packages/panel-api
    env_file: .env
    depends_on: [db, redis]
    healthcheck: { test: ["CMD", "wget", "-qO-", "http://localhost:8787/health"] }
  engine:
    build: ./packages/engine
    env_file: .env
    depends_on: [db, redis]
  scheduler:
    build: ./packages/scheduler
    env_file: .env
    depends_on: [db, redis, engine]
  nginx:
    image: nginx:alpine
    ports: ["443:443", "80:80"]
    volumes: [./nginx.conf:/etc/nginx/nginx.conf, certs:/etc/letsencrypt]
    depends_on: [panel-api, engine]
volumes: { pgdata: {}, redisdata: {}, certs: {} }
```

Nginx adiciona `Content-Security-Policy: frame-ancestors https://*.helena.app` no `panel-api` e `/embed/*` para permitir o iframe.

## Subindo na VPS

```bash
cd server
cp .env.example .env && vim .env
bun install
bun run --filter shared db:migrate     # drizzle-kit push
bun run --filter shared db:seed        # template clinicorp
docker compose up -d --build
```

## Ordem de implementação

1. **shared**: `db/schema.ts` (Drizzle), `crypto.ts`, `redis.ts`, `helena.ts`, `templates/clinicorp_dental.ts`.
2. **panel-api**: HMAC/JWT + CRUD que o Lovable já consome (frontend funciona ponta-a-ponta sem worker).
3. **engine**: webhook → BullMQ → `runAgent` + tools Clinicorp + sender (`generateObject`).
4. **scheduler**: followup + warmup + automações.
5. `scripts/migrate-from-n8n.ts`.
6. `docker-compose.yml` + `nginx.conf` com TLS automático (Caddy ou Certbot).

## Migração dos dados do n8n

Script one-shot (`scripts/migrate-from-n8n.ts`) lê `n8n_historico_mensagens`, `n8n_status_atendimento`, `n8n_fila_mensagens` do Supabase atual e copia para `messages`, `conversation_state`, `message_queue` preservando `session_id` (telefone). Tabelas antigas ficam intactas durante o paralelo.

## Configuração no Helena

Menu Personalizado:
- Tipo: **Página interna**
- URL: `https://seuapp.lovable.app/embed?accountId={{id_da_conta}}&userId={{id_do_usuario}}&ts={{timestamp}}&sig={{hmac_sha256(HELENA_HMAC_SECRET, "{{id_da_conta}}.{{timestamp}}")}}`

Em cada agente criado, copie a URL `inbound_url` (aba **Integrações > CRM Helena**) + o `webhook_secret` (header `x-webhook-secret`) no webhook de mensagens do CRM.
