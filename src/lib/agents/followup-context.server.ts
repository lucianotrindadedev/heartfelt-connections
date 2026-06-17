// Sub-agente de follow-up CONTEXTUAL.
// Recebe o histórico da conversa + instrução do step + system prompt do agente
// e gera UMA mensagem de reengajamento curta, alinhada ao tom do agente.
//
// Não usa o orchestrator/qualifier — é uma chamada LLM única, sem tools.

import { getSelfhost } from "@/integrations/selfhost/client.server";
import { decryptValue } from "@/lib/crypto.server";
import { DEFAULT_AUX_FALLBACK_MODEL, DEFAULT_LLM_MODEL } from "@/lib/llm-defaults";
import { callLlmWithFallback, type LlmMessage } from "./llm.server";

interface FollowupContextInput {
  accountId: string;
  agentId: string;
  conversationId: string;
  stepInstruction: string;
  stepOrdem: number;
}

interface FollowupContextOutput {
  reply: string;
  model: string;
  tokens_in: number;
  tokens_out: number;
  cost_usd: number;
}

export async function generateContextualFollowup(
  input: FollowupContextInput,
): Promise<FollowupContextOutput> {
  const sb = getSelfhost();

  // 1. Chave OpenRouter
  const secrets = await sb
    .from("account_secrets")
    .select("openrouter_api_key_enc")
    .eq("account_id", input.accountId)
    .single();
  if (!secrets.data?.openrouter_api_key_enc) {
    throw new Error("OpenRouter não configurada para a conta.");
  }
  const orKey = await decryptValue(secrets.data.openrouter_api_key_enc as unknown as string);
  if (!orKey) throw new Error("Falha ao descriptografar OpenRouter key.");

  // 2. Carrega agente
  const [agent, llmCfg] = await Promise.all([
    sb
      .from("agents")
      .select("id, system_prompt, settings, llm_model_override")
      .eq("id", input.agentId)
      .single(),
    sb
      .from("account_llm_config")
      .select("default_model, max_tokens, temperature")
      .eq("account_id", input.accountId)
      .single(),
  ]);
  if (agent.error || !agent.data) throw new Error("Agente não encontrado.");

  const model =
    (agent.data.llm_model_override as string | null) ||
    (llmCfg.data?.default_model as string | undefined) ||
    DEFAULT_LLM_MODEL;

  const basePrompt = (agent.data.system_prompt as string) || "";
  const settings = (agent.data.settings as Record<string, string> | null) ?? {};

  // 3. Histórico da conversa (últimas 20 mensagens)
  const msgs = await sb
    .from("messages")
    .select("role, content, criado_em")
    .eq("conversation_id", input.conversationId)
    .order("criado_em", { ascending: false })
    .limit(20);
  const history =
    msgs.data
      ?.slice()
      .reverse()
      .filter((m) => m.role === "user" || m.role === "assistant")
      .map((m) => ({
        role: (m.role === "user" ? "user" : "assistant") as "user" | "assistant",
        content: (m.content as string) || "",
      })) ?? [];

  if (history.length === 0) {
    throw new Error("Conversa sem histórico — não é possível gerar follow-up contextual.");
  }

  // 4. Monta system prompt do follow-up
  const followupSystem = `Você é ${settings.assistant_name || "a assistente"} da ${settings.company_name || "empresa"}.

Você está enviando uma mensagem de FOLLOW-UP nº ${input.stepOrdem} para um lead
que NÃO respondeu há um tempo. Sua missão é reengajar SEM ser invasivo nem
soar como cobrança.

# REGRAS

1. Gere APENAS uma mensagem curta (1-3 frases, máximo 250 caracteres).
2. Use o histórico para personalizar — referencie algo da conversa, não genérico.
3. Termine com uma pergunta aberta que estimule resposta.
4. Mantenha o tom já estabelecido nas suas mensagens anteriores (não fique
   formal de repente se foi descontraído antes, e vice-versa).
5. NUNCA peça desculpa por "incomodar" nem use palavras como "perdão", "desculpe".
6. NUNCA mande lembretes do tipo "lembre-se que..." — soa robótico.
7. Não mencione que é "follow-up" nem que o lead "não respondeu".

# INSTRUÇÃO ESPECÍFICA DESTE FOLLOW-UP (definida pelo dono do agente)

${input.stepInstruction}

# CONTEXTO DO AGENTE (resumido)

${basePrompt.slice(0, 3000)}

# FORMATO DE SAÍDA

Responda APENAS com o texto da mensagem que será enviada. Sem JSON, sem
prefixos, sem "Resposta:", apenas o texto.`;

  // 5. Chama LLM via callLlmWithFallback — ele já faz: retry com budget MAIOR
  //    quando finish_reason=length (modelos com reasoning, ex.: gemini-flash,
  //    queimam tokens em "pensamento" e truncavam o follow-up) + fallback de
  //    modelo se o principal falhar. Antes, o fetch cru descartava a mensagem na
  //    1ª truncagem (era a causa de "[followup-seq] contextual falhou").
  const messages: LlmMessage[] = [
    ...history,
    {
      role: "user",
      content:
        "(Sistema: o lead não respondeu desde sua última mensagem. Gere agora APENAS o texto do follow-up #" +
        input.stepOrdem +
        ".)",
    },
  ];

  const turn = await callLlmWithFallback(
    orKey,
    {
      model,
      systemDynamic: followupSystem,
      messages,
      temperature: 0.7,
      maxTokens: 1500,
    },
    model === DEFAULT_AUX_FALLBACK_MODEL ? [] : [DEFAULT_AUX_FALLBACK_MODEL],
  );

  const reply = (turn.content ?? "").trim();
  if (!reply) throw new Error("LLM retornou resposta vazia.");
  // Salvaguarda: se ainda truncou mesmo após o retry de budget maior, descarta.
  if (turn.finishReason === "length") {
    throw new Error(
      `Follow-up truncado mesmo após retry (tokens_out=${turn.tokensOut}) — mensagem descartada.`,
    );
  }

  return {
    reply,
    model: turn.modelUsed,
    tokens_in: turn.tokensIn,
    tokens_out: turn.tokensOut,
    cost_usd: turn.costUsd,
  };
}
