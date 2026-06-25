// Descrição de imagens via OpenAI Vision (GPT-4o-mini).
//
// Chave global do servidor (process.env.OPENAI_API_KEY) — mesma usada pelos
// embeddings da base de conhecimento. Custo central da plataforma, atende
// todas as contas. Sem chave por conta.
//
// Filosofia: a IA recebe a IMAGEM "traduzida em texto" via system message,
// e responde naturalmente ao lead. O lead nunca vê a descrição — ela só
// orienta o LLM principal sobre o que foi enviado.

const OPENAI_CHAT_URL = "https://api.openai.com/v1/chat/completions";

// Modelo barato com visão. gpt-4o-mini ≈ $0.15/1M input tokens; uma imagem
// pequena gasta ~200-1000 tokens — fração de centavo por descrição.
const VISION_MODEL = "gpt-4o-mini";

export interface DescribeImageResult {
  ok: boolean;
  /** Descrição em PT-BR para o LLM principal usar como contexto. */
  text: string;
  error?: string;
}

export function getOpenAiKey(): string | null {
  const k = process.env.OPENAI_API_KEY?.trim();
  return k && k.length > 10 ? k : null;
}

/**
 * Pede ao gpt-4o-mini que descreva uma imagem para o agente de atendimento.
 * O prompt orienta o modelo a focar no que o lead provavelmente quer comunicar
 * (sintoma odontológico, destino de viagem, foto de documento, captura de
 * tela), em PT-BR e em 1-3 frases.
 *
 * Best-effort: retorna { ok: false } em qualquer erro — o caller cai no
 * placeholder genérico.
 */
export async function describeImageFromUrl(
  imageUrl: string,
  opts?: { context?: string },
): Promise<DescribeImageResult> {
  const apiKey = getOpenAiKey();
  if (!apiKey) {
    return { ok: false, text: "", error: "OPENAI_API_KEY não configurada" };
  }
  if (!imageUrl) {
    return { ok: false, text: "", error: "imageUrl vazio" };
  }

  const system =
    "Você descreve imagens que leads enviam por WhatsApp para um agente de " +
    "atendimento. O agente NÃO vê a imagem — sua descrição é o único contexto " +
    "dele. Escreva em português, 1-3 frases objetivas, focando no que o lead " +
    "provavelmente quer comunicar (ex.: sintoma, dúvida, documento, lugar). " +
    "Se houver texto legível na imagem, transcreva-o. Não invente nada. " +
    "Se a imagem for confusa, vazia ou apenas decorativa (logo, sticker, meme), " +
    "diga isso explicitamente.";

  const userContent: Array<Record<string, unknown>> = [
    {
      type: "text",
      text: opts?.context
        ? `Contexto do negócio (use para focar a descrição): ${opts.context}\n\nDescreva a imagem:`
        : "Descreva a imagem:",
    },
    { type: "image_url", image_url: { url: imageUrl, detail: "low" } },
  ];

  try {
    const res = await fetch(OPENAI_CHAT_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: VISION_MODEL,
        messages: [
          { role: "system", content: system },
          { role: "user", content: userContent },
        ],
        max_tokens: 220,
        temperature: 0.2,
      }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      const body = await res.text();
      return {
        ok: false,
        text: "",
        error: `OpenAI ${res.status}: ${body.slice(0, 200)}`,
      };
    }
    const json = (await res.json()) as {
      choices?: { message?: { content?: string | null } }[];
    };
    const text = (json.choices?.[0]?.message?.content ?? "").trim();
    if (!text) return { ok: false, text: "", error: "resposta vazia" };
    return { ok: true, text };
  } catch (e) {
    return {
      ok: false,
      text: "",
      error: e instanceof Error ? e.message : String(e),
    };
  }
}
