// Saudação do período ("Bom dia" / "Boa tarde" / "Boa noite") na resposta ao lead.
//
// Caso real (Amazing CCZ, 21 97558-2703, 26/10/2026): às 17:15 o lead escreveu
// "Gostaria de mais informações" e a IA abriu com "Boa noite!". O prompt
// dinâmico trazia "HOJE é segunda-feira, 26/10/2026, 17:14" e o prompt da conta
// dizia "Boa tarde de 12h às 17h59" — o modelo só errou a conta de cabeça.
//
// Varredura de 3 semanas (todas as contas): 23 respostas abrindo com saudação
// fora do período. Em 11 a IA só repetiu a saudação do lead ("Bom dia" dele às
// 11:59, resposta às 12:00) — aceitável. As outras 12 o modelo inventou, no
// qualifier e no scheduler ("Boa noite" às 15h16, "Boa tarde" às 09h32).
//
// Duas camadas, como no vocativo-guard: a saudação certa calculada aqui vai
// escrita no prompt, e a trava abaixo troca a saudação de abertura antes do
// envio quando o modelo erra mesmo assim. PURO: sem I/O.

export type Saudacao = "Bom dia" | "Boa tarde" | "Boa noite";

const TZ = "America/Sao_Paulo";

function horaEmSaoPaulo(agora: Date): number {
  const h = new Intl.DateTimeFormat("en-US", { timeZone: TZ, hour: "numeric", hourCycle: "h23" }).format(
    agora,
  );
  return Number(h) % 24;
}

/**
 * Saudação do período no horário de São Paulo: 05h–11h59 "Bom dia", 12h–17h59
 * "Boa tarde", 18h–04h59 "Boa noite". De madrugada "Boa noite" é o que a
 * recepção diria — "Bom dia" à 00:17 soaria estranho.
 */
export function saudacaoDoHorario(agora: Date = new Date()): Saudacao {
  const h = horaEmSaoPaulo(agora);
  if (h >= 5 && h < 12) return "Bom dia";
  if (h >= 12 && h < 18) return "Boa tarde";
  return "Boa noite";
}

/** Linha do bloco de ESTADO ATUAL do qualifier e do scheduler. */
export function linhaSaudacaoDoHorario(agora: Date = new Date()): string {
  return `- 👋 SAUDAÇÃO CORRETA AGORA: "${saudacaoDoHorario(agora)}". Se for cumprimentar, use exatamente esta — não deduza o período pela hora.`;
}

function normalizar(texto: string): string {
  return (texto ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");
}

// Saudação logo na abertura, com "Oi"/"Olá" opcional antes: "Boa noite!",
// "Olá, boa tarde!", "Oi! Bom dia 😊".
const ABERTURA = /^(\s*(?:(?:oi+|ol[aá])\s*[,!.]?\s*)?)(bom\s+dia|boa\s+tarde|boa\s+noite)\b/i;

export interface CorrecaoSaudacao {
  texto: string;
  /** Preenchidos só quando a saudação foi trocada. */
  de?: string;
  para?: Saudacao;
}

/**
 * Troca a saudação de ABERTURA da resposta quando ela não é a do período.
 * Não mexe quando o lead usou essa mesma saudação na última rajada (a IA está
 * só respondendo ao cumprimento dele) nem em saudações no meio do texto.
 */
export function corrigirSaudacao(
  texto: string,
  mensagensDoLead: string[],
  agora: Date = new Date(),
): CorrecaoSaudacao {
  const m = ABERTURA.exec(texto ?? "");
  if (!m) return { texto };
  const usada = m[2]!;
  const certa = saudacaoDoHorario(agora);
  const usadaNorm = normalizar(usada).replace(/\s+/g, " ");
  if (usadaNorm === normalizar(certa)) return { texto };
  // Madrugada é ambígua: "Bom dia" às 04:55 também é natural. Só "Boa tarde" é erro.
  if (horaEmSaoPaulo(agora) < 5 && usadaNorm === "bom dia") return { texto };
  const leadUsou = mensagensDoLead.some((msg) => normalizar(msg).replace(/\s+/g, " ").includes(usadaNorm));
  if (leadUsou) return { texto };

  // Mantém a caixa: "Boa noite" → "Boa tarde"; "boa noite" (após "Olá,") → "boa tarde".
  const primeiraMaiuscula = usada[0] === usada[0]!.toUpperCase();
  const troca = primeiraMaiuscula ? certa : certa.toLowerCase();
  const inicio = m.index + m[1]!.length;
  return {
    texto: texto.slice(0, inicio) + troca + texto.slice(inicio + usada.length),
    de: usada,
    para: certa,
  };
}
