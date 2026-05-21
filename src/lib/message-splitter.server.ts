// Quebra uma resposta longa em múltiplas mensagens para envio via WhatsApp.
//
// Estratégia:
//  1. Splitter baseado em regras (sempre roda, zero dependência de LLM).
//  2. Se houver chave OpenRouter configurada, usa LLM para refinar a divisão
//     em textos > 500 chars onde o splitter de regras produz partes > 600 chars.
//
// O splitter de regras é o fallback confiável: separa nos paragráfos duplos
// (\n\n), nunca quebra listas nem código, mantém cada parte ≤ MAX_CHARS.

import { getSelfhost } from "@/integrations/selfhost/client.server";
import { decryptValue } from "@/lib/crypto.server";

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const DEFAULT_SPLITTER_MODEL = "openai/gpt-4.1-mini";

// Tamanho máximo de cada parte (caracteres)
const MAX_CHARS = 600;

// ── Splitter baseado em regras ──────────────────────────────────────────────
//
// Regra principal: cada parágrafo duplo (\n\n) = mensagem separada, SEMPRE.
// Isso garante que "Olá!\n\nSou a Mariana..." vira 2 mensagens independente
// do tamanho total. Só não divide quando não há \n\n no texto.

function ruleBasedSplit(text: string): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];

  // 1. Divide em blocos por parágrafos duplos
  const blocks = trimmed.split(/\n{2,}/);
  const nonEmpty = blocks.map((b) => b.trim()).filter((b) => b.length > 0);

  if (nonEmpty.length === 0) return [];

  // 2. Cada bloco = mensagem separada.
  //    Se algum bloco ainda for muito longo (sem \n\n interno),
  //    divide por linha simples (\n).
  const finalParts: string[] = [];

  for (const block of nonEmpty) {
    if (block.length <= MAX_CHARS) {
      finalParts.push(block);
      continue;
    }

    // Bloco longo: divide por linha simples
    const lines = block.split("\n");
    let cur = "";
    for (const line of lines) {
      const joined = cur ? cur + "\n" + line : line;
      if (joined.length <= MAX_CHARS) {
        cur = joined;
      } else {
        if (cur) finalParts.push(cur);
        cur = line;
      }
    }
    if (cur) finalParts.push(cur);
  }

  return finalParts.filter((p) => p.trim().length > 0).slice(0, 8);
}

// ── Splitter LLM (refinamento opcional) ────────────────────────────────────

const SPLIT_PROMPT = `Você é especialista em WhatsApp. Divida a mensagem abaixo em partes para envio sequencial.

Regras:
1. Máximo 5 partes.
2. Não quebre listas (bullets, numeração) no meio.
3. Não quebre código ou templates no meio.
4. Cada parte = unidade de sentido completa.
5. Preserve toda formatação (negrito, itálico, emojis).
6. Se for curta, retorne numa só parte.
7. Responda SOMENTE com JSON: {"partes":["parte1","parte2",...]}`;

async function llmSplit(text: string, orKey: string, model: string): Promise<string[] | null> {
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
        // Sem response_format — muitos modelos não suportam json_object
      }),
    });

    if (!res.ok) return null;

    const json = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const raw = (json.choices?.[0]?.message?.content ?? "").trim();

    // Extrai o JSON mesmo que o modelo adicione texto em volta
    const match = raw.match(/\{[\s\S]*"partes"[\s\S]*\}/);
    if (!match) return null;

    const parsed = JSON.parse(match[0]) as { partes?: unknown };
    if (Array.isArray(parsed.partes) && parsed.partes.length > 0) {
      const parts = (parsed.partes as string[]).filter((p) => p?.trim());
      return parts.length > 0 ? parts : null;
    }
  } catch {
    // ignora erros — usa fallback de regras
  }
  return null;
}

// ── Função principal ────────────────────────────────────────────────────────

export async function splitMessage(
  text: string,
  accountId: string,
): Promise<string[]> {
  const trimmed = text.trim();
  if (!trimmed) return [];

  // Divide por regras (cada \n\n = mensagem separada)
  const ruleResult = ruleBasedSplit(trimmed);

  // Se gerou múltiplas partes ou uma única parte curta, não precisa do LLM
  const needsLlm = ruleResult.length === 1 && ruleResult[0].length > MAX_CHARS;
  if (!needsLlm) return ruleResult;

  // Tenta refinamento via LLM (opcional — não bloqueia se falhar)
  try {
    const sb = getSelfhost();
    const [llmRow, secretsRow] = await Promise.all([
      sb.from("account_llm_config").select("splitter_model").eq("account_id", accountId).single(),
      sb.from("account_secrets").select("openrouter_api_key_enc").eq("account_id", accountId).single(),
    ]);

    if (secretsRow.data?.openrouter_api_key_enc) {
      const orKey = await decryptValue(secretsRow.data.openrouter_api_key_enc as unknown as string);
      if (orKey) {
        const model =
          (llmRow.data as Record<string, unknown> | null)?.splitter_model as string | undefined
          || DEFAULT_SPLITTER_MODEL;
        const llmResult = await llmSplit(text, orKey, model);
        if (llmResult) return llmResult;
      }
    }
  } catch {
    // ignora — usa resultado das regras
  }

  return ruleResult;
}

// Delay de digitação simulando 230 WPM (entre 800 ms e 4 s)
export function typingDelayMs(text: string): number {
  const words = text.trim().split(/\s+/).length;
  const seconds = (words / 230) * 60;
  return Math.min(Math.max(seconds * 1000, 800), 4000);
}
