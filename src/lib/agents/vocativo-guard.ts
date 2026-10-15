// Vocativo informal / apelido na resposta ao lead.
//
// Caso real (Odonto Sorrisos, 87 99824-4791, 15/10): a lead mandou um áudio
// "Bom dia, estou vendo sua mensagem agora, nega…" e a IA respondeu "Nega,
// infelizmente essa semana a agenda de 16h está fechada…" — a recepção apagou a
// mensagem para não constranger a paciente. O prompt da conta só dizia "nunca
// invente nomes ou apelidos"; nada impedia COPIAR o apelido que o lead usou.
//
// Varredura de 60 dias (79 mil respostas): 34 com vocativo informal em 27
// conversas — "querida" (19), "mano" (4), "irmão", "amigo" (3), "querido" (2),
// "nega", "flor", "amor". Em 21 o lead tinha usado a palavra antes (cópia); nas
// outras 13 o modelo usou por conta própria ("Obrigada, amor! 😍").
//
// Duas camadas: a regra no prompt (o modelo deixa de escrever) e a trava abaixo,
// que tira o vocativo do texto antes do envio quando o modelo escreve mesmo assim.
// PURO: sem I/O.

/** Linha das REGRAS ABSOLUTAS do qualifier e do scheduler. */
export const VOCATIVO_RULE =
  '🚫 **TRATAMENTO:** chame o lead pelo nome dele ou sem vocativo. NUNCA use apelido, termo carinhoso ou gíria ("querida", "querido", "amor", "nega", "mano", "irmão", "amigo", "flor", "linda"…) — nem se o próprio lead chamar você assim.';

const TERMOS = [
  "nega",
  "nêga",
  "neguinha",
  "querida",
  "querido",
  "queridinha",
  "queridinho",
  "meu amor",
  "amor",
  "amorzinho",
  "meu bem",
  "benzinho",
  "mano",
  "mana",
  "maninho",
  "maninha",
  "irmão",
  "irmã",
  "amigo",
  "amiga",
  "miga",
  "migo",
  "flor",
  "florzinha",
  "linda",
  "lindo",
  "lindona",
  "gata",
  "gato",
  "gatinha",
  "gatinho",
  "fofa",
  "fofo",
  "princesa",
  "docinho",
  "xuxu",
  "chuchu",
  "bebê",
  "mainha",
  "painho",
  "véi",
  "parceiro",
  "parceira",
  "patroa",
  "patrão",
];

const semAcento = (s: string) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");

/** O que pode vir depois do vocativo: pontuação, fim, quebra de linha ou emoji. */
const DEPOIS = String.raw`(?=\s*(?:[!.?…,;:]|$|\n|\p{Extended_Pictographic}))`;

/**
 * Tira o vocativo informal do texto — só quando ele está CHAMANDO o lead:
 * depois de vírgula ("Perfeito, querida!") ou abrindo a frase ("Nega,
 * infelizmente…"). "Ficou linda", "um amigo indicou" e "com amor" não mudam.
 * Se a palavra for o nome do lead (ex.: alguém chamado Flor), não mexe nela.
 */
export function removerVocativoInformal(texto: string, nomeDoLead?: string | null): string {
  if (!texto) return texto;
  const nome = semAcento(nomeDoLead ?? "").split(/\s+/)[0] ?? "";
  const termos = TERMOS.filter((t) => semAcento(t) !== nome);
  if (termos.length === 0) return texto;
  const alt = termos
    .sort((a, b) => b.length - a.length)
    .map((t) => t.replace(/\s+/g, String.raw`\s+`))
    .join("|");

  // "Perfeito, querida! 😊" → "Perfeito! 😊"; "Entendi, mano, vou…" → "Entendi, vou…"
  let out = texto.replace(new RegExp(String.raw`\s*,\s*(?:${alt})(?!\p{L})${DEPOIS}`, "giu"), "");

  // "Nega, infelizmente…" → "Infelizmente…"; "Querida! Que bom…" → "Que bom…"
  out = out.replace(
    new RegExp(String.raw`(^|[.!?…]\s+|\n\s*)(?:${alt})(?!\p{L})\s*[,!]+\s*(\p{L}?)`, "giu"),
    (_m, antes: string, letra: string) => `${antes}${letra.toUpperCase()}`,
  );

  // Nada removido → o texto volta intacto (a limpeza abaixo só arruma o que a
  // remoção deixou para trás).
  if (out === texto) return texto;
  // Vírgula que sobrou na frente da pontuação ("Oi, ! Tudo") e espaços duplos.
  return out.replace(/,\s*([!.?…])/g, "$1").replace(/[ \t]{2,}/g, " ");
}
