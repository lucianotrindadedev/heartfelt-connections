# Substituir o n8n por agente nativo, estável e escalável

## 1. O que muda na criação de conta (SuperAdmin)

Hoje o diálogo "Nova conta" pede ID, nome, nome do agente e system prompt. Vai virar um wizard mais simples e útil:

Campos no formulário:
- **Nome da conta** (ex: "Clínica Magnum")
- **ID da conta no Helena** (ex: `magnum`) — vira a chave primária `accounts.id`
- **Token do CRM Helena** (Bearer) — guardado criptografado em `accounts.helena_token_enc`
- **Base URL do Helena** (opcional, default `https://api.crmmentoriae7.com.br`)

Ao salvar, o sistema:
1. Cria `accounts` + `agents` + linhas filhas (`agent_audio`, `agent_followup`, `agent_warmup`, `account_secrets`, `account_llm_config`, `account_voice_config`, `channels_whatsapp`, `webchat_config`).
2. Gera `agents.webhook_secret` (já existe no schema).
3. Mostra na tela final **a URL do webhook pronta para colar no Helena**, com botão "Copiar":

```
https://project--b9def3f2-...lovable.app/api/public/webhook/helena/{accountId}
Header: X-Helena-Secret: <webhook_secret>
```

Instruções claras: "Cole essa URL no CRM Helena nos eventos **Mensagem recebida (lead)** e **Mensagem enviada (atendente)**."

## 2. Webhook que recebe os eventos do Helena

Rota pública: `POST /api/public/webhook/helena/$accountId`

Comportamento:
1. Valida `X-Helena-Secret` contra `agents.webhook_secret` (timing-safe).
2. Identifica o **tipo de evento** pelo payload do Helena:
   - `evento = "mensagem_recebida"` → veio do lead (role `user`)
   - `evento = "mensagem_enviada"` → veio do atendente humano OU do próprio agente
3. Extrai: `phone`, `tipo` (text/audio), `content`, `audio_url`, `helena_session_id`.
4. Faz **upsert** em `conversations (agent_id, phone)`.
5. **Sempre persiste em `messages`** — inclusive mensagens do atendente humano. Isso é o que garante o "se eu pausar e reativar a IA, ela mantém o contexto".

Regras de execução do agente:
- Mensagem do **lead** + `agents.ativo = true` + sem tag "IA Desligada" → enfileira para o agente responder.
- Mensagem do **lead** + `agents.ativo = false` (pausado pelo usuário) → **apenas grava**, não responde.
- Mensagem do **atendente humano** → grava como `role='assistant'` com `meta.origem='humano'`. Não dispara LLM.
- Comando `/pause` ou botão no painel → seta `agents.ativo=false` (ou tag no contato).
- Comando `/resume` → seta `agents.ativo=true`. Próxima mensagem do lead já entra com **todo o histórico anterior** (humano + IA) no contexto.

Áudio do lead → Groq Whisper antes de salvar `content`. URL original fica em `messages.audio_url`.

## 3. Loop do agente (substitui o n8n)

Server function `runAgentTurn(conversationId)` chamada pelo webhook quando precisa responder:

```
1. Lock em conversation_state.lock_conversa (evita corrida)
2. Debounce de 15s: aguarda novas mensagens do mesmo phone
3. Lê system_prompt + account_llm_config + últimas 50 mensagens (ordem cronológica)
4. Chama OpenRouter com a chave da conta (account_secrets.openrouter_api_key_enc)
5. Insere messages(role='assistant') + agent_runs (tokens, custo, latência)
6. Se agent_audio.responder_out=true → ElevenLabs TTS → envia áudio via Helena
   Se não → envia texto via Helena (POST com Bearer token da conta)
7. Atualiza conversation_state (unlock, last_user_message_at, aguardando_followup)
```

Crons já planejados (`migrations/0002_cron.sql`) ficam ativos:
- `/api/public/cron/followup` a cada 10 min
- `/api/public/cron/warmup` a cada 30 min

## 4. Painel de configuração embed (acessado de dentro do CRM Helena)

URL: `/embed/account/$accountId` (já existe a rota, vai ser preenchida).

Autenticação: token efêmero gerado pelo SuperAdmin OU validação por origin do iframe + `helena_session_token`. Para o MVP: query param `?token=<webchat_config.token_publico>` validado server-side.

A tela bate visualmente com a referência enviada (cards "Treinamentos avançados" / "Configurações", status "Assistente: pausado/ativo", botão "Ativar/Pausar assistente"). Abas:

**Aba "Configurações" (principal):**
- Toggle Ativar/Pausar assistente → `agents.ativo`
- Nome do assistente
- System prompt (textarea grande, com contador)
- Modelo LLM (select dos modelos OpenRouter mais usados + override)
- Temperatura, max tokens

**Aba "Áudio":**
- Toggle transcrever áudio do lead
- Toggle responder com áudio
- Voice ID ElevenLabs, modelo, stability, similarity

**Aba "Follow-up":**
- Ativar, delay em minutos, max tentativas, prompts por tentativa

**Aba "Warm-up" (Clinicorp):**
- 5 janelas (WU1..WU5) com horas-antes e prompt

**Aba "Conexões":**
- Chaves OpenRouter, ElevenLabs, Groq (gravadas criptografadas, mostradas como `••••1234`)
- Mostra a URL do webhook + secret (com botão "Regenerar" que invalida o anterior)

**Aba "Conversas" (observabilidade):**
- Lista de `conversations` recentes, status, última mensagem
- Click → timeline de `messages` (user / assistant-IA / assistant-humano diferenciados visualmente)
- Botão "Pausar IA nesta conversa" / "Reativar"

## 5. Por que isso resolve o que você pediu

| Sua necessidade | Como atende |
|---|---|
| "Substituir o n8n" | Webhook + loop do agente + crons rodam dentro do TanStack, sem orquestrador externo |
| "Escalável e estável" | Lock por conversa, debounce, fila idempotente em Postgres, RLS bypass via service role no servidor |
| "Mais inteligente" | Contexto completo (50 turnos), modelo configurável por conta, tools no futuro |
| "SuperAdmin cria conta com Token Helena e gera webhook" | Wizard novo + tela final mostrando URL + secret |
| "Recebe eventos de enviar e receber mensagens" | Webhook diferencia `mensagem_recebida` vs `mensagem_enviada` |
| "Armazenar mensagens do atendente humano para preservar contexto" | Toda mensagem entra em `messages`; humano vira `role='assistant', meta.origem='humano'` e é incluído no prompt |
| "Interromper o agente na conversa" | Toggle global (`agents.ativo`) + por-conversa (`conversation_state.lock_conversa` com flag manual) |
| "Reativar mantendo contexto" | Histórico nunca é apagado; próxima resposta já lê tudo |
| "Interface de configuração dentro do CRM" | `/embed/account/$accountId` com layout das suas screenshots |

## 6. Etapas de implementação (em ordem)

1. **Wizard de criação de conta** (substitui o dialog atual): adiciona campo Token Helena + Base URL. Tela de sucesso mostra webhook URL + secret.
2. **Server fn `helena.server.ts`**: cliente HTTP autenticado por conta (enviar mensagem texto/áudio, gerenciar tags).
3. **Rota `POST /api/public/webhook/helena/$accountId`**: valida secret, parseia evento, persiste mensagem, decide se chama agente.
4. **Server fn `runAgentTurn`**: lock, debounce 15s, contexto, OpenRouter, persiste resposta, envia via Helena.
5. **Server fn `groq.server.ts`** (Whisper) e **`elevenlabs.server.ts`** (TTS) — providers isolados, com cobrança em `agent_runs`.
6. **Crons** já existentes em `0002_cron.sql` apontando para `/api/public/cron/followup` e `/cron/warmup` (apenas confirmar/atualizar).
7. **Embed `/embed/account/$accountId`**: layout com cards e abas conforme screenshot.
8. **Conversas no embed**: timeline com diferenciação humano vs IA + botão pause/resume por conversa.

## 7. Secrets necessários

Já temos `PGCRYPTO_KEY`, `HELENA_HMAC_SECRET`, `SELFHOST_SUPABASE_*`. Faltam **por conta** (gravados criptografados em `account_secrets` via UI): OpenRouter, ElevenLabs, Groq. Nenhum secret novo global precisa ser adicionado para o MVP.

## 8. O que fica explicitamente fora deste plano (para não inchar)

- Tools do agente (Clinicorp, Google Drive, escalar humano por Evolution) — entra em fase 2.
- Splitter/formatter de mensagens em múltiplas bolhas — fase 2.
- PDF / Imagem do lead — fase 2.
- Web chat público (`webchat_config`) — fase 2.
