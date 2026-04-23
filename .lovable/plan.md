

# Análise: plano Claude Code vs. arquitetura atual

## TL;DR

Os dois documentos estão **alinhados em 90%** com o que já planejamos e iniciamos. Eles confirmam as decisões (Supabase self-hosted, AI SDK, Helena via iframe, templates por integração, multi-tenant por `account_id`, criptografia com pgcrypto, fila por telefone, divisor de mensagens 02). O que vale **incorporar** são 4 escolhas técnicas que aumentam performance e operabilidade no backend, e **2 ajustes** no que já existe no frontend.

## Comparação rápida

| Tema | Plano atual (já em código) | Claude Code | Decisão |
|---|---|---|---|
| Frontend | TanStack Start + Lovable | React + Vite embarcado | **Manter Lovable** (já feito, idêntico em capacidade) |
| Auth Helena | HMAC + JWT na URL | `conta_id` direto, validação por token Helena | **Manter HMAC** (mais seguro contra troca de URL) |
| Backend runtime | Node 20 + Hono | **Bun + Bun.serve** | **Adotar Bun** (startup ~50ms, ~80MB RAM, http nativo) |
| Banco | Supabase self-host + pg | Supabase self-host + **Drizzle ORM** | **Adotar Drizzle** (typesafe, migrations versionadas) |
| Fila/encavalamento | `pg_advisory_lock` + `message_queue` | **Redis + BullMQ** | **Adotar BullMQ** (resiliente, retries, dead-letter, métricas) |
| Cron follow-up/warm-up | `pg_cron` chamando endpoint | **Bun setInterval** num serviço `scheduler` separado | **Adotar scheduler dedicado** (mais simples de debugar; mantém pg_cron como fallback de health-check) |
| Topologia | 1 processo Hono | **3 processos**: `agent-engine`, `scheduler`, `panel-api` | **Adotar separação** (escala independente, deploy isolado) |
| Cache de config do agente | Buscar a cada request | Cache 60s no Redis | **Adotar** (reduz queries massivamente) |
| Templates | JSON em código | JSON em código + tools tipadas Zod | **Já alinhado** |
| Quebra de mensagens (02) | LLM secundário barato | `generateObject` + Zod schema | **Adotar `generateObject`** (saída garantida em JSON) |
| Encavalamento | lock_conversa flag | Mesma lógica + Redis lock por `agente:telefone` | **Combinar** (Redis primário, flag DB como auditoria) |

## O que muda no código

### Backend (`server/`) — refator antes de implementar

Reorganizar em **monorepo Bun com 3 packages** já no scaffold inicial:

```text
server/
├── package.json (workspaces)
├── docker-compose.yml         # supabase + redis + 3 services + nginx
├── packages/
│   ├── shared/                # db schema (drizzle), tipos, helena client, crypto
│   │   ├── db/schema.ts       # tabelas em Drizzle
│   │   ├── db/migrations/     # geradas por drizzle-kit
│   │   ├── crypto.ts          # pgp_sym_encrypt wrapper
│   │   └── helena.ts          # cliente CRM Helena
│   ├── engine/                # SERVIÇO 1 — webhook + agente
│   │   ├── server.ts          # Bun.serve
│   │   ├── webhook.ts         # /webhook/:agente_id → enqueue BullMQ
│   │   ├── queue.ts           # worker BullMQ (concorrência 1 por agente:telefone)
│   │   ├── agent.ts           # runAgent() com generateText + tools
│   │   ├── sender.ts          # splitAndSend() com generateObject
│   │   ├── cache.ts           # config do agente em Redis (TTL 60s)
│   │   └── tools/
│   │       ├── escalate.ts    (fluxo 05)
│   │       ├── media.ts       (fluxo 03)
│   │       └── templates/clinicorp.ts  (10 tools fluxo 01)
│   ├── scheduler/             # SERVIÇO 2 — crons
│   │   ├── index.ts           # setInterval 60s e 10min
│   │   ├── followup.ts        (fluxo 06)
│   │   ├── warmup.ts          (fluxo 07)
│   │   └── automacoes.ts      (fluxo 08 — webhook Clinicorp)
│   └── panel-api/             # SERVIÇO 3 — REST do painel Lovable
│       ├── server.ts          # Hono em Bun
│       ├── routes/auth, accounts, agents, integrations, conversations, runs, tests
│       └── middleware/auth.ts # HMAC + JWT (mantido)
└── README.md (atualizado)
```

**Stack final:** Bun 1.x · Hono · Drizzle ORM · Vercel AI SDK + OpenRouter · BullMQ + Redis · Zod · jose · pgcrypto · Luxon (para timezones America/Sao_Paulo).

**Docker Compose** com: Supabase self-host (db/auth/storage/studio), Redis 7, agent-engine, scheduler, panel-api, Nginx + Certbot. Health-check em cada serviço. Logs estruturados (pino) prontos para Grafana/Loki depois.

### Frontend (já existe, ajustes pequenos)

1. **Webhook URL com formato novo** (`/webhook/<agente_id>` em vez de `/webhook/inbound/<token>`), e adicionar campo `webhook_secret` no painel "Integrações > Helena CRM" (header `x-webhook-secret`).
2. **Cache do React Query**: revisar `staleTime` para 60s nas queries de agente/integrações para casar com o cache do backend.
3. Sem mudança no shell, rotas, ou OverviewTab que acabamos de redesenhar.

### Banco — adições/ajustes

Adicionar ao `db/schema.sql`:
- Coluna `webhook_secret` em `agents` (já existia em `agent_webhooks`, vamos consolidar).
- Índice parcial `WHERE aguardando_followup = TRUE` em `conversation_state` (otimiza o cron).
- Tabela `agent_runs` ganha colunas `latency_ms`, `tokens_in`, `tokens_out`, `cost_usd` (para o painel de custo).
- Manter nomes em **inglês** (já adotado) — divergência com o doc, que usa pt-BR (`agentes`, `contas`). Mais consistente com o frontend que já está em inglês para schema.

## O que NÃO vamos adotar do doc

- **React + Vite separado**: já temos o painel em TanStack Start no Lovable; muda nada funcional.
- **`conta_id` puro na URL sem assinatura**: deixa porta aberta para troca de URL no DOM do CRM. Mantemos HMAC + JWT.
- **Nomes em pt-BR no schema**: misturar idiomas piora DX — manter inglês.
- **Migrar tabelas n8n existentes** com sufixo `n8n_`: vamos rodar o **script de migração** que copia para o schema novo limpo (`messages`, `conversation_state`, `message_queue`), preservando `session_id`. As tabelas antigas ficam intactas no Supabase atual durante o paralelo.

## Plano de execução (revisado)

1. **Reescrever `server/README.md`** com estrutura monorepo Bun + Drizzle + BullMQ + 3 serviços + docker-compose.yml de exemplo.
2. **Criar scaffold real** dos 3 packages (`shared`, `engine`, `scheduler`, `panel-api`) com `package.json`, `tsconfig.json`, `Dockerfile`, e schema Drizzle em `shared/db/schema.ts` (substitui o `schema.sql` solto).
3. **Implementar `panel-api` primeiro** (CRUD que o Lovable já consome) para o frontend continuar funcional ponta-a-ponta sem worker.
4. **Implementar `engine`** (webhook → BullMQ → runAgent + tools Clinicorp + sender) — fluxos 01/02/03/04/05.
5. **Implementar `scheduler`** — fluxos 06/07/08.
6. **Ajustar 2 pontos no frontend** (webhook URL + secret na aba Integrações; staleTime 60s).
7. Script de migração `scripts/migrate-from-n8n.ts` lendo Supabase legado.
8. `docker-compose.yml` final + Nginx com `frame-ancestors` para o iframe Helena.

## Resultado

A arquitetura fica **idêntica em capacidade** ao que já desenhamos, mas com 4 ganhos concretos: (1) startup/RAM muito menor (Bun), (2) typesafety end-to-end (Drizzle), (3) fila resiliente com retries e métricas (BullMQ), (4) escala independente por serviço (Docker). O frontend Lovable continua sendo a interface única e o que já está construído permanece válido — só precisa ajustar o formato do webhook quando o backend for ao ar.

