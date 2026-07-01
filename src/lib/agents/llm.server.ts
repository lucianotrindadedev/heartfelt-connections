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
    /** DeepSeek-Reasoner e Grok colocam chain-of-thought aqui. */
    reasoning?: string | null;
    reasoning_content?: string | null;
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
    // Modelos com reasoning (gemini-flash, gpt-mini) queimam o max_tokens em
    // raciocínio oculto e truncam o reply (vimos tokens_out=2031 com ~150
    // chars de texto). Para agentes operacionais, reasoning curto basta.
    // OpenRouter ignora o parâmetro em modelos sem reasoning.
    reasoning: { effort: "low" },
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

  // Alguns modelos (DeepSeek-Reasoner, Grok com thinking) colocam o output em
  // message.reasoning ou message.reasoning_content em vez de message.content.
  // Se o content vier vazio mas o reasoning tem texto, usamos o reasoning.
  const primaryContent = message?.content?.trim() ?? "";
  const reasoning =
    (message?.reasoning ?? "").trim() || (message?.reasoning_content ?? "").trim();
  // Em jsonMode, o reasoning é "pensamento" em prosa — NUNCA JSON válido. Usá-lo
  // como content quebra o JSON.parse e ainda impede o retry de content-vazio do
  // callLlmStructured (que precisa ver content vazio para reagir). Só
  // aproveitamos reasoning como conteúdo em respostas de TEXTO LIVRE.
  const useReasoningAsContent = !primaryContent && !!reasoning && !req.jsonMode;
  const finalContent = primaryContent || (useReasoningAsContent ? reasoning : null);

  if (useReasoningAsContent) {
    console.warn(
      `[llm] content vazio mas reasoning preenchido (${reasoning.length} chars) — usando reasoning como fallback. model=${req.model}`,
    );
  }

  return {
    content: finalContent,
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
 * Escapa quebras de linha literais (\n \r \t) que estão DENTRO de strings.
 * Alguns LLMs (GPT, Gemini, etc.) às vezes geram JSON com newlines literais
 * em campos de texto longo — JSON.parse rejeita isso. Esta função faz o
 * escape sem quebrar JSON válido.
 */
function fixUnescapedNewlinesInStrings(raw: string): string {
  let result = "";
  let inString = false;
  let escapeNext = false;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (escapeNext) {
      result += c;
      escapeNext = false;
      continue;
    }
    if (c === "\\") {
      result += c;
      escapeNext = true;
      continue;
    }
    if (c === '"') {
      result += c;
      inString = !inString;
      continue;
    }
    if (inString) {
      if (c === "\n") {
        result += "\\n";
        continue;
      }
      if (c === "\r") {
        result += "\\r";
        continue;
      }
      if (c === "\t") {
        result += "\\t";
        continue;
      }
    }
    result += c;
  }
  return result;
}

/**
 * Tenta recuperar um JSON truncado fechando strings/objetos abertos.
 * Usado quando o LLM atinge max_tokens no meio de um objeto.
 *
 * Estratégia em três fases:
 *  1. Escapa newlines literais dentro de strings (LLMs às vezes esquecem).
 *  2. Sanitiza o final: remove campos sem valor (`"foo":` no fim) e
 *     fragmentos de string (`"valor incompl...`).
 *  3. Conta `{` `[` abertos e fecha na ordem inversa.
 *
 * Se mesmo assim não parsear, vai removendo o último caractere até virar
 * JSON válido (pior caso preserva pelo menos `reply` e `next_stage`).
 */
function recoverTruncatedJson(raw: string): unknown {
  // Fase 0: escapa newlines literais dentro de strings ANTES de tudo
  let s = fixUnescapedNewlinesInStrings(raw).trim();

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

/**
 * Identifica erros que justificam tentar o próximo modelo da cadeia.
 * - 5xx: provider down / model temporariamente indisponível
 * - 429: rate limited → talvez outro provider tenha quota
 * - 408 / timeout / AbortError: modelo muito lento
 * - content vazio com finish_reason !== 'stop': modelo travou
 */
function isFallbackWorthy(err: unknown): boolean {
  if (err instanceof LlmError) {
    if (err.status >= 500) return true;
    if (err.status === 429) return true;
    if (err.status === 408) return true;
    // Erros específicos do OpenRouter que indicam modelo indisponível
    const body = (err.body ?? "").toLowerCase();
    if (
      body.includes("model_not_found") ||
      body.includes("no allowed providers") ||
      body.includes("provider returned error") ||
      body.includes("temporarily unavailable")
    ) {
      return true;
    }
    return false;
  }
  if (err instanceof Error) {
    if (err.name === "AbortError" || err.name === "TimeoutError") return true;
    if (err.message.toLowerCase().includes("timeout")) return true;
    if (err.message.toLowerCase().includes("fetch failed")) return true;
  }
  return false;
}

/**
 * Versão do callLlm com cadeia de fallback. Tenta `req.model` primeiro;
 * em erro fallback-worthy ou content vazio, tenta cada `fallbackModels`
 * em ordem. Retorna o primeiro sucesso. Se todos falharem, joga o último erro.
 *
 * Loga cada tentativa com o motivo do fallback.
 */
export async function callLlmWithFallback(
  orKey: string,
  req: LlmRequest,
  fallbackModels: string[] = [],
): Promise<LlmResponse & { modelUsed: string; fallbackUsed: boolean }> {
  const models = [req.model, ...fallbackModels.filter((m) => m && m !== req.model)];
  let lastErr: unknown = null;

  for (let i = 0; i < models.length; i++) {
    const model = models[i];
    try {
      let r = await callLlm(orKey, { ...req, model });
      // finish_reason=length: texto cortado no meio (modelos com reasoning
      // queimam o orçamento em raciocínio oculto). Retry com budget maior
      // antes de entregar mensagem truncada ao lead.
      if (r.finishReason === "length" && r.content && (r.toolCalls?.length ?? 0) === 0) {
        const biggerBudget = Math.max(4096, (req.maxTokens ?? 1024) * 2);
        console.warn(
          `[llm-fallback] finish_reason=length model=${model} tokens_out=${r.tokensOut} — retry com max_tokens=${biggerBudget}`,
        );
        const retry = await callLlm(orKey, { ...req, model, maxTokens: biggerBudget });
        if (retry.content) r = retry;
      }
      // Content vazio + finish=tool_calls é COMPORTAMENTO CORRETO: o LLM
      // decidiu chamar uma tool em vez de responder. Não pode ser tratado
      // como falha — senão o fallback executa o mesmo prompt em outro
      // modelo perdendo a tool call original (e o agendamento vira fake).
      const hasToolCalls = (r.toolCalls?.length ?? 0) > 0;
      const isEmptyTextNoTools = !r.content && !hasToolCalls;
      if (isEmptyTextNoTools && i < models.length - 1) {
        console.warn(
          `[llm-fallback] model=${model} retornou content vazio sem tool_calls (finish=${r.finishReason}) — tentando próximo`,
        );
        lastErr = new LlmError(200, `empty content from ${model}`);
        continue;
      }
      if (i > 0) {
        console.log(`[llm-fallback] sucesso com fallback model=${model} (após ${i} falhas)`);
      }
      return { ...r, modelUsed: model, fallbackUsed: i > 0 };
    } catch (e) {
      lastErr = e;
      if (!isFallbackWorthy(e)) {
        // Erro irrecuperável (400/401/403/etc.): não tenta os próximos.
        throw e;
      }
      console.warn(
        `[llm-fallback] model=${model} falhou (${e instanceof Error ? e.message : e}) — tentando próximo`,
      );
    }
  }
  throw lastErr ?? new LlmError(500, "Todos os modelos falharam sem erro registrado");
}

/**
 * Versão structured de callLlmWithFallback. Tenta cada modelo da cadeia;
 * em cada modelo, executa o mesmo flow de retry/parse do callLlmStructured.
 * Só passa pro próximo modelo em erro fallback-worthy.
 */
export async function callLlmStructuredWithFallback<T>(
  orKey: string,
  req: LlmRequest,
  parse: (raw: unknown) => T,
  fallbackModels: string[] = [],
): Promise<{ result: T; response: LlmResponse; modelUsed: string; fallbackUsed: boolean }> {
  const models = [req.model, ...fallbackModels.filter((m) => m && m !== req.model)];
  let lastErr: unknown = null;
  for (let i = 0; i < models.length; i++) {
    const model = models[i];
    try {
      const r = await callLlmStructured(orKey, { ...req, model }, parse);
      if (i > 0) {
        console.log(
          `[llm-fallback-structured] sucesso com fallback model=${model} (após ${i} falhas)`,
        );
      }
      return { ...r, modelUsed: model, fallbackUsed: i > 0 };
    } catch (e) {
      lastErr = e;
      // Além dos erros de disponibilidade, também acionamos o fallback quando o
      // modelo devolve content vazio / JSON inválido (LlmError 200). Isso é
      // comum em modelos com reasoning (ex.: gemini-flash gastando o output em
      // "pensamento") — o modelo de fallback costuma salvar o turno.
      // Um ZodError (schema validation) tem a MESMA causa: o modelo devolveu um
      // JSON que não bate com o schema (ex.: faltando "reply"). Antes ele era
      // lançado direto SEM tentar fallback — o que derrubava o turno inteiro
      // ("instabilidade técnica"). Agora também aciona o fallback.
      const schemaIssue =
        !!e &&
        typeof e === "object" &&
        ((e as { name?: string }).name === "ZodError" ||
          Array.isArray((e as { issues?: unknown }).issues));
      const contentIssue = (e instanceof LlmError && e.status === 200) || schemaIssue;
      if (!isFallbackWorthy(e) && !contentIssue) throw e;
      console.warn(
        `[llm-fallback-structured] model=${model} falhou (${e instanceof Error ? e.message : e}) — tentando próximo`,
      );
    }
  }
  throw lastErr ?? new LlmError(500, "Todos os modelos falharam");
}

export async function callLlmStructured<T>(
  orKey: string,
  req: LlmRequest,
  parse: (raw: unknown) => T,
): Promise<{ result: T; response: LlmResponse }> {
  let response = await callLlm(orKey, { ...req, jsonMode: true });

  // finish_reason=length → o modelo estourou max_tokens no meio do JSON.
  // Modelos com reasoning (gpt-mini, gemini-flash) queimam o orçamento em
  // raciocínio oculto e sobra um reply de ~40 chars. Se aceitarmos o salvage
  // (recoverTruncatedJson), o lead recebe mensagem CORTADA no meio da palavra.
  // Retry com orçamento maior antes de qualquer tentativa de parse/salvage.
  if (response.finishReason === "length") {
    const biggerBudget = Math.max(4096, (req.maxTokens ?? 1024) * 2);
    console.warn(
      `[llm] finish_reason=length model=${req.model} tokens_out=${response.tokensOut} — retry com max_tokens=${biggerBudget}`,
    );
    const retry = await callLlm(orKey, { ...req, maxTokens: biggerBudget, jsonMode: true });
    if (retry.content) response = retry;
  }

  // Retry quando o modelo retorna content vazio (alguns modelos travam em
  // response_format: json_object, ou erram a 1ª chamada). Retry sem jsonMode
  // e com prompt mais explícito permite recuperar o turno.
  if (!response.content) {
    console.warn(
      `[llm] retry após content vazio: model=${req.model} finish_reason=${response.finishReason} tokens_out=${response.tokensOut}`,
    );
    const retryMessages = [
      ...req.messages,
      {
        role: "user" as const,
        content:
          "Sua última resposta veio vazia. Responda agora APENAS com o JSON exigido pelo schema, em uma única linha — sem texto antes nem depois, sem markdown, sem ```json.",
      },
    ];
    response = await callLlm(orKey, {
      ...req,
      messages: retryMessages,
      jsonMode: false, // libera o modelo de tentar montar o response_format
      temperature: Math.max(0.3, (req.temperature ?? 0.5) - 0.2),
    });
  }

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
    // Antes de tudo: tenta escapar newlines literais dentro de strings
    // (LLMs frequentemente esquecem disso em campos de texto longo).
    try {
      parsed = JSON.parse(fixUnescapedNewlinesInStrings(response.content));
      console.warn("[llm] recovered JSON com newlines não-escapadas em strings");
    } catch {
      // 1. Tenta extrair JSON de bloco markdown ```json ... ```
      const match = response.content.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (match) {
        try { parsed = JSON.parse(match[1]); }
        catch {
          try { parsed = JSON.parse(fixUnescapedNewlinesInStrings(match[1])); }
          catch {
            // 2. Tenta recuperar JSON truncado dentro do bloco
            try { parsed = recoverTruncatedJson(match[1]); }
            catch {
              throw new LlmError(200, `LLM retornou JSON inválido: ${response.content.slice(0, 300)}`);
            }
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
  }
  const result = parse(parsed);
  return { result, response };
}
