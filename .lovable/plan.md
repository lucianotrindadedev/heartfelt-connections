

# Plataforma de Agentes IA para CRM Helena

Substitui os 9 fluxos n8n (00–08) por uma aplicação dedicada. Frontend no Lovable embutido como **Página Interna** no CRM Helena (via Menus Personalizados, recebendo `{{id_da_conta}}` na URL). Backend e runtime dos agentes ficam no seu **Supabase self-hosted + worker Node** na sua VPS.

## Arquitetura geral

```text
┌──────────────────────────────────────────────────────────┐
│  CRM HELENA  ──(iframe ?accountId=...)──▶ Painel Lovable │
└──────────────────────────────────────────────────────────┘
                         │ REST/JWT
                         ▼
┌──────────────────────────────────────────────────────────┐
│  VPS                                                      │
│  ┌────────────┐  ┌──────────────┐  ┌────────────────┐   │
│  │ Supabase   │  │ API Gateway  │  │ Agent Worker   │   │
│  │ self-host  │◀▶│ (Node/Hono)  │◀▶│ (Node + AI SDK)│   │
│  │ + pg_cron  │  │ webhooks/CRUD│  │ LangGraph-like │   │
│  └────────────┘  └──────────────┘  └────────────────┘   │
│        ▲                ▲                  │             │
└────────┼────────────────┼──────────────────┼─────────────┘
         │                │                  ▼
   pg_cron              Webhook        OpenRouter / ElevenLabs
 (follow-up,            Helena/        / Clinicorp / Google Drive
  warm-up)              Clinicorp
```

**Chave do design:** sem usuário/senha. O Lovable lê `accountId` da query string e usa um JWT curto assinado pelo backend (HMAC com `account_id` + segredo do menu Helena) para autenticar todas as chamadas. Admin geral acessado por uma rota separada protegida por chave.

## Modelo de dados (Postgres na VPS)

Tabelas centrais — multi-tenant por `account_id`:

- **accounts** — `id (helena account_id)`, `name`, `crm_base_api`, `crm_token`, `created_at`
- **integrations** — credenciais por conta: `account_id`, `type` (clinicorp, google_calendar, clinup, elevenlabs, openrouter, evolution_api, central360), `config jsonb` (encriptado)
- **agents** — `id`, `account_id`, `name`, `kind` (main, followup, warmup), `template` (clinicorp_dental, generic), `enabled`, `llm_model`, `llm_provider`, `system_prompt`, `voice_settings jsonb`, `tools jsonb` (lista de tools habilitadas)
- **agent_webhooks** — `agent_id`, `inbound_url_token` (URL única para o Helena postar mensagens), `secret`
- **agent_followup_config** — `agent_id`, `cron_expression`, `max_followups`, `prompts jsonb` (1 prompt por sequência)
- **agent_warmup_config** — `agent_id`, `tempo_wu1..wu5` (horas), `prompts jsonb`, `subscriber_id`, `business_id`
- **agent_automation_rules** — `agent_id`, `trigger` (tag_changed, appointment_status), `conditions jsonb`, `actions jsonb` (add_tag, remove_tag, add_to_sequence, pause_ai)
- **media_assets** — `agent_id`, `name`, `description`, `source` (gdrive, supabase_storage), `external_id`, `mime_type` — para a tool "enviar mídia"
- **conversations** — `agent_id`, `phone`, `helena_session_id`, `helena_contact_id`, `status`, `meta jsonb`
- **messages** — réplica do `n8n_historico_mensagens`: `conversation_id`, `role`, `content`, `tool_calls`, `created_at`
- **message_queue** — réplica do `n8n_fila_mensagens`: usado para detectar mensagens "encavaladas" (debounce de 20s)
- **conversation_state** — réplica do `n8n_status_atendimento`: `lock_conversa`, `aguardando_followup`, `numero_followup`, `updated_at`
- **warmup_sent** — dedupe (substitui o `removeItemsSeenInPreviousExecutions`): `account_id + appointment_id + reminder_type` UNIQUE
- **agent_runs** — log de execuções para debug (input, output, tools, latência, custo)

RLS habilitado em todas as tabelas: `account_id = current_setting('app.account_id')::uuid`.

## Backend (Node.js na VPS — Hono ou Fastify)

**Endpoints principais:**

- `POST /webhook/inbound/:agentToken` — recebe mensagens do Helena (substitui o trigger do fluxo 01). Insere em `message_queue`, dispara processamento.
- `POST /webhook/clinicorp/:agentToken` — recebe eventos de status de agendamento (faltou, agendou) — fluxo 08 parte 1.
- `POST /webhook/helena-tags/:agentToken` — recebe alteração de etiquetas — fluxo 08 parte 2 (FUF financeiro etc).
- `POST /api/auth/exchange` — recebe `accountId` da iframe + assinatura HMAC e devolve JWT da sessão.
- `GET/POST /api/agents` etc. — CRUD do painel.
- `POST /api/test/openrouter`, `POST /api/test/clinicorp`, `POST /api/test/elevenlabs` — botões "Testar conexão" no painel.

**Worker de agente (mesmo processo ou separado):**

- Consome `message_queue` por `phone`. Aguarda 20s (substitui o node "Esperar"). Se chegou nova mensagem para o mesmo telefone, reinicia o timer (lógica "encavalada"). Se não, junta tudo, chama o LLM.
- Usa **Vercel AI SDK** (`generateText` + `tools`) com OpenRouter como provider. Cada agente carrega seu prompt + lista de tools dinâmica.
- Tools nativas implementadas como funções TypeScript (não fluxos n8n):
  - `escalar_humano` (fluxo 05): tira tag IA, põe "IA Desligada", envia alerta WhatsApp via Evolution API, transfere lead Central360.
  - `enviar_midia` (fluxo 03): baixa do Google Drive ou Supabase Storage e posta via API Helena.
  - `buscar_ou_criar_contato` (fluxo 04): GET `/core/v1/contact/phonenumber/:phone` no Helena, devolve id da conversa.
  - `buscar_agendamentos`, `criar_agendamento`, `cancelar_agendamento` (Clinicorp).
  - `refletir`, `listar_arquivos`, etc.
- Após resposta do LLM, chama o **divisor de mensagens** (fluxo 02): segundo modelo (mais barato, ex. grok-4.1-fast) com prompt de quebrar em até 5 partes, calcula delay por palavras-por-minuto e posta cada parte via `/chat/v1/session/:id/message`.
- Se mensagem do usuário foi áudio: transcreve via **Groq Whisper** (como no fluxo) ou ElevenLabs STT antes de enviar pro LLM. Se agente está em modo voz, gera áudio com ElevenLabs TTS e envia anexo.
- Salva histórico em `messages` (formato compatível com Postgres Memory do LangChain).

**Cron jobs (pg_cron no Supabase self-hosted):**

- Follow-up: a cada 10 min entre 8–21h faz `SELECT * FROM conversation_state WHERE aguardando_followup = true` e dispara HTTP no worker para cada agente, que executa o agente follow-up (fluxo 06): valida `numero_followup < max_followups`, monta prompt "<lead não respondeu...>", chama LLM, envia mensagem, incrementa contador.
- Warm-up: a cada 10 min, para cada agente warm-up ativo, busca `appointment/list` no Clinicorp dos próximos 4 dias, calcula janela de envio com base em `tempo_wu1..wu5`, evita duplicatas via `warmup_sent`, executa prompt específico por WU e envia (fluxo 07).

## Frontend Lovable (TanStack Start)

**Roteamento:**

- `/` — landing curta de teste (não usada em produção).
- `/embed` — entrypoint para iframe Helena. Lê `?accountId=`, troca por JWT, redireciona para `/embed/account/$accountId`.
- `/embed/account/$accountId` — painel da conta (visão atendente/admin Helena).
- `/admin` — painel super-admin (você), protegido por chave em variável de ambiente + cookie.

**Painel Admin (`/admin`)**

Lista global de contas e agentes, com fluxo:
1. Selecionar/criar conta (vincula `account_id` Helena).
2. Criar agente: escolher **template** (`clinicorp_dental`, `google_calendar_generic`, `clinup`, `custom`). Templates pré-preenchem prompt, tools, integrações esperadas.
3. Configurar credenciais da integração escolhida (form gerado a partir do schema do template).
4. Configurar webhooks: o sistema gera URL única (`/webhook/inbound/<token>`) para colar no CRM Helena.

**Painel da conta (`/embed/account/$accountId`)**

Tabs:
- **Visão geral** — agentes ativos, mensagens nas últimas 24h, custo estimado, fila atual.
- **Agente Principal** — editor de prompt com preview, seletor de modelo OpenRouter (lista carregada da API), toggle de tools (escalar humano, enviar mídia, listar arquivos, refletir, tools de integração), velocidade de digitação.
- **Follow-up** — toggle on/off, expressão cron com helper visual ("a cada X min, das HH às HH"), `max_followups`, prompts por sequência.
- **Warm-up** — toggle on/off, 5 inputs (`tempo_wu1..wu5` em horas), prompt por WU, seletor de agenda Clinicorp.
- **Integrações** — abas por tipo: CRM Helena (token + base API + botão "gerar webhook"), Clinicorp (subscriber_id, businessId, api_token, webhook URL para colar), Google Drive (OAuth ou service account), ElevenLabs (api_key, voice_id), OpenRouter (api_key), Evolution API + grupo de alerta, Central360.
- **Mídias** — biblioteca: nome + descrição (usada pelo LLM para escolher) + arquivo do Drive ou upload Supabase Storage.
- **Automações** — regras tipo "quando tag X for adicionada → adicionar à sequência Y" (replica fluxo 08).
- **Conversas** — viewer das `messages` por telefone, com replay de tool calls e botão "pausar IA" (cria tag "IA Desligada" no Helena).
- **Logs** — `agent_runs` com filtro por status, latência, custo.

UI usando shadcn/ui que já está no projeto. Multi-language PT-BR.

## Integração Helena (Menus Personalizados)

Você cria 2 menus na plataforma Helena:
1. **"Agente IA"** — Categoria *Apps*, comportamento *Página interna*, URL: `https://seuapp.lovable.app/embed?accountId={{id_da_conta}}&userId={{id_do_usuario}}&sig=...` — perfis Admin/Atendente. (A assinatura `sig` evita que alguém troque o `accountId` na URL: o backend valida HMAC com segredo configurado.)
2. **"Admin Agentes"** (opcional) — só seu perfil Super Admin, abre `/admin`.

Para o webhook de mensagens: no CRM Helena cadastra-se o webhook apontando para `https://api.suaplataforma.com/webhook/inbound/<token>` em cada agente.

## Templates (chave do produto)

Cada template é um JSON versionado em código:

```text
clinicorp_dental:
  required_integrations: [helena_crm, clinicorp, evolution_api]
  optional_integrations: [google_drive, elevenlabs, central360]
  default_tools: [escalar_humano, enviar_midia, buscar_agendamentos,
                  criar_agendamento, listar_status, refletir]
  default_prompt: "<prompt extraído do nó Agent do fluxo 01>"
  followup_defaults: { max: 3, cron: "0 */10 8-21 * * *" }
  warmup_defaults: { wu1: 96, wu2: 72, wu3: 48, wu4: 24, wu5: 2 }
  automations: [pausar_ia_quando_tag_FUF, marcar_faltou]
```

Permite criar novo agente Clinicorp em < 2 min: escolher template → preencher só credenciais → ativar.

## Detalhes técnicos

- **Stack backend**: Node 20 + Hono + Vercel AI SDK + pg (postgres-js) + Zod. Roda como serviço systemd na VPS, atrás de Caddy/Nginx com TLS automático.
- **Frontend**: TanStack Start (já configurado no projeto Lovable), TanStack Query para CRUD, React Hook Form + Zod nos formulários, Monaco para editor de prompt.
- **Auth**: HMAC-SHA256 com segredo compartilhado entre backend e o link configurado no Menu Helena. Backend devolve JWT (15 min) gravado em cookie httpOnly. Admin geral: senha em env var + 2FA TOTP opcional.
- **Crypto de credenciais**: `pgcrypto` (chave em env var no servidor, nunca no banco em texto puro).
- **Encavalamento**: implementado com `pg_advisory_lock(hash(phone))` + tabela `message_queue` (mais limpo que o wait+select do n8n).
- **Áudio**: Groq Whisper para transcrição (mantém o que já funciona no fluxo); ElevenLabs TTS opcional por agente.
- **Quebra de mensagens**: chamada secundária ao OpenRouter com modelo barato (grok-4.1-fast por padrão, configurável), exatamente o prompt do fluxo 02.
- **Observabilidade**: tabela `agent_runs` + endpoint `/admin/logs`. Custo calculado pelo response do OpenRouter (`usage`).
- **Migração de dados existentes**: script one-shot que lê `n8n_historico_mensagens`, `n8n_status_atendimento`, `n8n_fila_mensagens` do Supabase atual e copia para o novo schema preservando `session_id` (telefone).

## Entrega proposta (fases dentro do MVP único)

1. Schema Postgres + migrations + script de seed do template Clinicorp.
2. Backend: auth HMAC, CRUD de contas/agentes/integrações, endpoints de teste.
3. Frontend: rotas `/embed/account/$accountId` com todas as tabs (CRUD + formulários).
4. Webhook inbound + worker de agente principal com tools (fluxos 01, 02, 03, 04, 05).
5. Cron de follow-up (fluxo 06).
6. Cron de warm-up + integração Clinicorp (fluxo 07).
7. Webhooks de automação (fluxo 08): tags Helena + status Clinicorp.
8. Painel `/admin` + observabilidade + script de migração.

Como o frontend roda no Lovable mas o backend roda na sua VPS, o Lovable cuidará apenas do código React (rotas `/embed/*` e `/admin`) e de um `src/lib/api.ts` que aponta para `https://api.suaplataforma.com`. O código do backend (Node + Hono) será gerado também aqui no projeto, em uma pasta `server/`, pronta pra você fazer `npm run start` na VPS — Lovable não roda esse processo, mas mantém o código versionado e editável.

