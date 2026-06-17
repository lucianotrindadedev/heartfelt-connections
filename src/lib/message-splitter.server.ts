// Quebra uma resposta longa em múltiplas mensagens para envio via WhatsApp.
//
// Prioridade: regras determinísticas (frases, cláusulas, \n\n) e depois LLM.

import { getSelfhost } from "@/integrations/selfhost/client.server";
import { decryptValue } from "@/lib/crypto.server";
import { DEFAULT_AUX_FALLBACK_MODEL, DEFAULT_SPLITTER_MODEL } from "@/lib/llm-defaults";

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

const MAX_CHARS = 600;
const MIN_LLM_SPLIT_CHARS = 80;
const MIN_PART_CHARS = 8;
const MAX_PARTS = 5;
/** Limite mais alto quando há blocos protegidos (preço, lista de serviços etc.)
 *  — evita descartar conteúdo que o agente marcou para enviar inteiro. */
const MAX_PARTS_PROTECTED = 8;
/** Não quebrar mensagens menores que isto — costumam ser 1 bolha só. */
const NO_SPLIT_BELOW_CHARS = 220;
/** Pausa mínima entre bolhas no WhatsApp (Helena/WhatsApp podem fundir envios muito rápidos). */
export const MIN_INTER_PART_DELAY_MS = 1200;

const SPLIT_PROMPT = `Você é especialista em WhatsApp. Divida a mensagem abaixo em partes para envio sequencial.

Regras:
1. Máximo 8 partes — inclua TODO o texto, sem omitir frases.
2. Não quebre listas (bullets, numeração) no meio.
3. Não separe títulos abreviados do nome (ex.: mantenha "Dra. Michelle" na mesma parte).
4. Cada parte = unidade de sentido completa.
5. Preserve formatação.
6. Responda SOMENTE com JSON: {"partes":["parte1","parte2",...]}`;

const ABBREV_BEFORE_DOT = /\b(?:Dra|Dr|Sr|Sra|Prof|Eng|etc|vs|ex)\.$/i;

// ── Blocos protegidos ([[NOSPLIT]]...[[/NOSPLIT]]) ──────────────────────────
// O agente envolve trechos que devem ir em UMA bolha só (ex.: tabela de preços,
// lista de serviços inclusos), mesmo contendo linhas em branco. O splitter
// mantém o bloco inteiro e remove os marcadores antes do envio.
const PROTECTED_OPEN_RE = /\[\[\s*NOSPLIT\s*\]\]/i;
const PROTECTED_BLOCK_RE = /\[\[\s*NOSPLIT\s*\]\]([\s\S]*?)\[\[\s*\/\s*NOSPLIT\s*\]\]/gi;
const PROTECTED_ANY_MARKER_RE = /\[\[\s*\/?\s*NOSPLIT\s*\]\]/gi;

/** Remove os marcadores [[NOSPLIT]] / [[/NOSPLIT]] (inclusive soltos). */
export function stripProtectedMarkers(text: string): string {
  return text
    .replace(PROTECTED_ANY_MARKER_RE, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function hasProtectedBlock(text: string): boolean {
  return PROTECTED_OPEN_RE.test(text);
}

/**
 * Divide respeitando blocos protegidos: cada [[NOSPLIT]]...[[/NOSPLIT]] vira UMA
 * parte atômica; o texto fora dos blocos é dividido pelas regras normais.
 */
function splitWithProtectedBlocks(text: string): string[] {
  const parts: string[] = [];
  const re = new RegExp(PROTECTED_BLOCK_RE);
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const before = text.slice(last, m.index).trim();
    if (before) parts.push(...ruleBasedSplit(before));
    const block = stripProtectedMarkers(m[1] ?? "");
    if (block) parts.push(block);
    last = m.index + m[0].length;
  }
  const after = text.slice(last).trim();
  if (after) parts.push(...ruleBasedSplit(after));

  return parts
    .map(stripProtectedMarkers)
    .filter((p) => p.length > 0)
    .slice(0, MAX_PARTS_PROTECTED);
}

function capParts(parts: string[]): string[] {
  return parts.filter((p) => p.trim().length >= MIN_PART_CHARS).slice(0, MAX_PARTS);
}

function isAbbreviationPeriod(text: string, dotIndex: number): boolean {
  const window = text.slice(Math.max(0, dotIndex - 8), dotIndex + 1);
  return ABBREV_BEFORE_DOT.test(window);
}

/** Divide em frases (. ! ?), ignorando abreviações (Dra., Dr., etc.). */
function splitAllSentences(text: string): string[] | null {
  const trimmed = text.trim();
  const parts: string[] = [];
  let start = 0;

  for (let i = 0; i < trimmed.length && parts.length < MAX_PARTS; i++) {
    const ch = trimmed[i];
    if (ch !== "." && ch !== "!" && ch !== "?") continue;
    if (isAbbreviationPeriod(trimmed, i)) continue;

    const after = trimmed.slice(i + 1);
    const atEnd = after.trim().length === 0;
    const newSentence = /^\s+[A-ZÁÀÂÃÉÊÍÓÔÚÇ\u00C0-\u024F"']/.test(after);

    if (!atEnd && !newSentence) continue;

    const chunk = trimmed.slice(start, i + 1).trim();
    if (chunk.length >= MIN_PART_CHARS) {
      parts.push(chunk);
    }
    start = i + 1;
    while (start < trimmed.length && /\s/.test(trimmed[start]!)) start++;
    i = start - 1;
  }

  const tail = trimmed.slice(start).trim();
  if (tail.length >= MIN_PART_CHARS && parts.length < MAX_PARTS) {
    parts.push(tail);
  }

  if (parts.length >= 2) return capParts(parts);
  return null;
}

/** Frase única longa: quebra em vírgula antes de cláusula nova (marketing). */
function splitLongClause(text: string): string[] | null {
  if (text.length < 140) return null;

  const patterns = [
    /,\s+(?=essa\s+)/i,
    /,\s+(?=para\s+te\s+)/i,
    /,\s+(?=priorizar\s+)/i,
    /,\s+(?=temos\s+)/i,
    /,\s+(?=na\s+Costa\s+)/i,
    /,\s+(?=nossa\s+)/i,
    /,\s+(?=como\s+um\s+)/i,
    /,\s+(?=a\s+Dra\.?\s+)/i,
    /,\s+(?=michelle\s+)/i,
  ];

  for (const re of patterns) {
    const idx = text.search(re);
    if (idx >= 50 && idx < text.length - 50) {
      const a = text.slice(0, idx + 1).trim();
      const b = text.slice(idx + 1).trim();
      if (a.length >= MIN_PART_CHARS && b.length >= MIN_PART_CHARS) {
        const bParts = splitAllSentences(b) ?? [b];
        return capParts([a, ...bParts]);
      }
    }
  }

  return null;
}

function expandOpenerWithBody(opener: string, body: string): string[] {
  const bodyParts = splitAllSentences(body) ?? (splitLongClause(body) ?? [body]);
  return capParts([opener, ...bodyParts]);
}

/** Saudação curta + corpo (só padrões explícitos — evita cortar em 2 bolhas). */
function splitOpenerAndBody(text: string): string[] | null {
  const m = text.match(
    /^((?:Oi|Olá|Ola|Poxa|Perfeito|Entendo|Compreendo|Certo|Pelo\s+que)[!.]?(?:\s+[^.!?\n]{0,50})?[!.]?)\s+([\s\S]{20,})$/i,
  );
  if (m) return expandOpenerWithBody(m[1].trim(), m[2].trim());
  return null;
}

function ruleBasedSplit(text: string): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];

  // 1. Quebra EXPLÍCITA do agente com \n\n entre blocos — respeita sempre.
  if (/\n{2,}/.test(trimmed)) {
    const blocks = trimmed.split(/\n{2,}/).map((b) => b.trim()).filter(Boolean);
    if (blocks.length > 1) return capParts(blocks);
  }

  // 2. Mensagens curtas (até 220 chars) ficam em UMA bolha só.
  // Evita fragmentar frases naturais como "Tudo bem! Como posso ajudar?"
  // em duas bolhas (que destrói o flow + esconde a pergunta final).
  if (trimmed.length <= NO_SPLIT_BELOW_CHARS) {
    return [trimmed];
  }

  // 3. Múltiplas linhas curtas (lista / itens) — preserva.
  const lines = trimmed.split(/\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length >= 2 && lines.length <= MAX_PARTS && lines.every((l) => l.length <= MAX_CHARS)) {
    return capParts(lines);
  }

  // 4. Texto longo (>220 chars) sem quebras explícitas:
  //    a) Tenta separar saudação + corpo + pergunta
  //    b) Senão, quebra em frases
  const opener = splitOpenerAndBody(trimmed);
  if (opener && opener.length > 1) return opener;

  const sentences = splitAllSentences(trimmed);
  if (sentences) return sentences;

  const clause = splitLongClause(trimmed);
  if (clause) return capParts(clause);

  return [trimmed];
}

async function llmSplitOne(
  text: string,
  orKey: string,
  model: string,
): Promise<string[] | null> {
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
    // Timeout curto: o split é best-effort. Se demorar, cai pra fallback/regras
    // em vez de segurar a resposta ao lead por 25s.
    signal: AbortSignal.timeout(12_000),
  });

  if (!res.ok) {
    console.warn(`[split] LLM HTTP ${res.status} (model=${model})`);
    return null;
  }

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
    return parts.length > 1 ? capParts(parts) : null;
  }
  return null;
}

/** Tenta o splitter em cada modelo da lista (primário + fallback) até um
 *  responder. Timeout/erro num modelo → tenta o próximo; se todos falharem,
 *  retorna null e o chamador usa a divisão por regras. */
async function llmSplit(text: string, orKey: string, models: string[]): Promise<string[] | null> {
  const chain = models.filter((m, i) => m && models.indexOf(m) === i);
  for (const model of chain) {
    try {
      const r = await llmSplitOne(text, orKey, model);
      if (r && r.length > 1) return r;
    } catch (e) {
      console.warn(
        `[split] LLM splitter falhou (model=${model}): ${e instanceof Error ? e.message : e} — tentando próximo/regras`,
      );
    }
  }
  return null;
}

export async function splitMessage(
  text: string,
  accountId: string,
): Promise<string[]> {
  const trimmed = text.trim();
  if (!trimmed) return [];

  // Blocos protegidos: o agente marcou trechos que devem ir em UMA bolha só.
  // Respeitamos e NÃO acionamos o splitter LLM (a divisão já é explícita).
  if (hasProtectedBlock(trimmed)) {
    const parts = splitWithProtectedBlocks(trimmed);
    if (parts.length > 0) {
      console.log(`[split] blocos protegidos → ${parts.length} parte(s)`);
      return parts;
    }
    return [stripProtectedMarkers(trimmed)];
  }

  const ruleResult = ruleBasedSplit(trimmed);
  if (ruleResult.length > 1) {
    console.log(`[split] regras → ${ruleResult.length} parte(s)`);
    return ruleResult;
  }

  if (trimmed.length >= MIN_LLM_SPLIT_CHARS) {
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
          const llmResult = await llmSplit(trimmed, orKey, [model, DEFAULT_AUX_FALLBACK_MODEL]);
          if (llmResult && llmResult.length > 1) {
            console.log(`[split] LLM → ${llmResult.length} parte(s)`);
            return llmResult;
          }
        }
      }
    } catch (e) {
      console.warn("[split] LLM indisponível:", e instanceof Error ? e.message : e);
    }
  }

  return ruleResult;
}

export function typingDelayMs(text: string, partIndex = 0): number {
  if (partIndex <= 0) return 0;
  const words = text.trim().split(/\s+/).length;
  const wpmDelay = Math.round((words / 230) * 60 * 1000);
  return Math.min(Math.max(Math.max(wpmDelay, MIN_INTER_PART_DELAY_MS), 500), 2500);
}
