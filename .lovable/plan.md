## Visão geral

Reconstrução do sistema com arquitetura **muito mais simples**:

```
[CRM Helena] ──webhook──▶ [TanStack Server Routes (Lovable)] ──▶ [Supabase self-hosted]
       ▲                          │                                      │
       └──── resposta ────────────┘                                  pg_cron
                                                                        │
                                                            (chama /api/public/cron)
```

- Sem `panel-api`, `engine`, `scheduler`, Redis, BullMQ, Docker próprio.
- Toda a lógica vive em **TanStack Server Functions/Routes** hospedadas pela Lovable.
- Todo estado vive no **seu Supabase self-hosted** (Postgres + Storage).
- Cron via **pg_cron** dentro do próprio Supabase, chamando `/api/public/*`.
- **LLM e TTS por conta**: cada conta cadastra sua própria chave OpenRouter e ElevenLabs (controle de gasto isolado).

---

## 1. Conexão com o Supabase self-hosted

`Promptfy` (Lovable Cloud) continua conectado por requisito da plataforma — **não vamos usar suas tabelas**. Todo o app aponta para o seu self-hosted via cliente paralelo.

Variáveis novas:
- `SELFHOST_SUPABASE_URL` + `VITE_SELFHOST_SUPABASE_URL`
- `SELFHOST_SUPABASE_ANON_KEY` + `VITE_SELFHOST_SUPABASE_ANON_KEY`
- `SELFHOST_SUPABASE_SERVICE_ROLE_KEY` (server-only)

Arquivos: `src/integrations/selfhost/{client.ts, client.server.ts}`.

**Sem secrets globais de OpenRouter / ElevenLabs** — ficam por conta.

---

## 2. Schema (cole no SQL Editor do seu self-hosted)

Tabelas principais:

- **accounts** — id (= account_id Helena), nome, helena_base_url, helena_token_enc, criado_em
- **account_secrets** — account_id (PK), openrouter_api_key_enc, elevenlabs_api_key_enc, groq_api_key_enc (opcional), atualizado_em
  - Criptografia com `pgcrypto` (`pgp_sym_encrypt`) usando `PGCRYPTO_KEY` (env server-only). Nunca expostas ao browser; o painel só mostra `••••••• últimos 4`.
- **account_llm_config** — account_id (PK), default_model (ex: `x-ai/grok-4-fast`), splitter_model, formatter_model, max_tokens, temperature
- **account_voice_config** — account_id (PK), elevenlabs_voice_id, model_id (ex: `eleven_turbo_v2_5`), stability, similarity, style, speaker_boost
- **agents** — 1 por conta, nome, ativo, system_prompt, llm_model_override (opcional, sobrepõe account_llm_config), webhook_secret
- **agent_followup** — config + array de prompts
- **agent_warmup** — config WU1..WU5 + prompts
- **agent_audio** — habilitado, transcrever_in (Groq Whisper), responder_out (TTS ElevenLabs)
- **channels_whatsapp** — status, evolution_url, instance_name, evolution_api_key_enc (também por conta)
- **queues** — filas de transferência
- **webchat_config** — token público, cores
- **media_assets** — id, agent_id, nome, url
- **conversations** — agent_id, phone, helena_session_id, status, meta
- **messages** — conversation_id, role, content, audio_url
- **conversation_state** — lock_conversa, aguardando_followup, numero_followup, last_user_message_at
- **warmup_sent** — controle idempotência (account_id, appointment_id, reminder_type)
- **agent_runs** — log: latency_ms, tokens_in, tokens_out, cost_usd_estimate, provider (`openrouter`/`elevenlabs`/`groq`), error
- **llm_usage_daily** (view materializada ou agregação) — account_id, dia, tokens, requests, custo estimado — base do painel de gastos por conta

Sem `auth.users`. Auth do painel = `account_id` do Helena (HMAC + JWT atual). RLS desligado nas tabelas; tudo via service_role nos server routes.

---

## 3. Server routes (TanStack Start)

**Webhooks públicos** (`src/routes/api/public/`):
- `webhook.helena.$agentId.ts` — POST: valida `x-webhook-secret` → enfileira/processa → busca chaves da conta → chama OpenRouter → responde via API Helena.
- `webhook.helena-tags.$agentId.ts`
- `cron.followup.ts` — chamado por pg_cron a cada 10min
- `cron.warmup.ts` — chamado por pg_cron a cada 30min

**Server functions** (`src/lib/*.functions.ts`):
- `accounts.functions.ts`
- `agent.functions.ts` — getAgent, updateAgent, toggle, reset
- `secrets.functions.ts` — `setOpenRouterKey`, `setElevenLabsKey`, `testOpenRouterKey` (faz `GET /key` na OpenRouter para validar + retornar saldo/limite), `testElevenLabsKey`
- `llm-config.functions.ts` — get/update modelo, listar modelos disponíveis no OpenRouter (`GET /models`)
- `voice.functions.ts` — listar vozes do ElevenLabs da conta (`GET /v1/voices`), preview, salvar voice_id
- `audio.functions.ts`
- `whatsapp.functions.ts` — Evolution API por conta
- `queues.functions.ts`, `webchat.functions.ts`, `media.functions.ts`
- `conversations.functions.ts`
- `usage.functions.ts` — agregação de `agent_runs` para o painel de gastos

**Helpers server-only** (`src/lib/providers/`):
- `openrouter.server.ts` — `callOpenRouter(accountId, messages, opts)` — busca a chave criptografada da conta, descriptografa via `pgp_sym_decrypt`, chama OpenRouter, registra `agent_runs` com custo estimado.
- `elevenlabs.server.ts` — `tts(accountId, text)`, `listVoices(accountId)`.
- `groq.server.ts` — `transcribe(accountId, audioUrl)` (chave por conta; se conta não tiver, áudio fica desabilitado).
- `helena.server.ts` — cliente CRM.

**Sem Lovable AI Gateway. Sem `LOVABLE_API_KEY` para LLM.**

---

## 4. Frontend simplificado (tela única, igual à referência)

Substituir todo `src/routes/embed.account.$accountId.*` por:

```
src/routes/embed.account.$accountId.index.tsx  ← ÚNICA tela
```

Layout:
- **Header**: "Assistente Virtual · Online" + toggle ATIVO/INATIVO
- **Card boas-vindas**: nome do agente + Desativar / Resetar / ▶ testar
- **AÇÕES PRINCIPAIS** (2 cards) — abrem `<Sheet>` lateral:
  - **Treinamentos avançados** → prompt do agente, base de conhecimento, mídias
  - **Configurações** → nome, comportamento, **modelo OpenRouter (dropdown buscando `/models` com a chave da conta)**, voz ElevenLabs (dropdown com vozes da conta + preview)
- **CANAIS DE ATENDIMENTO** (4 cards):
  - WhatsApp (Evolution)
  - Áudio (ativar transcrição/resposta)
  - Filas
  - Web Chat (BETA)
- **Card extra "Conexões e Custos"** (subtle, embaixo): chave OpenRouter, chave ElevenLabs, chave Groq (opcional), saldo OpenRouter (`GET /key`), gráfico de custo dos últimos 30 dias (de `agent_runs`).

Cada card abre drawer/sheet — sem mudança de rota.

**Apagar**: `src/components/account/*Tab.tsx`, todas rotas `embed.account.$accountId.{overview,main-agent,training,followup,warmup,integrations,media,automations,conversations,logs}.tsx`.

**Manter**: `/admin` (templates + listagem de contas) com painel completo.

---

## 5. Fluxo de mensagem

1. CRM Helena → POST `/api/public/webhook/helena/:agentId` com `x-webhook-secret`.
2. Server route valida secret contra `agents.webhook_secret`.
3. Persiste `messages`, atualiza `conversation_state`, marca `aguardando_followup=false`.
4. Se áudio + `agent_audio.transcrever_in` → `groq.transcribe(accountId, url)` (se conta não tem chave Groq, ignora ou avisa).
5. Monta histórico + system_prompt → `openrouter.callOpenRouter(accountId, ...)`:
   - Busca `account_secrets.openrouter_api_key_enc` → descriptografa → chama OpenRouter com modelo de `agents.llm_model_override` ou `account_llm_config.default_model`.
   - **Se conta não tem chave OpenRouter cadastrada → retorna erro amigável "Configure sua chave OpenRouter em Conexões"**.
6. Se mensagem original era áudio + `responder_out` → `elevenlabs.tts(accountId, resposta)` com voz da conta.
7. Envia via API Helena. Persiste resposta em `messages` + `agent_runs` (tokens, custo, provider).

Follow-up/Warm-up rodam pelos crons consultando `conversation_state` / agendamentos Clinicorp e disparam mensagens usando o mesmo pipeline (chave da conta).

---

## 6. Cron (cole no SQL Editor do self-hosted)

```sql
create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.schedule('followup-tick','*/10 * * * *', $$
  select net.http_post(
    url := 'https://SEU-PROJETO.lovable.app/api/public/cron/followup',
    headers := '{"Content-Type":"application/json"}'::jsonb
  );
$$);

select cron.schedule('warmup-tick','*/30 * * * *', $$
  select net.http_post(
    url := 'https://SEU-PROJETO.lovable.app/api/public/cron/warmup',
    headers := '{"Content-Type":"application/json"}'::jsonb
  );
$$);
```

`/api/public/*` na Lovable não exige auth — basta a rota validar internamente (token simples opcional).

---

## 7. Variáveis de ambiente novas

| Nome | Onde | Para que |
|---|---|---|
| `SELFHOST_SUPABASE_URL` (+ VITE_) | server + browser | URL do seu Supabase |
| `SELFHOST_SUPABASE_ANON_KEY` (+ VITE_) | server + browser | Anon key |
| `SELFHOST_SUPABASE_SERVICE_ROLE_KEY` | **server only** | Service role |
| `PGCRYPTO_KEY` | **server only** | Criptografar chaves de API por conta |
| `JWT_SECRET` | server | Sessão do painel embed |
| `HELENA_HMAC_SECRET` | server | Validar URLs assinadas do CRM |

**Não precisa**: `LOVABLE_API_KEY` para LLM, `OPENROUTER_API_KEY` global, `ELEVENLABS_API_KEY` global, `GROQ_API_KEY` global. Tudo por conta no banco.

---

## 8. O que apagar

- Pasta inteira `server/` (panel-api, engine, scheduler, shared, docker-compose, Dockerfiles)
- `nginx.conf`, `Dockerfile` raiz, `wrangler.jsonc`
- `src/lib/api.ts` (client REST do panel-api antigo) → server functions
- `src/lib/mockApi.ts`
- `src/components/account/*Tab.tsx`
- Rotas `embed.account.$accountId.*.tsx` (exceto novo `index.tsx`)

---

## 9. Ordem de implementação

1. Pedir os 3 secrets do self-hosted + `PGCRYPTO_KEY` + `JWT_SECRET` + `HELENA_HMAC_SECRET` via `add_secret`.
2. Criar `src/integrations/selfhost/{client,client.server}.ts`.
3. Gerar `migrations/schema.sql` (entrego para você colar).
4. Criar providers server-only (`openrouter`, `elevenlabs`, `groq`, `helena`) com decryption por conta.
5. Criar server functions e routes (`api/public/webhook`, `api/public/cron`, `lib/*.functions.ts`).
6. Reescrever frontend: tela única + drawers + card de conexões/custos.
7. Apagar `server/` e arquivos obsoletos.
8. Entregar passo a passo final.

---

## 10. Entregáveis finais

1. `migrations/schema.sql` pronto para colar no SQL Editor.
2. `migrations/cron.sql` pronto para colar.
3. Lista de secrets a configurar.
4. Modelo de URL de webhook por agente: `https://SEU-PROJETO.lovable.app/api/public/webhook/helena/{agentId}` + `x-webhook-secret`.
5. Instruções para cada cliente cadastrar **sua própria** chave OpenRouter (https://openrouter.ai/keys) e ElevenLabs (https://elevenlabs.io/app/settings/api-keys) na nova tela Conexões.
