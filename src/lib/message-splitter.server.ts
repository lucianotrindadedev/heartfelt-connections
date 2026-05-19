// Quebra uma resposta longa em múltiplas mensagens via LLM.
// Replica o comportamento do N8N workflow 02.
import { getSelfhost } from "@/integrations/selfhost/client.server";
import { decryptValue } from "@/lib/crypto.server";

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const DEFAULT_SPLITTER_MODEL = "x-ai/grok-3-fast";

const SPLIT_PROMPT = `Você é um especialista em comunicação via WhatsApp.
Sua tarefa é dividir a mensagem abaixo em partes menores para envio sequencial.

Regras OBRIGATÓRIAS:
1. Máximo 5 partes.
2. Não quebre listas (bullet points, numeração) no meio — a lista completa vai numa parte.
3. Não quebre templates ou blocos de código no meio.
4. Cada parte deve ser uma unidade de sentido completa.
5. Preserve TODA a formatação original (negrito, itálico, emojis, etc).
6. Se a mensagem for curta o suficiente para uma parte, retorne apenas uma.
7. Retorne SOMENTE um JSON válido no formato: {"partes": ["parte1", "parte2", ...]}
8. Nenhum texto fora do JSON.`;

export async function splitMessage(
  text: string,
  accountId: string,
): Promise<string[]> {
  if (text.length < 300) return [text];

  const sb = getSelfhost();
  const [llmRow, secretsRow] = await Promise.all([
    sb.from("account_llm_config").select("splitter_model").eq("account_id", accountId).single(),
    sb.from("account_secrets").select("openrouter_api_key_enc").eq("account_id", accountId).single(),
  ]);

  if (!secretsRow.data?.openrouter_api_key_enc) return [text];
  const orKey = await decryptValue(secretsRow.data.openrouter_api_key_enc as unknown as string);
  if (!orKey) return [text];

  const model =
    (llmRow.data as Record<string, unknown> | null)?.splitter_model as string | undefined ||
    DEFAULT_SPLITTER_MODEL;

  try {
    const res = await fetch(OPENROUTER_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${orKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: SPLIT_PROMPT },
          { role: "user", content: text },
        ],
        max_tokens: 2048,
        temperature: 0.1,
        response_format: { type: "json_object" },
      }),
    });

    if (!res.ok) return [text];

    const json = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const raw = json.choices?.[0]?.message?.content ?? "";
    const parsed = JSON.parse(raw) as { partes?: unknown };
    if (Array.isArray(parsed.partes) && parsed.partes.length > 0) {
      return (parsed.partes as string[]).filter((p) => p?.trim());
    }
  } catch {
    // fallback: retorna mensagem inteira
  }

  return [text];
}

// Delay de digitação baseado em 230 WPM (palavras por minuto)
export function typingDelayMs(text: string): number {
  const words = text.trim().split(/\s+/).length;
  const seconds = (words / 230) * 60;
  return Math.min(Math.max(seconds * 1000, 800), 4000);
}
