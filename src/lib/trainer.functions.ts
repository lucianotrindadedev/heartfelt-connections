// Modo Treinador — chat conversacional para testar o agente sem efeitos
// colaterais (não envia pelo Helena, não persiste mensagens, não aplica tags).
// Usa o MESMO modelo LLM configurado para o agente em produção, simulando
// o comportamento real para você validar o prompt em tempo real.
//
// O segundo endpoint pega a transcrição + anotações de correção e roda
// pelo AI Magic (GPT-4) para sugerir melhorias estruturadas no prompt.

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { getSelfhost } from "@/integrations/selfhost/client.server";
import { decryptValue } from "@/lib/crypto.server";
import { splitMessage } from "@/lib/message-splitter.server";

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const AI_MAGIC_MODEL = "openai/gpt-4.1";

// ── runTrainerTurn — simula 1 turn do agente sem efeitos ─────────────────

const trainerMessageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string(),
});

export const runTrainerTurn = createServerFn({ method: "POST" })
  .inputValidator((d) =>
    z
      .object({
        accountId: z.string().min(1),
        agentId: z.string().uuid(),
        history: z.array(trainerMessageSchema).default([]),
        userMessage: z.string().min(1).max(4000),
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    const sb = getSelfhost();

    // 1. Chave OpenRouter
    const secrets = await sb
      .from("account_secrets")
      .select("openrouter_api_key_enc")
      .eq("account_id", data.accountId)
      .single();
    if (!secrets.data?.openrouter_api_key_enc) {
      throw new Error("Chave OpenRouter não configurada na conta.");
    }
    const orKey = await decryptValue(secrets.data.openrouter_api_key_enc as unknown as string);
    if (!orKey) throw new Error("Falha ao descriptografar chave OpenRouter.");

    // 2. Carrega agente + LLM config
    const [agent, llm] = await Promise.all([
      sb
        .from("agents")
        .select("id, system_prompt, settings, llm_model_override")
        .eq("id", data.agentId)
        .single(),
      sb
        .from("account_llm_config")
        .select("default_model, max_tokens, temperature")
        .eq("account_id", data.accountId)
        .single(),
    ]);
    if (agent.error || !agent.data) throw new Error("Agente não encontrado.");

    const model =
      (agent.data.llm_model_override as string | null) ||
      (llm.data?.default_model as string | undefined) ||
      "anthropic/claude-sonnet-4.5";
    const maxTokens = (llm.data?.max_tokens as number | undefined) ?? 2048;
    const temperature = (llm.data?.temperature as number | undefined) ?? 0.5;

    const systemPrompt = (agent.data.system_prompt as string) || "";
    const settings = (agent.data.settings as Record<string, string> | null) ?? {};

    // 3. Monta contexto: data atual + dados do agente + system prompt
    const now = new Date();
    const dateStr = new Intl.DateTimeFormat("pt-BR", {
      timeZone: "America/Sao_Paulo",
      weekday: "long",
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    }).format(now);

    const trainerContext = `# ⚙️ MODO TREINADOR (simulação)

Você está no Modo Treinador — uma SIMULAÇÃO do atendimento real. Responda
exatamente como faria no WhatsApp do agente, seguindo TODAS as regras do
prompt. Sem fugir do papel, sem mencionar que é simulação.

# CONTEXTO ATUAL

- Data/hora (BRT): ${dateStr}
- Nome do agente: ${settings.assistant_name || "Assistente"}
- Empresa: ${settings.company_name || "(não informado)"}
- Horários da empresa: ${settings.business_hours || "(não informado)"}

`;

    const messages = [
      { role: "system" as const, content: trainerContext + systemPrompt },
      ...data.history.map((m) => ({ role: m.role, content: m.content })),
      { role: "user" as const, content: data.userMessage },
    ];

    // 4. Chama o LLM
    const t0 = Date.now();
    let replyText = "";
    let tokensIn = 0;
    let tokensOut = 0;
    let costUsd = 0;

    try {
      const res = await fetch(OPENROUTER_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${orKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          messages,
          temperature,
          max_tokens: maxTokens,
        }),
        signal: AbortSignal.timeout(60_000),
      });
      const body = await res.text();
      if (!res.ok) throw new Error(`OpenRouter ${res.status}: ${body.slice(0, 300)}`);
      const json = JSON.parse(body) as {
        choices?: { message?: { content?: string | null; reasoning?: string | null } }[];
        usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number };
      };
      tokensIn = json.usage?.prompt_tokens ?? 0;
      tokensOut = json.usage?.completion_tokens ?? 0;
      costUsd = json.usage?.cost ?? 0;
      const choice = json.choices?.[0]?.message;
      replyText = (choice?.content?.trim() ?? "") || (choice?.reasoning?.trim() ?? "");
    } catch (e) {
      throw new Error(`LLM falhou: ${e instanceof Error ? e.message : String(e)}`);
    }

    if (!replyText) {
      throw new Error("LLM retornou resposta vazia.");
    }

    // 5. Faz o split em bolhas (mesma lib do orquestrador real)
    const parts = await splitMessage(replyText, data.accountId);

    return {
      reply: replyText,
      parts,
      model,
      tokens_in: tokensIn,
      tokens_out: tokensOut,
      cost_usd: costUsd,
      latency_ms: Date.now() - t0,
    };
  });

// ── requestTrainerImprovement — gera melhorias do prompt a partir da sessão ──

const TRAINER_FEEDBACK_SYSTEM = `Você é o **AI Magic** em modo **TREINADOR**. Recebe:
  1. O prompt atual do agente
  2. A transcrição completa de uma sessão de teste
  3. Anotações pontuais do dono do agente apontando o que precisa melhorar
     em respostas específicas do agente

Sua missão é propor um NOVO prompt que corrija essas falhas, mantendo:

- Toda a estrutura do prompt existente (cabeçalhos, numeração, blockquotes).
- Tom e identidade do agente já estabelecidos.
- Outras regras já presentes.

# REGRAS

1. Foque CIRURGICAMENTE nos pontos anotados pelo treinador. Não reescreva
   o prompt inteiro — faça delta mínimo.
2. Se a anotação diz "deveria ter perguntado X aqui", inclua a pergunta X
   no momento adequado do fluxo (PASSO X).
3. Se diz "tom muito robótico nessa parte", suavize as frases relacionadas.
4. Não invente informações novas que o treinador não autorizou.
5. Se múltiplas anotações apontarem o mesmo problema, agrupe a correção.
6. PRESERVE todas as seções: ROLE, TASK, REGRAS DE OURO, FLUXO, OBJEÇÕES,
   FERRAMENTAS, etc.

# FORMATO DE SAÍDA (JSON puro, sem markdown)

{
  "summary": "Resumo em PT-BR do que foi ajustado (1-3 frases).",
  "proposed_prompt": "O PROMPT INTEIRO já corrigido.",
  "sections_changed": ["PASSO 7", "OBJEÇÕES — ...", ...],
  "reasoning": "1-2 frases explicando como as correções endereçam os pontos do treinador."
}

Responda APENAS com o JSON.`;

export const requestTrainerImprovement = createServerFn({ method: "POST" })
  .inputValidator((d) =>
    z
      .object({
        accountId: z.string().min(1),
        agentId: z.string().uuid(),
        transcript: z.array(trainerMessageSchema).min(2),
        annotations: z
          .array(
            z.object({
              messageIdx: z.number().int().min(0),
              assistantText: z.string(),
              comment: z.string().min(1).max(1000),
            }),
          )
          .min(1, "É necessário pelo menos 1 anotação para gerar correções"),
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    const sb = getSelfhost();

    // 1. Chave OpenRouter
    const secrets = await sb
      .from("account_secrets")
      .select("openrouter_api_key_enc")
      .eq("account_id", data.accountId)
      .single();
    if (!secrets.data?.openrouter_api_key_enc) {
      throw new Error("Chave OpenRouter não configurada.");
    }
    const orKey = await decryptValue(secrets.data.openrouter_api_key_enc as unknown as string);
    if (!orKey) throw new Error("Falha ao descriptografar chave OpenRouter.");

    // 2. Prompt atual
    const agent = await sb
      .from("agents")
      .select("system_prompt")
      .eq("id", data.agentId)
      .single();
    if (agent.error || !agent.data) throw new Error("Agente não encontrado.");
    const promptBefore = (agent.data.system_prompt as string) ?? "";

    // 3. Monta a user message: transcrição numerada + anotações vinculadas
    const transcriptText = data.transcript
      .map((m, i) => `[${i}] ${m.role === "user" ? "Lead" : "Agente"}: ${m.content}`)
      .join("\n");

    const annotationsText = data.annotations
      .map(
        (a) =>
          `• Mensagem [${a.messageIdx}] do Agente: "${a.assistantText.slice(0, 200)}"\n  Correção: ${a.comment}`,
      )
      .join("\n\n");

    const userMessage = `# PROMPT ATUAL DO AGENTE

${promptBefore}

---

# SESSÃO DE TESTE (transcrição numerada)

${transcriptText}

---

# ANOTAÇÕES DO TREINADOR

${annotationsText}

---

Aplique correções no prompt para que, em futuras conversas semelhantes, o
agente responda corrigindo os pontos acima — sem perder a qualidade nem
remover regras que não foram criticadas.`;

    // 4. Chama GPT-4.1
    const t0 = Date.now();
    let summary = "";
    let proposedPrompt = "";
    let sectionsChanged: string[] = [];
    let reasoning = "";
    let tokensIn = 0;
    let tokensOut = 0;
    let costUsd = 0;
    let errorMsg: string | null = null;

    try {
      const res = await fetch(OPENROUTER_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${orKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: AI_MAGIC_MODEL,
          messages: [
            { role: "system", content: TRAINER_FEEDBACK_SYSTEM },
            { role: "user", content: userMessage },
          ],
          response_format: { type: "json_object" },
          temperature: 0.3,
          max_tokens: 8192,
        }),
        signal: AbortSignal.timeout(120_000),
      });
      const body = await res.text();
      if (!res.ok) throw new Error(`OpenRouter ${res.status}: ${body.slice(0, 300)}`);
      const json = JSON.parse(body) as {
        choices?: { message?: { content?: string | null } }[];
        usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number };
      };
      tokensIn = json.usage?.prompt_tokens ?? 0;
      tokensOut = json.usage?.completion_tokens ?? 0;
      costUsd = json.usage?.cost ?? 0;
      const content = (json.choices?.[0]?.message?.content ?? "").trim();
      if (!content) throw new Error("GPT-4 retornou content vazio.");
      const parsed = JSON.parse(content) as {
        summary?: string;
        proposed_prompt?: string;
        sections_changed?: string[];
        reasoning?: string;
      };
      summary = (parsed.summary ?? "").trim();
      proposedPrompt = (parsed.proposed_prompt ?? "").trim();
      sectionsChanged = Array.isArray(parsed.sections_changed) ? parsed.sections_changed : [];
      reasoning = (parsed.reasoning ?? "").trim();
      if (!proposedPrompt) proposedPrompt = promptBefore;
    } catch (e) {
      errorMsg = e instanceof Error ? e.message : String(e);
      console.error("[trainer-improve] falha:", errorMsg);
    }

    // 5. Salva no histórico (reusa tabela ai_magic_requests com user_message
    //    contendo prefixo [TRAINER] para diferenciar)
    const userMessageStored = `[TRAINER] ${data.annotations.length} correção(ões) em sessão de teste com ${data.transcript.length} mensagens`;
    const ins = await sb
      .from("ai_magic_requests")
      .insert({
        account_id: data.accountId,
        agent_id: data.agentId,
        user_message: userMessageStored,
        prompt_before: promptBefore,
        summary: summary || null,
        proposed_prompt: proposedPrompt || null,
        sections_changed: sectionsChanged,
        reasoning: reasoning || null,
        model: AI_MAGIC_MODEL,
        tokens_in: tokensIn,
        tokens_out: tokensOut,
        cost_usd: costUsd,
        latency_ms: Date.now() - t0,
        error: errorMsg,
      })
      .select("id")
      .single();

    if (errorMsg) throw new Error(`Trainer falhou: ${errorMsg.slice(0, 200)}`);

    return {
      request_id: ins.data?.id as string,
      summary,
      proposed_prompt: proposedPrompt,
      prompt_before: promptBefore,
      sections_changed: sectionsChanged,
      reasoning,
      no_changes: proposedPrompt.trim() === promptBefore.trim(),
      latency_ms: Date.now() - t0,
    };
  });
