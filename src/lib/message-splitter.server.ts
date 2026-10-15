// Decide em quantos balões uma resposta vai para o WhatsApp.
//
// Política (15/10/2026): a Meta cobra POR BALÃO, então a resposta vai em UM
// balão sempre que couber. Só passa de um quando fica muito grande — e aí vai
// em exatamente DOIS, cortados no melhor ponto (parágrafo > linha > frase),
// nunca dentro de um bloco protegido. NUNCA mais que dois.
//
// Antes disso a divisão era por "unidades de sentido" (saudação / contexto /
// pergunta, até 5–8 partes, com um LLM de apoio): média de 2,4 balões por
// resposta, 90% das respostas com 2 ou mais. O splitter por LLM saiu junto —
// com no máximo dois balões, um corte determinístico resolve, sem custo nem
// latência extra.

/** Acima disto a resposta vai em 2 balões; até aqui, sempre 1. */
export const SINGLE_BUBBLE_MAX_CHARS = 700;
/** Teto absoluto de balões por resposta. */
export const MAX_BUBBLES = 2;
/** Cada balão precisa ter pelo menos isto; senão, não vale cortar. */
const MIN_PART_CHARS = 20;
/**
 * Fração mínima do texto que o balão menor precisa ter para o corte ser
 * considerado "equilibrado" num nível (parágrafo/linha/frase). Um corte logo
 * depois de "Oi, Paulo!" deixaria um balão de 10 chars e outro com tudo —
 * nesse caso tentamos o próximo nível antes de aceitar o desequilíbrio.
 */
const BALANCED_MIN_RATIO = 0.25;
/** Pausa mínima entre balões no WhatsApp (Helena/WhatsApp podem fundir envios muito rápidos). */
export const MIN_INTER_PART_DELAY_MS = 1200;

const ABBREV_BEFORE_DOT = /\b(?:Dra|Dr|Sr|Sra|Prof|Eng|etc|vs|ex)\.$/i;

// ── Blocos protegidos ([[NOSPLIT]]...[[/NOSPLIT]]) ──────────────────────────
// O agente envolve trechos que devem ir inteiros num balão (ex.: tabela de
// preços, lista de serviços inclusos). O corte em dois nunca cai dentro de um
// bloco; os marcadores são removidos antes do envio.
const PROTECTED_BLOCK_RE = /\[\[\s*NOSPLIT\s*\]\]([\s\S]*?)\[\[\s*\/\s*NOSPLIT\s*\]\]/gi;
const PROTECTED_ANY_MARKER_RE = /\[\[\s*\/?\s*NOSPLIT\s*\]\]/gi;

/** Remove os marcadores [[NOSPLIT]] / [[/NOSPLIT]] (inclusive soltos). */
export function stripProtectedMarkers(text: string): string {
  return text
    .replace(PROTECTED_ANY_MARKER_RE, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Intervalos [início, fim) dos blocos protegidos no texto ORIGINAL (com marcadores). */
function protectedRanges(text: string): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  const re = new RegExp(PROTECTED_BLOCK_RE);
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) out.push([m.index, m.index + m[0].length]);
  return out;
}

function insideProtected(ranges: Array<[number, number]>, idx: number): boolean {
  return ranges.some(([a, b]) => idx > a && idx < b);
}

function isAbbreviationPeriod(text: string, dotIndex: number): boolean {
  const window = text.slice(Math.max(0, dotIndex - 8), dotIndex + 1);
  return ABBREV_BEFORE_DOT.test(window);
}

/** Um ponto de corte candidato: o balão 1 é text[0, cutAt) e o 2 é text[resumeAt, fim). */
interface Cut {
  cutAt: number;
  resumeAt: number;
}

/** Quebras de parágrafo (linha em branco). */
function paragraphCuts(text: string): Cut[] {
  const out: Cut[] = [];
  const re = /\n[ \t]*\n+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) out.push({ cutAt: m.index, resumeAt: m.index + m[0].length });
  return out;
}

/** Quebras de linha simples (listas, itens). */
function lineCuts(text: string): Cut[] {
  const out: Cut[] = [];
  const re = /\n/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) out.push({ cutAt: m.index, resumeAt: m.index + 1 });
  return out;
}

/** Fim de frase (. ! ?) seguido de espaço — ignorando abreviações (Dra., Dr., etc.). */
function sentenceCuts(text: string): Cut[] {
  const out: Cut[] = [];
  for (let i = 0; i < text.length - 1; i++) {
    const ch = text[i];
    if (ch !== "." && ch !== "!" && ch !== "?") continue;
    if (!/\s/.test(text[i + 1]!)) continue;
    if (ch === "." && isAbbreviationPeriod(text, i)) continue;
    let resume = i + 1;
    while (resume < text.length && /\s/.test(text[resume]!)) resume++;
    out.push({ cutAt: i + 1, resumeAt: resume });
  }
  return out;
}

/**
 * Escolhe o corte mais perto do meio dentre os candidatos de um nível, fora de
 * blocos protegidos e com os dois lados grandes o bastante. `balanced` exige
 * ainda que o lado menor tenha pelo menos BALANCED_MIN_RATIO do total.
 */
function bestCut(
  text: string,
  cuts: Cut[],
  ranges: Array<[number, number]>,
  balanced: boolean,
): [string, string] | null {
  const total = text.length;
  const middle = total / 2;
  let best: { parts: [string, string]; dist: number } | null = null;
  for (const c of cuts) {
    if (insideProtected(ranges, c.cutAt) || insideProtected(ranges, c.resumeAt)) continue;
    const a = stripProtectedMarkers(text.slice(0, c.cutAt));
    const b = stripProtectedMarkers(text.slice(c.resumeAt));
    if (a.length < MIN_PART_CHARS || b.length < MIN_PART_CHARS) continue;
    if (balanced && Math.min(a.length, b.length) < total * BALANCED_MIN_RATIO) continue;
    const dist = Math.abs(c.cutAt - middle);
    if (!best || dist < best.dist) best = { parts: [a, b], dist };
  }
  return best?.parts ?? null;
}

/** Corta o texto em exatamente dois balões no melhor ponto; null se não houver onde cortar. */
function splitInTwo(text: string): [string, string] | null {
  const ranges = protectedRanges(text);
  const levels = [paragraphCuts(text), lineCuts(text), sentenceCuts(text)];
  // 1ª passada: corte equilibrado no nível mais "natural" possível.
  for (const cuts of levels) {
    const r = bestCut(text, cuts, ranges, true);
    if (r) return r;
  }
  // 2ª passada: qualquer corte válido, o mais perto do meio.
  return bestCut(text, levels.flat(), ranges, false);
}

/** Custo/tokens de uma chamada LLM, para telemetria. Mantido na assinatura
 *  por compatibilidade: o splitter não chama mais LLM nenhum. */
export interface SplitCost {
  costUsd: number;
  tokensIn: number;
  tokensOut: number;
}

/**
 * Balões de uma resposta: 1 (regra) ou 2 (só quando passa de
 * SINGLE_BUBBLE_MAX_CHARS). Nunca mais que MAX_BUBBLES. Determinístico, sem
 * DB nem LLM — `accountId`/`onCost` ficam pela compatibilidade dos chamadores.
 */
export async function splitMessage(
  text: string,
  _accountId?: string,
  _onCost?: (c: SplitCost) => void,
): Promise<string[]> {
  const trimmed = text.trim();
  if (!trimmed) return [];

  const clean = stripProtectedMarkers(trimmed);
  if (!clean) return [];
  if (clean.length <= SINGLE_BUBBLE_MAX_CHARS) return [clean];

  const two = splitInTwo(trimmed);
  if (!two) return [clean];
  console.log(`[split] ${clean.length} chars → 2 balões (${two[0].length}+${two[1].length})`);
  return two.slice(0, MAX_BUBBLES);
}

export function typingDelayMs(text: string, partIndex = 0): number {
  if (partIndex <= 0) return 0;
  const words = text.trim().split(/\s+/).length;
  const wpmDelay = Math.round((words / 230) * 60 * 1000);
  return Math.min(Math.max(Math.max(wpmDelay, MIN_INTER_PART_DELAY_MS), 500), 2500);
}
