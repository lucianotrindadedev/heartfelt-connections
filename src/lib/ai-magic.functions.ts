// AI Magic — assistente de edição de prompt do agente.
//
// Fluxo:
//   1. Usuário descreve em linguagem natural o que quer mudar
//   2. GPT-4 lê o prompt atual + o pedido + considera a estrutura do template
//   3. Devolve { summary, proposed_prompt, sections_changed, reasoning }
//   4. Usuário revisa o resumo e clica "Aplicar" → grava em agents.system_prompt
//   5. Todo o histórico fica em ai_magic_requests para análise/auditoria.

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { getSelfhost } from "@/integrations/selfhost/client.server";
import { decryptValue } from "@/lib/crypto.server";

const AI_MAGIC_MODEL = "openai/gpt-4.1"; // GPT-4 estável + bom em edição estruturada
const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

/**
 * Detecta se o LLM cortou o prompt usando atalhos tipo
 * '(restante do prompt permanece igual)' em vez de reescrever inteiro.
 */
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

function detectTruncationOrShortcut(
  before: string,
  proposed: string,
  sectionsChanged: string[],
): { ok: boolean; reason?: string } {
  // 1) Detecta placeholders explícitos
  for (const re of PLACEHOLDER_PATTERNS) {
    if (re.test(proposed)) {
      return {
        ok: false,
        reason: `O GPT inseriu um placeholder ("${proposed.match(re)?.[0]}") em vez de reescrever o prompt completo. Tente reformular o pedido — talvez mais específico.`,
      };
    }
  }

  // 2) Se o proposed é < 70% do tamanho original E < 5 seções
  //    foram declaradas como alteradas, provavelmente o GPT cortou.
  const beforeLen = before.length;
  const proposedLen = proposed.length;
  if (beforeLen > 1000 && proposedLen < beforeLen * 0.7) {
    return {
      ok: false,
      reason: `O proposed_prompt (${proposedLen} chars) é muito menor que o original (${beforeLen} chars). O GPT provavelmente cortou seções. Tente um pedido mais específico ou edite manualmente.`,
    };
  }

  // 3) Mais de 3 seções alteradas com prompt encurtado >30%: suspeito
  if (
    sectionsChanged.length > 3 &&
    beforeLen > 1000 &&
    proposedLen < beforeLen * 0.85
  ) {
    return {
      ok: false,
      reason: `O GPT mudou ${sectionsChanged.length} seções e encurtou o prompt em ${Math.round((1 - proposedLen / beforeLen) * 100)}% — possível corte indevido. Tente uma alteração mais focada.`,
    };
  }

  return { ok: true };
}

// ── System prompt do AI Magic ────────────────────────────────────────────

const AI_MAGIC_SYSTEM = `Você é o **AI Magic**, um assistente especialista em ajustar prompts de agentes
de atendimento ao cliente (SDR, recepção, agendamento). Seu papel é interpretar
solicitações em linguagem natural e propor edições cirúrgicas no prompt existente
SEM perder a qualidade estrutural.

# 🚨 REGRA #0 — A MAIS IMPORTANTE 🚨

**O campo \`proposed_prompt\` DEVE conter o PROMPT INTEIRO REESCRITO, do começo
ao fim, com TODAS as seções originais presentes e completas.**

❌ É **TERMINANTEMENTE PROIBIDO** usar atalhos como:
  - "(restante do prompt permanece igual)"
  - "(...)" ou "..."
  - "[demais seções inalteradas]"
  - "[continue como antes]"
  - Qualquer placeholder que sugira "o resto continua igual"

Se o prompt original tem 14.000 caracteres e você só está mudando 100 deles,
mesmo assim o proposed_prompt DEVE ter ~14.000 caracteres — o restante
literalmente copiado e colado.

Por quê: a aplicação SALVA O proposed_prompt INTEIRO no banco. Se você usar
atalho, o agente perde 99% das instruções e fica quebrado.

# DEMAIS REGRAS ABSOLUTAS

1. **NUNCA remova seções inteiras** sem instrução explícita. Toda seção do prompt
   tem propósito: identidade do agente, regras de tom, fluxo SPIN, objeções,
   ferramentas, dados da empresa. Se o usuário pediu uma mudança pontual, faça
   uma mudança pontual.

2. **PRESERVE A ESTRUTURA** do prompt. Cabeçalhos (## ROLE, ## TASK, ## SPECIFICS,
   etc), numeração de passos, formato de listas, blockquotes — tudo deve continuar
   no mesmo formato.

3. **NÃO INVENTE INFORMAÇÕES**. Se o usuário pediu "adicione o endereço da clínica"
   mas não passou o endereço, peça antes de inventar.

4. **DELTAS MÍNIMOS**. Faça a menor mudança necessária para atender o pedido. Se
   é trocar "10h" por "11h" em 2 lugares, faça só isso — não reescreva o passo.
   MAS reescreva o prompt COMPLETO no JSON, com a troca aplicada.

4b. **PRESERVE CARACTERE A CARACTERE** tudo que está FORA da mudança pedida.
   NÃO "corrija", normalize nem reformate nada que o usuário não pediu — isso
   inclui escaping/markdown (ex: \\[Nome\\] continua \\[Nome\\], NÃO vira [Nome]),
   acentuação, pontuação, espaçamento, maiúsculas e emojis. Cada linha não
   relacionada ao pedido deve sair IDÊNTICA à original. Mudanças cosméticas em
   trechos não pedidos confundem o usuário na revisão do diff e são PROIBIDAS.

5. **EXPLIQUE O QUE VAI MUDAR** no \`summary\` em PT-BR, conciso (1-3 frases).
   Liste em \`sections_changed\` cada seção tocada (ex: "PASSO 7", "OBJEÇÕES").

6. **SE O PEDIDO FOR AMBÍGUO ou inseguro** (ex: "deixa mais agressivo"), responda
   com uma pergunta de clarificação em \`summary\` e devolva \`proposed_prompt\`
   IGUAL ao original (sem alteração).

# FORMATO DE SAÍDA OBRIGATÓRIO (JSON puro, sem markdown)

{
  "summary": "Resumo em PT-BR do que vai mudar (1-3 frases).",
  "proposed_prompt": "O PROMPT INTEIRO REESCRITO, do início ao fim, sem placeholders.",
  "sections_changed": ["PASSO 7", "REGRAS DE OURO — etc"],
  "reasoning": "1 frase explicando a decisão por trás da mudança."
}

Responda APENAS com esse JSON — nada antes nem depois.`;

// ── Server function: gerar proposta de edição ──────────────────────────────

export const requestPromptEdit = createServerFn({ method: "POST" })
  .inputValidator((d) =>
    z
      .object({
        accountId: z.string().min(1),
        agentId: z.string().uuid(),
        userMessage: z.string().min(3).max(2000),
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    const sb = getSelfhost();

    // 1. Carrega chave OpenRouter da conta
    const secrets = await sb
      .from("account_secrets")
      .select("openrouter_api_key_enc")
      .eq("account_id", data.accountId)
      .single();
    if (!secrets.data?.openrouter_api_key_enc) {
      throw new Error(
        "Chave OpenRouter não configurada. Configure em Conexões de IA antes de usar o AI Magic.",
      );
    }
    const orKey = await decryptValue(secrets.data.openrouter_api_key_enc as unknown as string);
    if (!orKey) throw new Error("Falha ao descriptografar chave OpenRouter.");

    // 2. Carrega prompt atual do agente
    const agent = await sb
      .from("agents")
      .select("system_prompt, nome")
      .eq("id", data.agentId)
      .single();
    if (agent.error || !agent.data) throw new Error("Agente não encontrado.");
    const promptBefore = (agent.data.system_prompt as string) ?? "";

    // 3. Carrega últimas 10 solicitações (contexto da conversa)
    const history = await sb
      .from("ai_magic_requests")
      .select("user_message, summary, applied, criado_em")
      .eq("agent_id", data.agentId)
      .order("criado_em", { ascending: false })
      .limit(10);

    const historyContext =
      history.data && history.data.length > 0
        ? "\n\n# HISTÓRICO RECENTE (do mais novo ao mais antigo)\n" +
          history.data
            .map(
              (r) =>
                `- [${r.applied ? "✓ aplicado" : "✗ não aplicado"}] "${r.user_message}" → ${r.summary ?? "(sem resumo)"}`,
            )
            .join("\n")
        : "";

    // 4. Chama GPT-4 via OpenRouter
    const t0 = Date.now();
    let proposedPrompt = "";
    let summary = "";
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
            { role: "system", content: AI_MAGIC_SYSTEM + historyContext },
            {
              role: "user",
              content: `# PROMPT ATUAL DO AGENTE (${(agent.data.nome as string) ?? "Assistente"})\n\n${promptBefore}\n\n---\n\n# SOLICITAÇÃO DO USUÁRIO\n\n${data.userMessage}`,
            },
          ],
          response_format: { type: "json_object" },
          temperature: 0.3,
          max_tokens: 8192, // prompt completo + resumo
        }),
        signal: AbortSignal.timeout(60_000),
      });

      const respBody = await res.text();
      if (!res.ok) {
        throw new Error(`OpenRouter ${res.status}: ${respBody.slice(0, 300)}`);
      }
      const json = JSON.parse(respBody) as {
        choices?: { message?: { content?: string } }[];
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
        proposedPrompt = promptBefore; // sem alteração
        if (!summary) summary = "(Sem alterações propostas.)";
      } else {
        // Validação contra atalhos do GPT ("(restante do prompt permanece igual)")
        const check = detectTruncationOrShortcut(promptBefore, proposedPrompt, sectionsChanged);
        if (!check.ok) {
          console.warn(`[ai-magic] proposta rejeitada: ${check.reason}`);
          throw new Error(check.reason);
        }
      }
    } catch (e) {
      errorMsg = e instanceof Error ? e.message : String(e);
      console.error("[ai-magic] falha:", errorMsg);
    }

    const latencyMs = Date.now() - t0;

    // 5. Salva no histórico (sempre, mesmo em erro — para auditoria)
    const ins = await sb
      .from("ai_magic_requests")
      .insert({
        account_id: data.accountId,
        agent_id: data.agentId,
        user_message: data.userMessage,
        prompt_before: promptBefore,
        summary: summary || null,
        proposed_prompt: proposedPrompt || null,
        sections_changed: sectionsChanged,
        reasoning: reasoning || null,
        model: AI_MAGIC_MODEL,
        tokens_in: tokensIn,
        tokens_out: tokensOut,
        cost_usd: costUsd,
        latency_ms: latencyMs,
        error: errorMsg,
      })
      .select("id")
      .single();

    if (errorMsg) {
      throw new Error(`AI Magic falhou: ${errorMsg.slice(0, 200)}`);
    }

    return {
      request_id: ins.data?.id as string,
      summary,
      proposed_prompt: proposedPrompt,
      prompt_before: promptBefore,
      sections_changed: sectionsChanged,
      reasoning,
      no_changes: proposedPrompt.trim() === promptBefore.trim(),
      latency_ms: latencyMs,
      tokens_in: tokensIn,
      tokens_out: tokensOut,
    };
  });

// ── Server function: aplicar proposta no agente ────────────────────────────

export const applyPromptEdit = createServerFn({ method: "POST" })
  .inputValidator((d) =>
    z
      .object({
        requestId: z.string().uuid(),
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    const sb = getSelfhost();

    const req = await sb
      .from("ai_magic_requests")
      .select("agent_id, proposed_prompt, applied")
      .eq("id", data.requestId)
      .single();
    if (req.error || !req.data) throw new Error("Solicitação não encontrada.");
    if (req.data.applied) {
      return { ok: true, already_applied: true };
    }
    const proposedPrompt = req.data.proposed_prompt as string | null;
    if (!proposedPrompt) throw new Error("Sem prompt proposto para aplicar.");

    // Atualiza o prompt do agente
    const upd = await sb
      .from("agents")
      .update({ system_prompt: proposedPrompt })
      .eq("id", req.data.agent_id as string);
    if (upd.error) throw new Error(`Falha ao atualizar agente: ${upd.error.message}`);

    // Marca a solicitação como aplicada
    await sb
      .from("ai_magic_requests")
      .update({ applied: true, applied_at: new Date().toISOString() })
      .eq("id", data.requestId);

    return { ok: true, already_applied: false };
  });

// ── Server function: gerar sugestões contextuais ──────────────────────────

const SUGGESTIONS_SYSTEM = `Você é um curador de melhorias para prompts de agentes de atendimento.
Você lê o prompt completo do agente e devolve 4 SUGESTÕES DE AJUSTE
ESPECÍFICAS e CONTEXTUAIS — não genéricas. Cada sugestão deve:

1. Tocar uma seção concreta do prompt (PASSO X, OBJEÇÕES, etc.).
2. Estar redigida como instrução para o AI Magic editar (ex.:
   "Adicione objeção: ...", "Reforce que ...", "Troque ... por ...").
3. Ser CURTA (máximo 80 caracteres por sugestão).
4. Ser ACIONÁVEL — algo que o dono do agente possa querer ajustar.
5. NÃO repetir o que já existe no prompt. Aponte oportunidades reais
   de melhoria, não óbvias.

Considere especialmente:
- Pontos que parecem mecânicos / pouco humanos no fluxo
- Objeções que podem aparecer e não estão tratadas
- Tons que poderiam ser ajustados
- Regras que poderiam ser mais explícitas

# FORMATO DE SAÍDA (JSON puro)

{ "suggestions": ["sugestão 1", "sugestão 2", "sugestão 3", "sugestão 4"] }

Responda APENAS com esse JSON.`;

export const getAiMagicSuggestions = createServerFn({ method: "GET" })
  .inputValidator((d) =>
    z
      .object({
        accountId: z.string().min(1),
        agentId: z.string().uuid(),
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
      return { suggestions: [] as string[] };
    }
    const orKey = await decryptValue(secrets.data.openrouter_api_key_enc as unknown as string);
    if (!orKey) return { suggestions: [] as string[] };

    // 2. Prompt atual
    const agent = await sb
      .from("agents")
      .select("system_prompt")
      .eq("id", data.agentId)
      .single();
    const promptText = (agent.data?.system_prompt as string | null) ?? "";
    if (!promptText.trim()) return { suggestions: [] as string[] };

    // 3. GPT-4.1-mini (sugestões são curtas, não precisa do flagship)
    try {
      const res = await fetch(OPENROUTER_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${orKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "openai/gpt-4.1-mini",
          messages: [
            { role: "system", content: SUGGESTIONS_SYSTEM },
            {
              role: "user",
              content: `# PROMPT ATUAL DO AGENTE\n\n${promptText}\n\n---\n\nGere 4 sugestões contextuais de ajuste para esse prompt.`,
            },
          ],
          response_format: { type: "json_object" },
          temperature: 0.7, // alguma diversidade
          max_tokens: 600,
        }),
        signal: AbortSignal.timeout(30_000),
      });

      if (!res.ok) {
        console.warn(`[ai-magic-suggestions] OpenRouter ${res.status}`);
        return { suggestions: [] as string[] };
      }

      const json = (await res.json()) as {
        choices?: { message?: { content?: string } }[];
      };
      const content = (json.choices?.[0]?.message?.content ?? "").trim();
      if (!content) return { suggestions: [] as string[] };

      const parsed = JSON.parse(content) as { suggestions?: string[] };
      const suggestions = Array.isArray(parsed.suggestions)
        ? parsed.suggestions
            .map((s) => String(s).trim())
            .filter((s) => s.length > 5 && s.length <= 120)
            .slice(0, 4)
        : [];
      return { suggestions };
    } catch (e) {
      console.warn("[ai-magic-suggestions] falha:", e);
      return { suggestions: [] as string[] };
    }
  });

// ── Server function: histórico ─────────────────────────────────────────────

export const listAiMagicHistory = createServerFn({ method: "GET" })
  .inputValidator((d) =>
    z
      .object({
        agentId: z.string().uuid(),
        limit: z.number().int().min(1).max(50).default(20),
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    const sb = getSelfhost();
    const res = await sb
      .from("ai_magic_requests")
      .select(
        "id, user_message, summary, sections_changed, applied, applied_at, error, criado_em",
      )
      .eq("agent_id", data.agentId)
      .order("criado_em", { ascending: false })
      .limit(data.limit);
    if (res.error) throw new Error(res.error.message);
    return { items: res.data ?? [] };
  });

// ── Server function: versões aplicadas (para restaurar) ────────────────────

export const listPromptVersions = createServerFn({ method: "GET" })
  .inputValidator((d) => z.object({ agentId: z.string().uuid() }).parse(d))
  .handler(async ({ data }) => {
    const sb = getSelfhost();
    const res = await sb
      .from("ai_magic_requests")
      .select(
        "id, user_message, summary, sections_changed, prompt_before, proposed_prompt, applied, applied_at, criado_em",
      )
      .eq("agent_id", data.agentId)
      .eq("applied", true)
      .order("applied_at", { ascending: false })
      .limit(50);
    if (res.error) throw new Error(res.error.message);

    // Carrega também o prompt atual (versão "agora") para mostrar como referência
    const currentAgent = await sb
      .from("agents")
      .select("system_prompt")
      .eq("id", data.agentId)
      .single();

    return {
      current_prompt: (currentAgent.data?.system_prompt as string) ?? "",
      versions: res.data ?? [],
    };
  });

/**
 * Restaura o prompt do agente para uma versão anterior.
 * Cria uma nova entrada em ai_magic_requests com a operação de restauração
 * para manter o rastro de auditoria.
 */
export const restorePromptVersion = createServerFn({ method: "POST" })
  .inputValidator((d) =>
    z
      .object({
        agentId: z.string().uuid(),
        // Pode restaurar para o estado ANTES de uma edição (prompt_before)
        // ou para o estado DEPOIS de uma edição (proposed_prompt).
        sourceRequestId: z.string().uuid(),
        target: z.enum(["before", "after"]),
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    const sb = getSelfhost();

    // 1. Carrega a request fonte
    const src = await sb
      .from("ai_magic_requests")
      .select("account_id, agent_id, prompt_before, proposed_prompt, summary")
      .eq("id", data.sourceRequestId)
      .single();
    if (src.error || !src.data) throw new Error("Versão fonte não encontrada.");
    if ((src.data.agent_id as string) !== data.agentId) {
      throw new Error("Versão pertence a outro agente.");
    }

    const targetPrompt =
      data.target === "before"
        ? (src.data.prompt_before as string)
        : (src.data.proposed_prompt as string | null) ?? "";

    if (!targetPrompt) {
      throw new Error("Versão alvo está vazia.");
    }

    // 2. Pega o prompt atual para snapshot da nova entrada
    const currentAgent = await sb
      .from("agents")
      .select("system_prompt")
      .eq("id", data.agentId)
      .single();
    const currentPrompt = (currentAgent.data?.system_prompt as string) ?? "";

    if (currentPrompt === targetPrompt) {
      return { ok: true, already_current: true };
    }

    // 3. Atualiza o agente
    const upd = await sb
      .from("agents")
      .update({ system_prompt: targetPrompt })
      .eq("id", data.agentId);
    if (upd.error) throw new Error(`Falha ao restaurar: ${upd.error.message}`);

    // 4. Cria entrada de auditoria
    await sb.from("ai_magic_requests").insert({
      account_id: src.data.account_id,
      agent_id: data.agentId,
      user_message: `[RESTORE] Versão restaurada (${data.target === "before" ? "antes" : "depois"} de "${(src.data.summary as string | null)?.slice(0, 80) ?? "edição"}")`,
      prompt_before: currentPrompt,
      proposed_prompt: targetPrompt,
      summary: `Restaurada versão anterior do prompt.`,
      sections_changed: [],
      applied: true,
      applied_at: new Date().toISOString(),
      model: "system",
    });

    return { ok: true, restored_prompt: targetPrompt };
  });
