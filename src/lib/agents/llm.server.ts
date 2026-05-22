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
    // 2048 é seguro para output estruturado em PT-BR (reply + lead_data_patch +
    // reasoning). 1024 podia truncar quando o reasoning vinha mais detalhado,
    // fazendo o JSON quebrar no meio do campo lead_data_patch.
    max_tokens: req.maxTokens ?? 2048,
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
/**
 * Tenta recuperar um JSON truncado fechando strings/objetos abertos.
 * Usado quando o LLM atinge max_tokens no meio de um objeto.
 *
 * Estratégia em duas fases:
 *  1. Sanitiza o final: remove campos sem valor (`"foo":` no fim) e
 *     fragmentos de string (`"valor incompl...`).
 *  2. Conta `{` `[` abertos e fecha na ordem inversa.
 *
 * Se mesmo assim não parsear, vai removendo o último caractere até virar
 * JSON válido (pior caso preserva pelo menos `reply` e `next_stage`).
 */
function recoverTruncatedJson(raw: string): unknown {
  let s = raw.trim();

  // ── Fase 1: contagem de estados ──
  let inString = false;
  let escapeNext = false;
  const stack: string[] = []; // pares de fechamento (' }' ou ' ]')

  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (escapeNext) { escapeNext = false; continue; }
    if (c === "\\") { escapeNext = true; continue; }
    if (c === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (c === "{") stack.push("}");
    else if (c === "[") stack.push("]");
    else if (c === "}" || c === "]") stack.pop();
  }

  // Se ficou string aberta, fecha-a
  if (inString) s += '"';

  // ── Fase 2: limpeza de fragmentos no final ──
  // Remove "field": "string-truncada (sem fechar) - mas só se string ESTAVA aberta
  // OBS: já fechamos a string acima; agora removemos campos pendentes
  // Vários padrões podem aparecer no final dependendo do truncamento:
  s = s.replace(/,\s*$/, ""); // trailing comma solta
  s = s.replace(/[,{[]?\s*"[^"]*"\s*:\s*$/, (m) => (m.startsWith("{") ? "{" : "")); // "campo": sem valor
  s = s.replace(/[,{[]?\s*"[^"]*"\s*:\s*""\s*$/, (m) => (m.startsWith("{") ? "{" : "")); // "campo": ""
  s = s.replace(/,\s*$/, ""); // trailing comma após cleanup

  // ── Fase 3: fecha aberturas pendentes ──
  while (stack.length > 0) s += stack.pop();

  try {
    return JSON.parse(s);
  } catch {
    // Último recurso: vai cortando do fim até parsear (preserva campos do começo)
    for (let cut = s.length - 1; cut > 10; cut--) {
      if (s[cut] !== "}" && s[cut] !== '"') continue;
      const attempt = s.slice(0, cut + 1).replace(/,\s*$/, "");
      // Fecha braces pendentes nessa fatia
      const sub = stack.slice();
      let inStr = false, esc = false;
      const local: string[] = [];
      for (let i = 0; i < attempt.length; i++) {
        const c = attempt[i];
        if (esc) { esc = false; continue; }
        if (c === "\\") { esc = true; continue; }
        if (c === '"') { inStr = !inStr; continue; }
        if (inStr) continue;
        if (c === "{") local.push("}");
        else if (c === "[") local.push("]");
        else if (c === "}" || c === "]") local.pop();
      }
      let closed = attempt;
      while (local.length > 0) closed += local.pop();
      try { return JSON.parse(closed); } catch { /* tenta próximo */ }
      // unused
      void sub;
    }
    throw new SyntaxError("Não foi possível recuperar JSON truncado");
  }
}

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
    // 1. Tenta extrair JSON de bloco markdown ```json ... ```
    const match = response.content.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (match) {
      try { parsed = JSON.parse(match[1]); }
      catch {
        // 2. Tenta recuperar JSON truncado dentro do bloco
        try { parsed = recoverTruncatedJson(match[1]); }
        catch {
          throw new LlmError(200, `LLM retornou JSON inválido: ${response.content.slice(0, 300)}`);
        }
      }
    } else {
      // 3. Tenta recuperar JSON truncado direto
      try {
        parsed = recoverTruncatedJson(response.content);
        console.warn(
          `[llm] recovered truncated JSON (finish_reason=${response.finishReason}, tokens_out=${response.tokensOut})`,
        );
      } catch {
        throw new LlmError(200, `LLM retornou JSON inválido: ${response.content.slice(0, 300)}`);
      }
    }
  }
  const result = parse(parsed);
  return { result, response };
}
