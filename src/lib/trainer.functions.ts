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
import type { AgentContext } from "@/lib/agents/context";
import { runQualifierAgent } from "@/lib/agents/qualifier.server";
import { runSchedulerAgent } from "@/lib/agents/scheduler.server";
import { routeForStage, type Stage, type LeadData } from "@/lib/agents/stage";

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const AI_MAGIC_MODEL = "openai/gpt-4.1";

// Compartilhada com ai-magic.functions.ts — detecta atalhos do GPT.
const PLACEHOLDER_PATTERNS = [
  /\(\s*restante\s+do\s+prompt/i,
  /\(\s*demais\s+seções/i,
  /\(\s*\.\.\.\s*\)/i,
  /\[\s*restante\s+do\s+prompt/i,
  /\[\s*demais\s+seções/i,
  /\[\s*continue\s+como\s+antes/i,
  /\[\s*continua\s+igual/i,
  /\bpermanece\s+igual\b/i,
  /\bpermanecem\s+iguais\b/i,
  /\[\s*\.\.\.\s*\]/i,
  /\(\s*continua\s+inalterad/i,
];

function detectTruncationOrShortcut(before: string, proposed: string, sectionsChanged: string[]) {
  for (const re of PLACEHOLDER_PATTERNS) {
    if (re.test(proposed)) {
      return {
        ok: false,
        reason: `GPT inseriu placeholder ("${proposed.match(re)?.[0]}") em vez de reescrever inteiro.`,
      };
    }
  }
  if (before.length > 1000 && proposed.length < before.length * 0.7) {
    return {
      ok: false,
      reason: `proposed_prompt (${proposed.length}) é muito menor que original (${before.length}) — GPT cortou seções.`,
    };
  }
  if (sectionsChanged.length > 3 && before.length > 1000 && proposed.length < before.length * 0.85) {
    return {
      ok: false,
      reason: `GPT mudou ${sectionsChanged.length} seções e encurtou ${Math.round((1 - proposed.length / before.length) * 100)}%.`,
    };
  }
  return { ok: true as const };
}

// ── runTrainerTurn — simula 1 turn do agente sem efeitos ─────────────────

const trainerMessageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string(),
});

const trainerStageSchema = z
  .enum([
    "RECEPTION",
    "QUALIFICATION",
    "SLOT_OFFER",
    "NAME_COLLECT",
    "BOOKING",
    "CONFIRMED",
    "ESCALATED",
  ])
  .default("RECEPTION");

export const runTrainerTurn = createServerFn({ method: "POST" })
  .inputValidator((d) =>
    z
      .object({
        accountId: z.string().min(1),
        agentId: z.string().uuid(),
        history: z.array(trainerMessageSchema).default([]),
        userMessage: z.string().min(1).max(4000),
        currentStage: trainerStageSchema,
        leadData: z.record(z.string(), z.unknown()).default({}),
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

    // 2. Carrega agente + LLM config + integrações
    const [agent, llm, clinicorpCfg, clinupCfg, gcalCfg, escCfg] = await Promise.all([
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
      sb.from("clinicorp_config").select("ativo").eq("account_id", data.accountId).maybeSingle(),
      sb.from("clinup_config").select("ativo").eq("account_id", data.accountId).maybeSingle(),
      sb.from("google_calendar_tokens").select("ativo").eq("account_id", data.accountId).maybeSingle(),
      sb.from("agent_escalation").select("ativo").eq("agent_id", data.agentId).maybeSingle(),
    ]);
    if (agent.error || !agent.data) throw new Error("Agente não encontrado.");

    const model =
      (agent.data.llm_model_override as string | null) ||
      (llm.data?.default_model as string | undefined) ||
      "anthropic/claude-sonnet-4.5";
    const maxTokens = (llm.data?.max_tokens as number | undefined) ?? 2048;
    const temperature = (llm.data?.temperature as number | undefined) ?? 0.5;

    // 3. Monta AgentContext mockado, com dryRun=true (sem efeitos colaterais)
    const ctx: AgentContext = {
      accountId: data.accountId,
      agentId: data.agentId,
      conversationId: `trainer-${Date.now()}`,
      sessionId: undefined,
      stage: data.currentStage as Stage,
      leadData: data.leadData as LeadData,
      conversationPhone: "5500000000000",
      effectivePhone: "5500000000000",
      channel: "whatsapp",
      helenaContact: null, // trainer não tem contato real
      agentSettings: (agent.data.settings as Record<string, string> | null) ?? {},
      basePrompt: (agent.data.system_prompt as string) || "",
      model,
      maxTokens,
      temperature,
      orKey,
      integrations: {
        clinicorp: !!clinicorpCfg.data?.ativo,
        clinup: !!clinupCfg.data?.ativo,
        googleCalendar: !!gcalCfg.data?.ativo,
        escalation: !!escCfg.data?.ativo,
      },
      history: data.history.map((m) => ({ role: m.role, content: m.content })),
      dryRun: true, // NÃO tocar Helena/Calendar/Clinicorp
    };

    // Adiciona a mensagem do user ao history (qualifier lê cycleCount, M1, etc)
    ctx.history.push({ role: "user", content: data.userMessage });

    // 4. Roteia pelo stage atual — usa o MESMO comportamento de produção
    const route = routeForStage(ctx.stage);
    const t0 = Date.now();

    try {
      let result;
      if (route === "qualifier") {
        result = await runQualifierAgent(ctx);
      } else if (route === "scheduler") {
        result = await runSchedulerAgent(ctx);
      } else {
        // ESCALATED — não responde nada em produção; no trainer só avisa
        return {
          reply: "(Modo treinador: stage ESCALATED — em produção o agente silencia e o lead é transferido.)",
          parts: [],
          next_stage: ctx.stage,
          lead_data: ctx.leadData,
          model,
          tokens_in: 0,
          tokens_out: 0,
          cost_usd: 0,
          latency_ms: Date.now() - t0,
        };
      }

      // 5. Split em bolhas (mesma lib do orquestrador real)
      const parts = await splitMessage(result.reply, data.accountId);

      // Merge leadData (igual ao orchestrator)
      const newLeadData: LeadData = {
        ...ctx.leadData,
        ...(result.lead_data_patch ?? {}),
      };
      const newStage = result.next_stage;

      return {
        reply: result.reply,
        parts,
        next_stage: newStage,
        lead_data: newLeadData,
        model,
        tokens_in: result.tokens_in ?? 0,
        tokens_out: result.tokens_out ?? 0,
        cost_usd: result.cost_usd ?? 0,
        latency_ms: Date.now() - t0,
        tools_called: result.tools_called ?? [],
        route,
      };
    } catch (e) {
      throw new Error(`Trainer (${route}) falhou: ${e instanceof Error ? e.message : String(e)}`);
    }
  });

// ── requestTrainerImprovement — gera melhorias do prompt a partir da sessão ──

const TRAINER_FEEDBACK_SYSTEM = `Você é o **AI Magic** em modo **TREINADOR**. Recebe:
  1. O prompt atual do agente
  2. A transcrição completa de uma sessão de teste
  3. Anotações pontuais do dono do agente apontando o que precisa melhorar
     em respostas específicas do agente

Sua missão é propor um NOVO prompt que corrija essas falhas, mantendo a
qualidade estrutural.

# 🚨 REGRA #0 — A MAIS IMPORTANTE 🚨

**O campo \`proposed_prompt\` DEVE conter o PROMPT INTEIRO REESCRITO, do começo
ao fim, com TODAS as seções originais presentes e completas.**

❌ É **TERMINANTEMENTE PROIBIDO** usar atalhos como:
  - "(restante do prompt permanece igual)"
  - "(...)" ou "..."
  - "[demais seções inalteradas]"
  - Qualquer placeholder

Se o prompt tem 14.000 chars e a correção muda 100 chars, o proposed_prompt
DEVE ter ~14.000 chars — você copia LITERALMENTE o restante.

# DEMAIS REGRAS

1. Foque CIRURGICAMENTE nos pontos anotados pelo treinador.
2. Se a anotação diz "deveria ter perguntado X aqui", inclua a pergunta X
   no momento adequado do fluxo (PASSO X).
3. Se diz "tom muito robótico nessa parte", suavize as frases relacionadas.
4. Não invente informações novas que o treinador não autorizou.
5. Se múltiplas anotações apontarem o mesmo problema, agrupe a correção.
6. PRESERVE todas as seções: ROLE, TASK, REGRAS DE OURO, FLUXO, OBJEÇÕES,
   FERRAMENTAS, etc. Cada uma delas DEVE aparecer completa no proposed_prompt.

# FORMATO DE SAÍDA (JSON puro, sem markdown)

{
  "summary": "Resumo em PT-BR do que foi ajustado (1-3 frases).",
  "proposed_prompt": "O PROMPT INTEIRO REESCRITO, do início ao fim, sem placeholders.",
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
      if (!proposedPrompt) {
        proposedPrompt = promptBefore;
      } else {
        const check = detectTruncationOrShortcut(promptBefore, proposedPrompt, sectionsChanged);
        if (!check.ok) {
          console.warn(`[trainer-improve] proposta rejeitada: ${check.reason}`);
          throw new Error(check.reason);
        }
      }
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
