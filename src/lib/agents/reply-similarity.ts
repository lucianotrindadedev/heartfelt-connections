// Comparação "a IA está repetindo a última resposta?" usada pela trava
// anti-loop do orquestrador.

/** Normaliza texto para comparação (lowercase, sem pontuação/emoji/espaços extras). */
function normalizeForSimilarity(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Horários ("08:30", "9h", "9h30") e datas ("19/09") citados num texto, já
 * normalizados ("8:30", "19/9"). É o que diferencia uma oferta NOVA de uma
 * repetida — e a comparação por palavras nunca via: tokens com menos de 3
 * letras ("30", "09") eram descartados.
 */
export function scheduleTokens(text: string): Set<string> {
  const out = new Set<string>();
  const t = (text ?? "").toLowerCase();
  for (const m of t.matchAll(/\b(\d{1,2})\s*(?::|h)\s*(\d{2})?(?!\d)/g)) {
    const h = Number(m[1]);
    const min = Number(m[2] ?? "0");
    if (h <= 23 && min <= 59) out.add(`${h}:${String(min).padStart(2, "0")}`);
  }
  for (const m of t.matchAll(/\b(\d{1,2})\/(\d{1,2})\b/g)) {
    out.add(`${Number(m[1])}/${Number(m[2])}`);
  }
  return out;
}

/**
 * A resposta atual repete a anterior? Duplicado quando >=70% das palavras de
 * uma estão na outra (mesmo splitada em bolhas) — EXCETO se a atual traz
 * data/horário que a anterior não trazia: aí é oferta nova, não loop.
 *
 * Casos reais (Sorriso Saúde, set/2026) em que a trava apagou a oferta certa e
 * mandou "Me confirma só por favor: você quer seguir com o agendamento agora?":
 * o lead pediu sábado e a IA ofertou "sábado, 19/09 às 08:30 ou 09:00" depois
 * de "segunda-feira, 14/09 às 08:30 ou 09:00"; a lead recusou 08:30/09:00 e a
 * IA ofertou 09:30/10:00.
 */
export function isReplyTooSimilar(current: string, previous: string): boolean {
  const a = normalizeForSimilarity(current);
  const b = normalizeForSimilarity(previous);
  if (!a || !b) return false;
  if (a === b) return true;

  const tokensA = scheduleTokens(current);
  if (tokensA.size > 0) {
    const tokensB = scheduleTokens(previous);
    for (const tk of tokensA) if (!tokensB.has(tk)) return false;
  }

  const wordsA = new Set(a.split(" ").filter((w) => w.length >= 3));
  const wordsB = new Set(b.split(" ").filter((w) => w.length >= 3));
  if (wordsA.size < 4) return false; // muito curto pra avaliar

  let matches = 0;
  for (const w of wordsA) if (wordsB.has(w)) matches++;
  const overlap = matches / wordsA.size;
  return overlap >= 0.7;
}
