// Quebra uma resposta longa em múltiplas mensagens para envio via WhatsApp.
//
// Estratégia (igual espírito do n8n):
//  1. Regras: \n\n, linhas simples, abertura+ corpo, primeira frase+resto
//  2. LLM splitter quando ainda ficou 1 bloco e texto >= MIN_LLM_SPLIT_CHARS

import { getSelfhost } from "@/integrations/selfhost/client.server";
import { decryptValue } from "@/lib/crypto.server";

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const DEFAULT_SPLITTER_MODEL = "openai/gpt-4.1-mini";

const MAX_CHARS = 600;
const MIN_LLM_SPLIT_CHARS = 120;
const MAX_PARTS = 8;

const SPLIT_PROMPT = `Você é especialista em WhatsApp. Divida a mensagem abaixo em partes para envio sequencial.

Regras:
1. Máximo 5 partes.
2. Não quebre listas (bullets, numeração) no meio.
3. Cada parte = unidade de sentido completa (saudação separada do corpo, pergunta separada do contexto).
4. Preserve formatação (negrito, emojis).
5. Se couber em uma bolha curta, retorne uma parte só.
6. Responda SOMENTE com JSON: {"partes":["parte1","parte2",...]}`;

function ruleBasedSplit(text: string): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];

  // 1. Parágrafos duplos (\n\n) — regra principal do template
  if (/\n{2,}/.test(trimmed)) {
    const blocks = trimmed.split(/\n{2,}/);
    const parts = blocks.map((b) => b.trim()).filter((b) => b.length > 0);
    if (parts.length > 1) return capParts(parts);
  }

  // 2. Linhas simples (\n) — comum em respostas do LLM sem \n\n
  const lines = trimmed.split(/\n/).map((l) => l.trim()).filter((l) => l.length > 0);
  if (lines.length >= 2 && lines.length <= 6 && lines.every((l) => l.length <= MAX_CHARS)) {
    return capParts(lines);
  }

  // 3. Abertura curta + corpo (ex.: "Perfeito, Luciano! Para eu te dar...")
  const opener = splitOpenerAndBody(trimmed);
  if (opener) return capParts(opener);

  // 4. Primeira frase + restante (textos longos em um parágrafo só)
  if (trimmed.length >= MIN_LLM_SPLIT_CHARS) {
    const sentences = splitFirstSentence(trimmed);
    if (sentences) return capParts(sentences);
  }

  return [trimmed];
}

function capParts(parts: string[]): string[] {
  return parts.filter((p) => p.trim().length > 0).slice(0, MAX_PARTS);
}

/** Saudação / reação curta separada do restante. */
function splitOpenerAndBody(text: string): string[] | null {
  const m = text.match(
    /^((?:Oi|Olá|Ola|Poxa|Perfeito|Entendo|Compreendo|Certo)[!.]?(?:\s+[^.!?\n]{0,40})?[!.]?)\s+([\s\S]{25,})$/i,
  );
  if (m) return [m[1].trim(), m[2].trim()];

  const named = text.match(/^([^!.?\n]{1,50}[!.?])\s+([\s\S]{40,})$/);
  if (named && named[1].length <= 80) return [named[1].trim(), named[2].trim()];

  return null;
}

/** Primeira frase (até . ! ?) + corpo. */
function splitFirstSentence(text: string): string[] | null {
  const m = text.match(/^(.{12,140}?[.!?])\s+(.{30,})$/s);
  if (!m) return null;
  if (m[1].length > 160) return null;
  return [m[1].trim(), m[2].trim()];
}

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
        max_tokens: 1024,
        temperature: 0.1,
        response_format: { type: "json_object" },
      }),
      signal: AbortSignal.timeout(25_000),
    });

    if (!res.ok) return null;

    const json = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const raw = (json.choices?.[0]?.message?.content ?? "").trim();
    if (!raw) return null;

    let parsed: { partes?: unknown };
    try {
      parsed = JSON.parse(raw) as { partes?: unknown };
    } catch {
      const match = raw.match(/\{[\s\S]*"partes"[\s\S]*\}/);
      if (!match) return null;
      parsed = JSON.parse(match[0]) as { partes?: unknown };
    }

    if (Array.isArray(parsed.partes) && parsed.partes.length > 0) {
      const parts = (parsed.partes as string[]).map((p) => String(p).trim()).filter(Boolean);
      return parts.length > 0 ? capParts(parts) : null;
    }
  } catch (e) {
    console.warn("[split] LLM splitter falhou:", e instanceof Error ? e.message : e);
  }
  return null;
}

export async function splitMessage(
  text: string,
  accountId: string,
): Promise<string[]> {
  const trimmed = text.trim();
  if (!trimmed) return [];

  const ruleResult = ruleBasedSplit(trimmed);
  if (ruleResult.length > 1) return ruleResult;

  const shouldTryLlm = trimmed.length >= MIN_LLM_SPLIT_CHARS;
  if (!shouldTryLlm) return ruleResult;

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
        const llmResult = await llmSplit(trimmed, orKey, model);
        if (llmResult && llmResult.length > 1) return llmResult;
      }
    }
  } catch {
    // usa regras
  }

  return ruleResult;
}

/** Delay entre bolhas (mais curto quando há várias partes). */
export function typingDelayMs(text: string, partIndex = 0): number {
  if (partIndex <= 0) return 0;
  const words = text.trim().split(/\s+/).length;
  const seconds = (words / 230) * 60;
  return Math.min(Math.max(Math.round(seconds * 1000), 500), 2200);
}
