// Quebra texto longo em chunks de ~500 tokens com overlap de ~100 tokens.
// Aproximação: 1 token ≈ 4 chars em PT-BR (próximo do real para texto narrativo).

const TARGET_CHARS_PER_CHUNK = 2000; // ~500 tokens
const OVERLAP_CHARS = 400; // ~100 tokens

export interface Chunk {
  text: string;
  ordem: number;
  estimatedTokens: number;
}

/** Estimativa simples — usar tokenizador real seria mais caro e não compensa. */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Quebra texto respeitando, na ordem de preferência:
 *   1. \n\n (parágrafos)
 *   2. \n (linhas)
 *   3. . ! ? (frases)
 *   4. corte hard no limite (último recurso)
 *
 * Cada chunk começa repetindo OVERLAP_CHARS do anterior para manter contexto
 * em fronteiras (importante para RAG: ajuda a recuperar passagens que ficaram
 * partidas no limite do chunk).
 */
export function chunkText(text: string): Chunk[] {
  const cleaned = text.replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  if (!cleaned) return [];

  const chunks: Chunk[] = [];
  let cursor = 0;
  let ordem = 0;

  while (cursor < cleaned.length) {
    const start = Math.max(0, cursor - (ordem === 0 ? 0 : OVERLAP_CHARS));
    const hardEnd = Math.min(cleaned.length, cursor + TARGET_CHARS_PER_CHUNK);

    // Tenta quebrar em fronteira natural perto do hardEnd
    let end = hardEnd;
    if (hardEnd < cleaned.length) {
      const window = cleaned.slice(cursor, hardEnd);
      // Procura último \n\n no último terço da janela
      const lastParagraph = window.lastIndexOf("\n\n", window.length);
      const lastLine = window.lastIndexOf("\n", window.length);
      const lastSentence = Math.max(
        window.lastIndexOf(". ", window.length),
        window.lastIndexOf("! ", window.length),
        window.lastIndexOf("? ", window.length),
      );

      // Considera fronteira "boa" se estiver no último terço do chunk
      const minBound = Math.floor(window.length * 0.5);
      if (lastParagraph >= minBound) end = cursor + lastParagraph + 2;
      else if (lastLine >= minBound) end = cursor + lastLine + 1;
      else if (lastSentence >= minBound) end = cursor + lastSentence + 2;
    }

    const chunkText = cleaned.slice(start, end).trim();
    if (chunkText.length >= 40) {
      // ignora chunks muito pequenos
      chunks.push({
        text: chunkText,
        ordem,
        estimatedTokens: estimateTokens(chunkText),
      });
      ordem++;
    }
    cursor = end;
  }

  return chunks;
}
