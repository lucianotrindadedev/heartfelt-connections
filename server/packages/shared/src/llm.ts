// ---------------------------------------------------------------------------
// OpenRouter LLM client – supports tool/function calling
// ---------------------------------------------------------------------------

export interface LlmMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_call_id?: string;
  tool_calls?: ToolCall[];
}

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface LlmToolDef {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface LlmResponse {
  content: string;
  toolCalls: ToolCall[];
  tokensIn: number;
  tokensOut: number;
  model: string;
}

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

export async function callLlm(opts: {
  apiKey: string;
  model: string;
  messages: LlmMessage[];
  tools?: LlmToolDef[];
  temperature?: number;
  maxTokens?: number;
}): Promise<LlmResponse> {
  const body: Record<string, unknown> = {
    model: opts.model,
    messages: opts.messages,
  };

  if (opts.tools && opts.tools.length > 0) {
    body.tools = opts.tools;
  }
  if (opts.temperature !== undefined) {
    body.temperature = opts.temperature;
  }
  if (opts.maxTokens !== undefined) {
    body.max_tokens = opts.maxTokens;
  }

  const res = await fetch(OPENROUTER_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${opts.apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://sarai.app",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(
      `OpenRouter request failed (${res.status} ${res.statusText}): ${text}`,
    );
  }

  const json = (await res.json()) as {
    choices: {
      message: {
        content?: string | null;
        tool_calls?: ToolCall[];
      };
    }[];
    usage?: { prompt_tokens: number; completion_tokens: number };
    model: string;
  };

  const msg = json.choices?.[0]?.message;

  return {
    content: msg?.content ?? "",
    toolCalls: msg?.tool_calls ?? [],
    tokensIn: json.usage?.prompt_tokens ?? 0,
    tokensOut: json.usage?.completion_tokens ?? 0,
    model: json.model,
  };
}
