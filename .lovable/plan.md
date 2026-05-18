## Objetivo

Conectar o Lovable ao seu Supabase self-hosted (Coolify) e deixar o MVP rodando: embed (cliente) + admin (você como SuperAdmin) + pipeline de mensagens + cron.

---

## Etapa 1 — Conectar o Supabase self-hosted (você faz)

**1.1. Obter as 3 credenciais do Coolify:**
- `SELFHOST_SUPABASE_URL` → ex.: `https://supabase.seudominio.com`
- `SELFHOST_SUPABASE_ANON_KEY` → variável `ANON_KEY` do serviço Supabase no Coolify
- `SELFHOST_SUPABASE_SERVICE_ROLE_KEY` → variável `SERVICE_ROLE_KEY` (NUNCA expor no frontend)

> Esses 3 secrets **já existem** no Lovable. Se ainda apontam para outro lugar, eu peço atualização via formulário seguro de secrets.

**1.2. Rodar migrations no SQL Editor do Studio (Coolify):**
- `migrations/0001_schema.sql` → cria tabelas (`accounts`, `agents`, `account_secrets`, `messages`, `llm_usage_daily`, `followups`, `warmups`, `audit_logs`) + `pgcrypto` + funções de criptografia.
- `migrations/0002_cron.sql` → agenda follow-up (a cada 10 min) e warm-up (a cada 30 min).
  - Substituir `APP_URL` → `https://project--b9def3f2-cdca-46bd-bd60-e390afc0784f.lovable.app`
  - Substituir `APIKEY` → sua `SELFHOST_SUPABASE_ANON_KEY`

**1.3. Confirmar `PGCRYPTO_KEY` e `HELENA_HMAC_SECRET`** (já existem como secrets).

---

## Etapa 2 — SuperAdmin (eu implemento)

Painel `/admin` separado do `/embed`, protegido por login do **próprio Supabase self-hosted**.

```text
/login                         → login Supabase (email/senha)
/admin                         → layout protegido (_authenticated)
  /admin                       → lista todas as contas + métricas globais
  /admin/account/$accountId    → drill-down: performance do agente, custos, logs, mensagens
```

**Mecanismo de SuperAdmin:**
- Tabela `app_role` enum (`superadmin`, `user`) + tabela `user_roles` (linkada a `auth.users` do self-hosted).
- Função `has_role(uuid, app_role) security definer` para evitar recursão de RLS.
- Server function `requireSuperAdmin` middleware que checa `has_role(auth.uid(), 'superadmin')`.
- **Você** será inserido manualmente como primeiro superadmin via SQL (te dou o comando).

**RLS:** `accounts`, `messages`, `llm_usage_daily` → `select` liberado para superadmin via `has_role`.

---

## Etapa 3 — Pipeline funcional do MVP (eu implemento)

**3.1. Providers (server-only, `src/integrations/*.server.ts`):**
- `openrouter.server.ts` → chat completions usando a key da conta.
- `elevenlabs.server.ts` → TTS por voz da conta.
- `groq.server.ts` → STT Whisper.
- `helena.server.ts` → envio de mensagem/áudio de volta ao WhatsApp via Helena.

**3.2. Webhook de entrada:**
- `src/routes/api/public/webhook.helena.$agentId.ts`
  - Verifica HMAC com `HELENA_HMAC_SECRET`.
  - Persiste mensagem em `messages`.
  - Se áudio → Groq STT; monta contexto (últimas N mensagens + system prompt do agente).
  - Chama OpenRouter com a key da conta; grava custo em `llm_usage_daily`.
  - Se canal de áudio ligado → ElevenLabs TTS → envia áudio via Helena; senão texto.

**3.3. Cron handlers:**
- `src/routes/api/public/cron/followup.ts` — varre `followups` pendentes, dispara mensagens.
- `src/routes/api/public/cron/warmup.ts` — varre `warmups` ativos, dispara mensagens programadas.
- Ambos autenticados via header `apikey` = anon key do self-hosted.

---

## Etapa 4 — Limpeza (eu implemento)

- Deletar `src/lib/api.ts`, `src/lib/mockApi.ts` (apontavam para VPS antigo).
- Remover dependência de `ApiError` em `src/router.tsx`.
- Atualizar `og:image` antigo em `__root.tsx`.

---

## Ordem de execução

1. **Você**: roda Etapa 1.1 + 1.2 e me confirma "migrations OK".
2. **Eu**: implemento Etapa 2 (admin + auth + roles) e Etapa 4 (limpeza) em um único bloco.
3. **Eu**: implemento Etapa 3 (pipeline + providers + cron) em um segundo bloco.
4. **Você**: insere seu user como superadmin (SQL que eu envio), configura conta de teste via `/embed?accountId=...`, cola keys OpenRouter/ElevenLabs/Groq, e testa enviando mensagem via Helena.

---

## Detalhes técnicos

- **Auth do admin**: Supabase Auth do self-hosted (email/senha). Login via `supabase.auth.signInWithPassword` no cliente `selfhost/client.ts` (novo arquivo browser-safe usando `SELFHOST_SUPABASE_URL` + `SELFHOST_SUPABASE_ANON_KEY` expostos via `VITE_*` no `.env`).
- **Server functions**: usam `selfhost/client.server.ts` (service role) + middleware `requireSuperAdmin` para `/admin/*` e `requireAccountAccess` para `/embed/*`.
- **Embed continua aberto** (sem login) — apenas valida `accountId` na URL, como hoje.
- **Custos LLM**: agregados em `llm_usage_daily` (já no schema 0001), exibidos na tela de connections do embed e no drill-down do admin.

---

## O que eu preciso de você AGORA

Só me confirme:
- (A) URL pública do Supabase no Coolify (ex.: `https://supabase.seudominio.com`).
- (B) Se posso prosseguir já criando o login do admin com **email/senha** (mais simples) ou prefere **Google OAuth** (precisa configurar no Studio do Coolify).

Assim que você confirmar, eu atualizo os 3 secrets, você roda as 2 migrations, e eu sigo direto para Etapa 2.