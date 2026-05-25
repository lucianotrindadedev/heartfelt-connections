// Embeddings via OpenAI text-embedding-3-small (1536 dimensões).
// Custo: $0.02 / 1M tokens — desprezível para uso normal.
//
// Por que OpenAI direto e não OpenRouter:
//   - OpenRouter não expõe endpoint /embeddings.
//   - text-embedding-3-small é o melhor custo-benefício do mercado em 2026.
//
// A chave OPENAI_API_KEY é configurada no servidor (env var Coolify), não
// por conta — embeddings são infraestrutura da plataforma, não custo cobrado
// individualmente por cliente.

const OPENAI_EMBED_URL = "https://api.openai.com/v1/embeddings";
const EMBED_MODEL = "text-embedding-3-small";
const EMBED_DIMENSIONS = 1536;
const BATCH_LIMIT = 64; // OpenAI aceita até ~2048 inputs por chamada — usamos 64 por segurança

interface EmbeddingResponse {
  data: { embedding: number[]; index: number }[];
  usage?: { prompt_tokens?: number; total_tokens?: number };
}

function getApiKey(): string {
  const k = process.env.OPENAI_API_KEY?.trim();
  if (!k) {
    throw new Error(
      "OPENAI_API_KEY não configurada no servidor. Adicione em Coolify para habilitar embeddings.",
    );
  }
  return k;
}

/** Gera embedding de UM texto. Resultado: array de 1536 floats. */
export async function embedText(text: string): Promise<number[]> {
  const apiKey = getApiKey();
  const trimmed = text.trim().slice(0, 8000); // OpenAI limit ~8191 tokens — cortar ~32k chars
  if (!trimmed) throw new Error("Texto vazio para embedding.");

  const res = await fetch(OPENAI_EMBED_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: EMBED_MODEL,
      input: trimmed,
      dimensions: EMBED_DIMENSIONS,
    }),
    signal: AbortSignal.timeout(30_000),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`OpenAI embeddings ${res.status}: ${err.slice(0, 200)}`);
  }

  const json = (await res.json()) as EmbeddingResponse;
  const vec = json.data?.[0]?.embedding;
  if (!Array.isArray(vec) || vec.length !== EMBED_DIMENSIONS) {
    throw new Error(`Resposta inesperada da OpenAI: ${vec?.length ?? "null"} dimensões.`);
  }
  return vec;
}

/** Gera embeddings para múltiplos textos em batch. Retorna array paralelo ao input. */
export async function embedTexts(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];

  const apiKey = getApiKey();
  const cleaned = texts.map((t) => t.trim().slice(0, 8000)).filter((t) => t.length > 0);
  if (cleaned.length === 0) return [];

  // Batches de no máximo BATCH_LIMIT
  const results: number[][] = [];
  for (let i = 0; i < cleaned.length; i += BATCH_LIMIT) {
    const batch = cleaned.slice(i, i + BATCH_LIMIT);
    const res = await fetch(OPENAI_EMBED_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: EMBED_MODEL,
        input: batch,
        dimensions: EMBED_DIMENSIONS,
      }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`OpenAI embeddings ${res.status}: ${err.slice(0, 200)}`);
    }
    const json = (await res.json()) as EmbeddingResponse;
    // A resposta vem com .index — ordenar para garantir paralelismo
    const sorted = [...(json.data ?? [])].sort((a, b) => a.index - b.index);
    for (const item of sorted) {
      if (!Array.isArray(item.embedding) || item.embedding.length !== EMBED_DIMENSIONS) {
        throw new Error("Embedding com dimensões inválidas.");
      }
      results.push(item.embedding);
    }
  }

  return results;
}

/** Formata array de floats como literal pgvector ('[0.1,0.2,...]'). */
export function vectorLiteral(vec: number[]): string {
  return "[" + vec.map((v) => v.toFixed(6)).join(",") + "]";
}
