// Helper unificado para chamar LLM via OpenRouter com:
// - Structured output (modelo retorna JSON validável)
// - Tool calling (OpenAI-compatible)
// - Prompt caching do Anthropic (cache_control nas partes estáticas)
// - Timeout configurável
// - Métricas (latency, tokens) retornadas
//
// Cada sub-agente (triage/qualifier/scheduler) usa este helper.

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const DEFAULT_TIMEOUT_MS = 60_000;

export interface LlmTool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface LlmToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface LlmMessage {
  role: "system" | "user" | "assistant" | "tool";
  /** String simples OU array de content blocks (suporta cache_control do Anthropic). */
  content:
    | string
    | null
    | Array<{
        type: "text";
        text: string;
        cache_control?: { type: "ephemeral" };
      }>;
  tool_calls?: LlmToolCall[];
  tool_call_id?: string;
  name?: string;
}

export interface LlmRequest {
  model: string;
  /** Bloco de sistema imutável (persona, regras gerais). Será marcado para cache. */
  systemCached?: string;
  /** Bloco de sistema dinâmico (data atual, dados do lead). NÃO cacheado. */
  systemDynamic?: string;
  /** Histórico user/assistant/tool. */
  messages: LlmMessage[];
  /** Ferramentas disponíveis. Se omitido, modelo só pode retornar texto/json. */
  tools?: LlmTool[];
  /** "auto" (padrão), "required", "none" ou ferramenta específica. */
  toolChoice?: "auto" | "required" | "none" | { type: "function"; function: { name: string } };
  /** Força JSON output (response_format = json_object). */
  jsonMode?: boolean;
  maxTokens?: number;
  temperature?: number;
  timeoutMs?: number;
  /** Se true, ativa cache_control no systemCached (Anthropic via OpenRouter). */
  enableCaching?: boolean;
}

export interface LlmResponse {
  content: string | null;
  toolCalls: LlmToolCall[];
  finishReason?: string;
  tokensIn: number;
  tokensOut: number;
  cachedTokens: number;
  /** Custo em USD retornado pela OpenRouter (campo usage.cost). 0 quando não disponível. */
  costUsd: number;
  /** ID da geração OpenRouter (ex: "gen-abc123"). Útil para buscar custo via /api/v1/generation. */
  generationId?: string;
  latencyMs: number;
  rawJson?: unknown;
}

export class LlmError extends Error {
  constructor(public status: number, message: string, public body?: string) {
    super(message);
    this.name = "LlmError";
  }
}

interface OpenRouterChoice {
  message?: {
    content?: string | null;
    tool_calls?: LlmToolCall[];
  };
  finish_reason?: string;
}

interface OpenRouterUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
  /** Custo em USD retornado diretamente pela OpenRouter (ex: 0.000015). */
  cost?: number;
}

interface OpenRouterResponseRaw {
  /** ID da geração (ex: "gen-abc123") — usado para buscar custo via /api/v1/generation */
  id?: string;
  choices?: OpenRouterChoice[];
  usage?: OpenRouterUsage;
}

/**
 * Monta o array de messages incluindo o system block.
 * Quando enableCaching=true, o systemCached vira um content block com
 * cache_control={type:"ephemeral"} — válido para modelos Anthropic via
 * OpenRouter (prefixo anthropic/).
 */
function buildMessages(req: LlmRequest): LlmMessage[] {
  const out: LlmMessage[] = [];
  const hasCached = !!req.systemCached?.trim();
  const hasDynamic = !!req.systemDynamic?.trim();

  if (hasCached && req.enableCaching) {
    // Anthropic prompt cache via content blocks.
    out.push({
      role: "system",
      content: [
        {
          type: "text",
          text: req.systemCached!,
          cache_control: { type: "ephemeral" },
        },
        ...(hasDynamic ? [{ type: "text" as const, text: req.systemDynamic! }] : []),
      ],
    });
  } else if (hasCached || hasDynamic) {
    out.push({
      role: "system",
      content: [req.systemCached, req.systemDynamic].filter(Boolean).join("\n\n"),
    });
  }

  out.push(...req.messages);
  return out;
}

export async function callLlm(
  orKey: string,
  req: LlmRequest,
): Promise<LlmResponse> {
  const body: Record<string, unknown> = {
    model: req.model,
    messages: buildMessages(req),
    max_tokens: req.maxTokens ?? 1024,
    temperature: req.temperature ?? 0.5,
  };

  if (req.tools && req.tools.length > 0) {
    body.tools = req.tools;
    body.tool_choice = req.toolChoice ?? "auto";
  }
  if (req.jsonMode) {
    body.response_format = { type: "json_object" };
  }

  const t0 = Date.now();
  const timeoutMs = req.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const res = await fetch(OPENROUTER_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${orKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://saraie7.com",
      "X-Title": "Sarai Agent Platform",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });

  const latencyMs = Date.now() - t0;

  if (!res.ok) {
    const errBody = await res.text();
    throw new LlmError(res.status, `OpenRouter ${res.status}: ${errBody.slice(0, 200)}`, errBody);
  }

  const json = (await res.json()) as OpenRouterResponseRaw;
  const choice = json.choices?.[0];
  const message = choice?.message;
  const usage = json.usage ?? {};

  return {
    content: message?.content?.trim() ?? null,
    toolCalls: message?.tool_calls ?? [],
    finishReason: choice?.finish_reason,
    tokensIn: usage.prompt_tokens ?? 0,
    tokensOut: usage.completion_tokens ?? 0,
    cachedTokens: usage.prompt_tokens_details?.cached_tokens ?? 0,
    costUsd: usage.cost ?? 0,
    generationId: json.id,
    latencyMs,
    rawJson: json,
  };
}

/**
 * Conveniência: força JSON parsing do content e valida com a função `parse`.
 * Retorna o resultado tipado + a response completa para logging.
 *
 * Faz UM retry automático com tool_choice="none" + jsonMode se o primeiro
 * retorno não for JSON parseável (acontece quando o modelo decide chamar tool).
 */
export async function callLlmStructured<T>(
  orKey: string,
  req: LlmRequest,
  parse: (raw: unknown) => T,
): Promise<{ result: T; response: LlmResponse }> {
  const response = await callLlm(orKey, { ...req, jsonMode: true });
  if (!response.content) {
    throw new LlmError(
      200,
      `LLM retornou content vazio (finish_reason=${response.finishReason}, tokens_out=${response.tokensOut})`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(response.content);
  } catch {
    // Tenta extrair JSON de bloco markdown ```json ... ```
    const match = response.content.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (!match) {
      throw new LlmError(200, `LLM retornou JSON inválido: ${response.content.slice(0, 200)}`);
    }
    parsed = JSON.parse(match[1]);
  }
  const result = parse(parsed);
  return { result, response };
}
