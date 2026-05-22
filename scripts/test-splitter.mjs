// Teste das regras de quebra de mensagens — versão standalone das funções.
// Roda com: node scripts/test-splitter.mjs

const MAX_CHARS = 600;
const MIN_PART_CHARS = 8;
const MAX_PARTS = 5;
const NO_SPLIT_BELOW_CHARS = 220;

const ABBREV_BEFORE_DOT = /\b(?:Dra|Dr|Sr|Sra|Prof|Eng|etc|vs|ex)\.$/i;

function capParts(parts) {
  return parts.filter((p) => p.trim().length >= MIN_PART_CHARS).slice(0, MAX_PARTS);
}

function isAbbreviationPeriod(text, dotIndex) {
  const window = text.slice(Math.max(0, dotIndex - 8), dotIndex + 1);
  return ABBREV_BEFORE_DOT.test(window);
}

function splitAllSentences(text) {
  const trimmed = text.trim();
  const parts = [];
  let start = 0;
  for (let i = 0; i < trimmed.length && parts.length < MAX_PARTS; i++) {
    const ch = trimmed[i];
    if (ch !== "." && ch !== "!" && ch !== "?") continue;
    if (isAbbreviationPeriod(trimmed, i)) continue;
    const after = trimmed.slice(i + 1);
    const atEnd = after.trim().length === 0;
    const newSentence = /^\s+[A-ZÁÀÂÃÉÊÍÓÔÚÇÀ-ɏ"']/.test(after);
    if (!atEnd && !newSentence) continue;
    const chunk = trimmed.slice(start, i + 1).trim();
    if (chunk.length >= MIN_PART_CHARS) parts.push(chunk);
    start = i + 1;
    while (start < trimmed.length && /\s/.test(trimmed[start])) start++;
    i = start - 1;
  }
  const tail = trimmed.slice(start).trim();
  if (tail.length >= MIN_PART_CHARS && parts.length < MAX_PARTS) parts.push(tail);
  if (parts.length >= 2) return capParts(parts);
  return null;
}

function ruleBasedSplit(text) {
  const trimmed = text.trim();
  if (!trimmed) return [];
  if (/\n{2,}/.test(trimmed)) {
    const blocks = trimmed.split(/\n{2,}/).map((b) => b.trim()).filter(Boolean);
    if (blocks.length > 1) return capParts(blocks);
  }
  if (trimmed.length <= NO_SPLIT_BELOW_CHARS) return [trimmed];
  const lines = trimmed.split(/\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length >= 2 && lines.length <= MAX_PARTS && lines.every((l) => l.length <= MAX_CHARS)) {
    return capParts(lines);
  }
  const sentences = splitAllSentences(trimmed);
  if (sentences) return sentences;
  return [trimmed];
}

const cases = [
  {
    name: "Curta com pergunta no fim — UMA bolha",
    input: "Poxa, eu entendo. Como posso te ajudar?",
    expected: 1,
  },
  {
    name: "Curta sem pergunta — UMA bolha",
    input: "Pelo que você me contou, faz muito sentido passar pela Consulta.",
    expected: 1,
  },
  {
    name: "\\n\\n explícito — duas bolhas",
    input: "Oi, Luciano!\n\nComo posso te ajudar hoje?",
    expected: 2,
  },
  {
    name: "Longa (>220 chars) — múltiplas frases",
    input: "Poxa, Neymar, eu entendo como isso deve ser difícil. Muitos pacientes chegam aqui com esse mesmo receio. Aqui o atendimento é bem acolhedor. Posso te oferecer um horário ainda essa semana para sua Consulta de Diagnóstico?",
    expected: 4, // Acima de 220 chars → quebra em frases
  },
  {
    name: "Lista curta — fica em uma bolha (abaixo de 220 chars)",
    input: "Seguem os documentos:\n1. Contrato\n2. RG\n3. Comprovante\nMe avisa quando receber!",
    expected: 1,
  },
  {
    name: "Lista longa — preserva linhas (acima de 220 chars)",
    input: "Documentos necessários para sua primeira consulta odontológica completa na clínica:\n1. RG e CPF originais\n2. Comprovante de residência atualizado dos últimos 3 meses\n3. Carteira do convênio se houver\n4. Exames antigos relevantes\nMe avisa quando tiver tudo separadinho!",
    expected: 5,
  },
];

let pass = 0;
for (const c of cases) {
  const result = ruleBasedSplit(c.input);
  const ok = result.length === c.expected;
  console.log(`${ok ? "✅" : "❌"} ${c.name}`);
  console.log(`   esperado=${c.expected}, recebido=${result.length}`);
  result.forEach((p, i) => console.log(`     [${i + 1}] (${p.length}) "${p.slice(0, 80)}${p.length > 80 ? "…" : ""}"`));
  if (ok) pass++;
}
console.log(`\n${pass}/${cases.length} casos OK`);
