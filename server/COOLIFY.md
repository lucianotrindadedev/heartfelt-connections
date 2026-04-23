# Deploy no Coolify

Este guia assume que você já tem o **Coolify** rodando na VPS com o **Supabase self-hosted** instalado como app no próprio Coolify.

## Visão geral

```
Vercel ──HTTPS──▶  api.suaplataforma.com  (Coolify route)
                        │
                        ├─ panel-api  (Bun, porta 8787)
                        ├─ engine     (Bun, porta 8788)  ← webhook.suaplataforma.com
                        └─ scheduler  (Bun, sem porta)
                              │
                              ├─▶ Supabase Postgres (rede interna do Coolify)
                              └─▶ Redis (rede interna do Coolify)
```

## 1. Adicione o Redis

No Coolify: **+ New Resource → Database → Redis 7**.
- Nome: `sarai-redis`
- Anote a URL interna: `redis://sarai-redis:6379`

## 2. Pegue a DATABASE_URL do Supabase

No Supabase já existente no Coolify, copie o hostname interno do container Postgres (algo como `supabase-db-xxxxxxxx`). A URL será:

```
postgres://postgres:<SENHA-DO-POSTGRES>@<hostname-interno>:5432/postgres
```

Use sempre o hostname **interno** — performance maior e dispensa expor a porta 5432.

## 3. Crie 3 Applications (uma por serviço)

Para cada serviço abaixo: **+ New Resource → Application → Public Repository**
(ou conecte GitHub App se preferir).

### 3.1 panel-api (REST do painel)

| Campo | Valor |
|---|---|
| Repository | URL do seu repo |
| Branch | `main` |
| Build Pack | **Dockerfile** |
| Base Directory | `/server` |
| Dockerfile Location | `packages/panel-api/Dockerfile` |
| Ports Exposes | `8787` |
| Domains | `api.suaplataforma.com` |
| Health Check Path | `/health` |

### 3.2 engine (webhook + worker BullMQ)

| Campo | Valor |
|---|---|
| Build Pack | **Dockerfile** |
| Base Directory | `/server` |
| Dockerfile Location | `packages/engine/Dockerfile` |
| Ports Exposes | `8788` |
| Domains | `webhook.suaplataforma.com` |
| Health Check Path | `/health` |

### 3.3 scheduler (crons follow-up + warm-up)

| Campo | Valor |
|---|---|
| Build Pack | **Dockerfile** |
| Base Directory | `/server` |
| Dockerfile Location | `packages/scheduler/Dockerfile` |
| Ports Exposes | _(deixe vazio — não tem HTTP)_ |
| Domains | _(vazio)_ |

## 4. Environment Variables (aba de cada app)

Crie um **Shared Variable** no projeto Coolify chamado `sarai-shared` com tudo que é comum, e ative ele nos 3 apps:

```
NODE_ENV=production
LOG_LEVEL=info
DATABASE_URL=postgres://postgres:<SENHA>@supabase-db-xxxxxxxx:5432/postgres
REDIS_URL=redis://sarai-redis:6379
PGCRYPTO_KEY=<openssl rand -hex 32>
JWT_SECRET=<openssl rand -hex 32>
HELENA_HMAC_SECRET=<segredo do Menu Personalizado Helena>
ADMIN_API_KEY=<openssl rand -hex 24>
PUBLIC_BASE_URL=https://webhook.suaplataforma.com
SCHEDULER_TZ=America/Sao_Paulo
OPENROUTER_DEFAULT_MODEL=x-ai/grok-4-fast
SPLITTER_MODEL=x-ai/grok-4-fast
```

Variáveis específicas (na aba Environment Variables de cada app):

- **panel-api**: `PANEL_PORT=8787`
- **engine**: `ENGINE_PORT=8788`, `WEBHOOK_DEBOUNCE_MS=20000`
- **scheduler**: nenhuma adicional

> **Importante**: gere `PGCRYPTO_KEY`, `JWT_SECRET` e `ADMIN_API_KEY` novos — não reaproveite os JWTs do Supabase.

## 5. Migrations do banco

Antes do primeiro deploy, rode as migrations Drizzle apontando para o Postgres do Supabase:

```bash
# Localmente, com a DATABASE_URL apontando para o Postgres exposto temporariamente
# (ou use o terminal do container panel-api no Coolify após o primeiro build):
cd server
bun install
bun run db:migrate   # drizzle-kit push
```

Alternativa: no Coolify, abra **Terminal** do container `panel-api` e rode:

```bash
cd /app/packages/shared
bunx drizzle-kit push
```

## 6. Deploy

Clique **Deploy** em cada um dos 3 apps. Coolify vai:
- Buildar o Dockerfile
- Subir o container
- Configurar Traefik com TLS automático (Let's Encrypt) para os domínios
- Ativar health-check

Ordem recomendada de primeiro deploy:
1. `panel-api` (frontend já consegue funcionar)
2. `engine`
3. `scheduler`

## 7. Frontend na Vercel

No Vercel → projeto Lovable → **Settings → Environment Variables**:

```
VITE_API_BASE_URL=https://api.suaplataforma.com
```

Redeploy. O painel já vai conversar com o backend.

## 8. Configurar o Helena

No CRM Helena → **Menus Personalizados → Novo**:

- Tipo: **Página interna**
- URL: `https://<seu-vercel>.vercel.app/embed?accountId={{id_da_conta}}&userId={{id_do_usuario}}&ts={{timestamp}}&sig={{hmac_sha256(HELENA_HMAC_SECRET, "{{id_da_conta}}.{{timestamp}}")}}`

Em cada agente criado no painel, copie a `inbound_url` (vista na aba **Integrações > CRM Helena**) — algo como `https://webhook.suaplataforma.com/webhook/<agent_id>` — e cole no webhook de mensagens do CRM Helena, junto com o header `x-webhook-secret`.

## 9. Logs e troubleshooting

- Coolify → app → **Logs**: stdout/stderr ao vivo (já formatados em JSON pelo pino).
- Health-checks falhando? Veja `Configuration → Health Check`.
- Quer redeploy manual? Botão **Redeploy** ou push novo commit (Coolify rebuilda automaticamente se Auto Deploy estiver ligado).

## 10. Backups

Supabase no Coolify já faz dump diário se você ativou. Adicione também:
- Snapshot da VPS (Hetzner/Contabo/etc.) semanal.
- `BACKUPS=true` no app Redis do Coolify (RDB diário).

---

**Não precisa do `docker-compose.yml`** quando usa Coolify — cada serviço vira um app separado e o Coolify gerencia rede + Traefik. Mantive o `docker-compose.yml` no repo apenas como referência para quem quiser rodar fora do Coolify.
