// RAG Gate Agent — decide se a mensagem do lead precisa de busca na base
// de conhecimento ANTES de chamar embedding + vector search + injetar
// chunks no system prompt do agente principal (caro).
//
// Por que existe:
//   - 60-80% das mensagens em conversas são saudações, confirmações,
//     "ok", "tudo bem", "blz" etc. — não precisam de RAG.
//   - Cada chamada de RAG = 1 embedding API call + 1 vector search +
//     ~500-2000 tokens injetados no prompt do main agent.
//   - Usar um modelo bem barato (Grok-4-fast / Haiku) custa ~1/50 do
//     custo dos tokens economizados.
//
// O Gate também faz query rewriting: se o lead pergunta "e quanto custa
// isso?" referenciando algo da conversa, o Gate transforma em uma query
// bem formada pra busca vetorial.

import { callLlm, type LlmMessage } from "./llm.server";

export interface RagGateDecision {
  need: boolean;
  /** Query reescrita pronta pra busca (vazia se need=false). */
  query: string;
  reasoning?: string;
}

/**
 * Decide se vale fazer RAG na mensagem atual do lead.
 *
 * Critérios:
 *   - need=false: saudações, confirmações curtas, despedidas, expressões
 *     vagas sem pergunta específica.
 *   - need=true: pergunta sobre produto/serviço/preço/processo, dúvidas
 *     técnicas, pedidos de info específica.
 *
 * Em caso de erro/timeout, falla com need=true (retrieval é "best effort"
 * — melhor buscar e não precisar do que precisar e não buscar).
 */
export async function decideRagNeed(
  orKey: string,
  model: string,
  history: { role: "user" | "assistant"; content: string }[],
  lastUserMsg: string,
): Promise<RagGateDecision> {
  if (!lastUserMsg.trim()) return { need: false, query: "" };

  // Atalho mecânico: msgs muito curtas (≤ 10 chars) quase nunca precisam de RAG.
  // Confirmação grosseira por padrão regex — evita até chamar o LLM.
  const trivial = /^(oi|olá|ola|hey|hi|ok|certo|sim|nao|não|blz|beleza|tudo bem|bom dia|boa tarde|boa noite|valeu|obrigado|obrigada|tchau|aham|certinho)[.!?\s]*$/i;
  if (lastUserMsg.trim().length <= 10 || trivial.test(lastUserMsg.trim())) {
    return { need: false, query: "", reasoning: "trivial" };
  }

  const recentDialogue = history
    .slice(-4)
    .map((m) => `${m.role === "user" ? "Lead" : "Agente"}: ${m.content}`)
    .join("\n");

  const systemPrompt = `Você é um classificador. Decide se a mensagem atual do lead requer busca na base de conhecimento do negócio (produtos, preços, processos, regras, FAQ).

Responda APENAS com JSON neste formato:
{"need": boolean, "query": "string", "reason": "string curta"}

Regras:
- need=true quando a msg pergunta sobre algo específico (preço, serviço, processo, dúvida técnica, requisito).
- need=false para saudações, confirmações, despedidas, ou conversa social sem pergunta de info.
- query: se need=true, reescreva como busca SEMÂNTICA bem formada (resolve pronomes do histórico). Se need=false, deixe "".
- Seja restritivo: na dúvida, prefira need=false. RAG é caro.`;

  const messages: LlmMessage[] = [
    {
      role: "user",
      content: `## Diálogo recente\n${recentDialogue || "(início da conversa)"}\n\n## Mensagem atual do lead\n${lastUserMsg}\n\nResponda com o JSON.`,
    },
  ];

  try {
    const res = await callLlm(orKey, {
      model,
      systemDynamic: systemPrompt,
      messages,
      jsonMode: true,
      maxTokens: 200,
      temperature: 0.1,
      timeoutMs: 10_000,
    });
    if (!res.content) return { need: true, query: lastUserMsg, reasoning: "gate_empty_content" };

    try {
      const parsed = JSON.parse(res.content) as {
        need?: boolean;
        query?: string;
        reason?: string;
      };
      return {
        need: !!parsed.need,
        query: (parsed.query ?? "").trim() || lastUserMsg,
        reasoning: parsed.reason,
      };
    } catch {
      return { need: true, query: lastUserMsg, reasoning: "gate_parse_error" };
    }
  } catch (e) {
    console.warn(
      `[rag-gate] falhou (${e instanceof Error ? e.message : e}) — fallback need=true`,
    );
    return { need: true, query: lastUserMsg, reasoning: "gate_error" };
  }
}
