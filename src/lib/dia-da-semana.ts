// Dia da semana x data nas mensagens da IA.
//
// O modelo calcula o dia da semana de cabeça e erra — mesmo com o prompt
// proibindo. Casos reais (23–25/11/2026):
// - Game Point, Pamela 21 98136-7419: "13 e 15 de dezembro (sexta e domingo)"
//   → 15/12 é TERÇA; o lead recebeu o preço de fim de semana (R$ 1.000).
// - Game Point, Fernanda 21 98876-3109: "Sábado, 06/12" (domingo),
//   "Segunda-feira, 08/12" (terça).
// - Sorriso Saúde: "segunda-feira, 01/12" (terça), "segunda-feira, 25/11"
//   (quarta), "quinta-feira, 27/11" (sexta).
// - Odonto Carioca, Sandra 21 98910-5982: "terça, 03/12" (quinta) — a
//   atendente tinha escrito "03/12 quinta".
//
// Duas defesas: o calendário dos próximos dias no contexto do modelo
// (calendarioProximosDias) e a correção determinística na saída
// (corrigirDiaDaSemana), que troca o nome do dia quando ele não bate com a data.
//
// PURO: sem I/O.

const NOMES = ["domingo", "segunda", "terça", "quarta", "quinta", "sexta", "sábado"] as const;
const ABREV = ["dom", "seg", "ter", "qua", "qui", "sex", "sáb"] as const;

const DIA_RE_SRC = String.raw`(segunda|ter[çc]a|quarta|quinta|sexta|s[áa]bado|domingo)(-feira)?`;

function indiceDoNome(nome: string): number {
  const n = nome.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
  return ["domingo", "segunda", "terca", "quarta", "quinta", "sexta", "sabado"].indexOf(n);
}

/** Dia da semana (0=domingo) de dd/mm[/aaaa]; sem ano, o ano que deixa a data
 *  mais perto de `agora` (até 60 dias para trás; antes disso, o ano seguinte). */
function diaDaSemanaDe(dd: number, mm: number, ano: number | null, agora: Date): number | null {
  if (!(mm >= 1 && mm <= 12 && dd >= 1 && dd <= 31)) return null;
  let a = ano;
  if (a == null) {
    a = agora.getUTCFullYear();
    if (Date.UTC(a, mm - 1, dd, 15) < agora.getTime() - 60 * 86400_000) a++;
  } else if (a < 100) a += 2000;
  const d = new Date(Date.UTC(a, mm - 1, dd, 15));
  if (d.getUTCMonth() !== mm - 1 || d.getUTCDate() !== dd) return null; // 31/02 etc.
  return d.getUTCDay();
}

/** Nome correto no mesmo "estilo" do original: maiúscula inicial, "-feira",
 *  e "terca"/"sabado" sem acento se o original vinha sem. */
function nomeNoEstilo(original: string, comFeira: boolean, certo: number): string {
  let nome: string = NOMES[certo]!;
  const semAcento = !/[çá]/i.test(original) && /terca|sabado/i.test(original);
  if (semAcento) nome = nome.normalize("NFD").replace(/[̀-ͯ]/g, "");
  const fimDeSemana = certo === 0 || certo === 6;
  if (comFeira && !fimDeSemana) nome += "-feira";
  if (
    original[0] &&
    original[0] === original[0].toUpperCase() &&
    original[0] !== original[0].toLowerCase()
  ) {
    nome = nome[0]!.toUpperCase() + nome.slice(1);
  }
  if (original === original.toUpperCase() && original.length > 1) nome = nome.toUpperCase();
  return nome;
}

export interface CorrecaoDiaDaSemana {
  texto: string;
  /** "segunda-feira, 01/12 → terça-feira" — para telemetria. */
  correcoes: string[];
}

/**
 * Corrige o nome do dia quando ele não bate com a data citada junto:
 * "segunda-feira, 01/12", "sábado 06/12", "terça, dia 03/12",
 * "06/12 (sábado)", "06/12 é sábado".
 */
export function corrigirDiaDaSemana(texto: string, agora: Date = new Date()): CorrecaoDiaDaSemana {
  const correcoes: string[] = [];
  if (!texto) return { texto, correcoes };

  const troca = (
    nomeOrig: string,
    feira: string | undefined,
    dd: string,
    mm: string,
    aaaa?: string,
  ): string | null => {
    const certo = diaDaSemanaDe(Number(dd), Number(mm), aaaa ? Number(aaaa) : null, agora);
    if (certo == null) return null;
    if (indiceDoNome(nomeOrig) === certo) return null;
    return nomeNoEstilo(nomeOrig, !!feira, certo);
  };

  // 1) "segunda-feira, 01/12" | "sábado 06/12" | "terça, dia 03/12"
  let out = texto.replace(
    new RegExp(
      String.raw`\b${DIA_RE_SRC}(,?\s*(?:dia\s+)?)(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b`,
      "gi",
    ),
    (
      m,
      nome: string,
      feira: string | undefined,
      meio: string,
      dd: string,
      mm: string,
      aaaa?: string,
    ) => {
      const novo = troca(nome, feira, dd, mm, aaaa);
      if (!novo) return m;
      correcoes.push(`${m} → ${novo}`);
      return `${novo}${meio}${dd}/${mm}${aaaa ? `/${aaaa}` : ""}`;
    },
  );

  // 2) "06/12 (sábado)" | "06/12 é sábado" | "06/12, que é sábado" | "06/12 cai num sábado"
  out = out.replace(
    new RegExp(
      String.raw`\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?(\s*\(\s*|\s*,?\s*(?:que\s+)?(?:é|cai(?:\s+n(?:uma?|o))?|ser[áa])\s+(?:uma?\s+|n(?:uma?|o)\s+)?)${DIA_RE_SRC}\b`,
      "gi",
    ),
    (
      m,
      dd: string,
      mm: string,
      aaaa: string | undefined,
      meio: string,
      nome: string,
      feira: string | undefined,
    ) => {
      const novo = troca(nome, feira, dd, mm, aaaa);
      if (!novo) return m;
      correcoes.push(`${m} → ${novo}`);
      return `${dd}/${mm}${aaaa ? `/${aaaa}` : ""}${meio}${novo}`;
    },
  );

  // Artigo que acompanhava o dia antigo ("na sexta" → "no domingo"): sábado e
  // domingo são masculinos, os outros femininos. Só quando houve correção.
  if (correcoes.length > 0) {
    out = out
      .replace(
        /\b(N|n)a(\s+)(domingo|s[áa]bado)\b/g,
        (_m, n: string, s: string, d: string) => `${n}o${s}${d}`,
      )
      .replace(
        /\b(N|n)uma(\s+)(domingo|s[áa]bado)\b/g,
        (_m, n: string, s: string, d: string) => `${n}um${s}${d}`,
      )
      .replace(
        /\b(N|n)o(\s+)(segunda|ter[çc]a|quarta|quinta|sexta)\b/g,
        (_m, n: string, s: string, d: string) => `${n}a${s}${d}`,
      )
      .replace(
        /\b(N|n)um(\s+)(segunda|ter[çc]a|quarta|quinta|sexta)\b/g,
        (_m, n: string, s: string, d: string) => `${n}uma${s}${d}`,
      );
  }

  return { texto: out, correcoes };
}

/**
 * Calendário dos próximos `dias` dias (fuso de São Paulo) para o contexto do
 * modelo: "qui 26/11 · sex 27/11 · sáb 28/11 …". Com ele o modelo copia o dia
 * da semana em vez de calcular.
 */
export function calendarioProximosDias(agora: Date = new Date(), dias = 45): string {
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" });
  const [y, m, d] = fmt.format(agora).split("-").map(Number) as [number, number, number];
  const partes: string[] = [];
  for (let i = 0; i < dias; i++) {
    const dt = new Date(Date.UTC(y, m - 1, d + i, 15));
    const dd = String(dt.getUTCDate()).padStart(2, "0");
    const mm = String(dt.getUTCMonth() + 1).padStart(2, "0");
    partes.push(`${ABREV[dt.getUTCDay()]} ${dd}/${mm}`);
  }
  return partes.join(" · ");
}
