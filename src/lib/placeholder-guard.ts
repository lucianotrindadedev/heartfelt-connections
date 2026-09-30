// Marcador de modelo copiado para a resposta: "[Nome]", "[valor a confirmar]",
// "[endereço da clínica]"...
//
// Caso real (Odonto Carioca Campo Grande, 21 96554-7833, 30/09 01:14): o lead
// ainda não tinha dito o nome e recebeu "Entendo perfeitamente, [Nome]. Fico
// feliz que você tenha me contado isso com sinceridade." — a frase-modelo da
// linha 303 do prompt da conta, copiada com o marcador. Varredura de 90 dias:
// 17 respostas enviadas com marcador em 17 conversas (14 "[Nome]", 10 delas na
// Odonto Carioca), mais "R$ [valor a confirmar]" (SpaçoIn) e "Fica em
// [endereço da clínica]!" (Costa Lima, follow-up).

/** Colchete simples com texto que começa por letra. Não pega "[[NOSPLIT]]"
 *  (colchete duplo) nem link "[texto](url)". */
const MARCADOR_RE = /(?<!\[)\[(\p{L}[\p{L} /_-]{0,40})\](?!\]|\()/gu;

/** Marcadores que pedem o NOME do lead. */
const NOME_RE = /^(?:primeiro\s+)?nome(?:\s+(?:e\s+)?sobrenome|\s+completo|\s+d[oa]\s+\p{L}+)?$/iu;
const NOME_COMPLETO_RE = /sobrenome|completo/i;

export interface LimpezaDeMarcadores {
  texto: string;
  /** Marcadores encontrados, como vieram ("[Nome]", "[valor a confirmar]"). */
  marcadores: string[];
}

/**
 * Tira da resposta os marcadores de modelo que o LLM copiou sem preencher.
 *
 *  - Nome ("[Nome]", "[Nome Sobrenome]", "[primeiro nome]"): com o nome já
 *    conhecido, preenche (primeiro nome, ou completo quando o marcador pede
 *    sobrenome). Sem nome, tira o vocativo junto com a vírgula: "Entendo, [Nome]."
 *    → "Entendo."; "Poxa, [Nome], eu entendo" → "Poxa, eu entendo".
 *  - Qualquer outro ("[valor a confirmar]", "[endereço da clínica]"): não há
 *    como preencher sem inventar — a FRASE inteira sai.
 *
 * Quem chama decide o que fazer se sobrar texto vazio.
 */
export function limparMarcadoresDeModelo(
  texto: string,
  nomeConhecido?: string | null,
): LimpezaDeMarcadores {
  const original = texto ?? "";
  const marcadores = [...original.matchAll(MARCADOR_RE)].map((m) => m[0]);
  if (marcadores.length === 0) return { texto: original, marcadores };

  const nome = (nomeConhecido ?? "").trim().replace(/\s+/g, " ");
  const primeiroNome = nome.split(" ")[0] ?? "";
  const ehNome = (interno: string) => NOME_RE.test(interno.trim());

  let t = original;
  if (primeiroNome) {
    t = t.replace(MARCADOR_RE, (m, interno: string) =>
      ehNome(interno) ? (NOME_COMPLETO_RE.test(interno) ? nome : primeiroNome) : m,
    );
  } else {
    // Vocativo no meio/fim da frase: ", [Nome]" some com a vírgula.
    t = t.replace(new RegExp(`\\s*,\\s*${MARCADOR_RE.source}`, "gu"), (m, interno: string) =>
      ehNome(interno) ? "" : m,
    );
    // Vocativo abrindo a frase: "[Nome], tudo bem?" → "Tudo bem?".
    t = t.replace(
      new RegExp(`(^|[.!?…]\\s+|\\n)${MARCADOR_RE.source}\\s*,?\\s*(\\p{L})?`, "gu"),
      (m, antes: string, interno: string, letra?: string) =>
        ehNome(interno) ? `${antes}${letra ? letra.toUpperCase() : ""}` : m,
    );
  }

  // O que sobrou (marcador que não é nome, ou nome sem vocativo): a frase sai.
  if (new RegExp(MARCADOR_RE.source, "u").test(t)) {
    const linhas = t.split("\n").map((linha) => {
      if (!new RegExp(MARCADOR_RE.source, "u").test(linha)) return linha;
      return linha
        .split(/(?<=[.!?…])\s+/)
        .filter((frase) => !new RegExp(MARCADOR_RE.source, "u").test(frase))
        .join(" ");
    });
    t = linhas.join("\n").replace(/\n{3,}/g, "\n\n");
  }
  return { texto: t.trim(), marcadores };
}
