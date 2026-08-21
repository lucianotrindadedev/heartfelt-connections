// Leitura ESTRATÉGICA das mensagens do lead: objeções e interesses.
//
// É heurística determinística de propósito, não LLM. O painel de métricas é
// aberto o tempo todo e roda sobre milhares de mensagens — classificar com
// modelo custaria dinheiro por visualização, seria lento e daria número
// diferente a cada abertura. Aqui o mesmo período sempre devolve o mesmo
// número, de graça e na hora, e dá pra auditar por que uma frase entrou num
// grupo (é só ler o padrão).
//
// A contrapartida é honesta e está escrita na tela: cobre as formas comuns de
// escrever no WhatsApp, não todas. Serve pra ver PROPORÇÃO e TENDÊNCIA
// ("preço dobrou depois que subimos a tabela"), não pra auditoria exata.

/** Grupos de objeção que o painel mede. */
export type ObjectionKey =
  | "preco"
  | "agenda"
  | "distancia"
  | "pensar"
  | "terceiro"
  | "medo"
  | "duvida_resultado"
  | "quer_humano"
  | "sem_interesse"
  | "pagamento";

export const OBJECTION_LABELS: Record<ObjectionKey, string> = {
  preco: "Preço / valor",
  agenda: "Horário não encaixa",
  distancia: "Distância / localização",
  pensar: "Vou pensar",
  terceiro: "Precisa falar com alguém",
  medo: "Medo / dor / segurança",
  duvida_resultado: "Dúvida se funciona",
  quer_humano: "Quer falar com humano",
  sem_interesse: "Sem interesse",
  pagamento: "Forma de pagamento / convênio",
};

/** Ordem de exibição — do que mais trava venda pro que menos. */
export const OBJECTION_ORDER: ObjectionKey[] = [
  "preco",
  "agenda",
  "pensar",
  "distancia",
  "terceiro",
  "duvida_resultado",
  "medo",
  "pagamento",
  "quer_humano",
  "sem_interesse",
];

/** Minúsculas e sem acento — o lead escreve "preço", "preco" e "PREÇO". */
export function normalizeText(raw: string): string {
  return (raw ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// Os padrões rodam sobre texto JÁ normalizado (sem acento), por isso não têm
// acento nenhum aqui dentro.
const PATTERNS: Record<ObjectionKey, RegExp[]> = {
  preco: [
    /\bquanto\s+(custa|fica|sai|e|seria|ficaria|custaria)\b/,
    /\bqual\s+(o\s+|e\s+o\s+)?(valor|preco|custo|investimento)\b/,
    /\b(valor|preco|orcamento)\s+(da|do|de|dessa|desse|para|pra)\b/,
    /\b(ta|esta|e|ficou|achei)\s+(muito\s+)?caro\b/,
    /\bcaro\s+(demais|pra\s+mim)\b/,
    /\bnao\s+tenho\s+(condicoes|dinheiro|grana)\b/,
    /\b(sem|fora\s+do\s+meu)\s+(condicoes|orcamento)\b/,
    /\b(tem|faz|da)\s+desconto\b/,
    /\bpromocao\b/,
  ],
  agenda: [
    /\bnao\s+(posso|consigo|da|vou\s+conseguir)\b[^.!?]{0,25}\b(nesse|neste|nessa|esse|essa|dia|horario|hora|manha|tarde|noite|\d{1,2})\b/,
    /\bso\s+(posso|consigo|saio|largo|fico\s+livre|tenho)\b/,
    /\btrabalho\s+(ate|o\s+dia|das|de)\b/,
    /\bnao\s+tenho\s+tempo\b/,
    /\b(tem|teria|pode\s+ser)\s+(outro|outra)\s+(dia|horario|data)\b/,
    /\b(muito|meio)\s+(cedo|tarde)\s+(pra|para)\s+mim\b/,
    /\b(to|estou)\s+trabalhando\b/,
    /\bnesse\s+horario\s+(eu\s+)?nao\b/,
  ],
  distancia: [
    /\b(muito\s+)?longe\b/,
    /\bfica\s+(muito\s+)?(longe|distante)\b/,
    /\bnao\s+tenho\s+como\s+(ir|chegar|me\s+locomover)\b/,
    /\b(dificil|complicado)\s+(de\s+)?(ir|chegar)\b/,
    /\b(e\s+de\s+|em\s+)?outra\s+cidade\b/,
    /\bnao\s+conheco\s+(a\s+)?regiao\b/,
  ],
  pensar: [
    /\bvou\s+(pensar|analisar|ver\s+direitinho|dar\s+uma\s+pensada)\b/,
    /\b(depois|mais\s+pra\s+frente|mais\s+tarde)\s+eu\s+(vejo|falo|te\s+chamo|retorno|entro\s+em\s+contato)\b/,
    /\b(te\s+)?aviso\s+(depois|qualquer\s+coisa)\b/,
    /\bqualquer\s+coisa\s+eu\s+(chamo|falo|aviso|retorno)\b/,
    /\bpreciso\s+pensar\b/,
    /\bdeixa\s+eu\s+ver\s+(aqui|direitinho)\b/,
  ],
  terceiro: [
    /\b(falar|ver|conversar|combinar|alinhar)\s+com\s+(meu|minha|o\s+meu|a\s+minha|meus|minhas)\s+(marido|esposa|mulher|mae|pai|namorad\w*|filh\w*|familia|chefe|patrao|sogr\w*)\b/,
    /\bpreciso\s+(falar|ver|combinar)\s+com\b/,
    /\bvou\s+(ver|falar)\s+com\s+(ele|ela|eles|meu|minha)\b/,
    /\bdepende\s+d(o|a)\s+(meu|minha)\b/,
  ],
  medo: [
    /\b(doi|di?oi)\s*(muito|bastante|ne|\?)?\b/,
    /\be\s+dolorid\w+\b/,
    /\b(tenho|to\s+com|estou\s+com)\s+medo\b/,
    /\bmedo\s+de\b/,
    /\befeito\s+colateral\b/,
    /\be\s+seguro\b/,
    /\bfaz\s+mal\b/,
    /\b(tenho|sou)\s+alergic\w+\b/,
    /\btem\s+risco\b/,
  ],
  duvida_resultado: [
    /\bfunciona\s+(mesmo|de\s+verdade)\b/,
    /\b(da|traz)\s+resultado\s+mesmo\b/,
    /\bnao\s+sei\s+se\s+(funciona|da\s+certo|vale\s+a\s+pena)\b/,
    /\b(tem|da)\s+garantia\b/,
    /\bdura\s+quanto\s+tempo\b/,
    /\bvale\s+a\s+pena\b/,
    /\bja\s+fiz\s+(e\s+)?nao\s+(deu|funcionou|adiantou)\b/,
  ],
  quer_humano: [
    /\bfalar\s+com\s+(um|uma|alguem|uma\s+pessoa|atendente|humano|responsavel|medic\w+|doutor\w*|dra\b)/,
    /\b(voce|vc|isso)\s+e\s+(um\s+)?(rob(o|otzinho)|bot|ia|inteligencia\s+artificial)\b/,
    /\bquero\s+falar\s+com\s+alguem\b/,
    /\bme\s+(liga|liguem|chama\s+no\s+telefone)\b/,
  ],
  sem_interesse: [
    /\bnao\s+(quero|vou\s+querer|tenho\s+interesse|me\s+interessa)\b/,
    /\bdesisti\b/,
    /\bdeixa\s+(pra\s+la|quieto|pra\s+depois)\b/,
    /\b(obrigad\w+|obg|vlw)[,.\s]+nao\b/,
    /\bnao\s+precisa\s+mais\b/,
    /\bpode\s+(cancelar|tirar\s+meu\s+numero)\b/,
  ],
  pagamento: [
    /\baceita(m)?\s+(convenio|plano|cartao|pix|dinheiro|boleto)\b/,
    /\bplano\s+de\s+saude\b/,
    /\bpode\s+parcelar\b/,
    /\b(parcela|parcelad\w+)\s+em\b/,
    /\b(quantas|em\s+quantas)\s+vezes\b/,
    /\bforma(s)?\s+de\s+pagamento\b/,
  ],
};

/**
 * Objeções presentes numa mensagem DO LEAD. Pode devolver mais de uma — "é
 * muito caro e ainda fica longe" trava a venda por dois motivos, e juntar tudo
 * num só apagaria metade da informação.
 *
 * Só faz sentido chamar com texto do LEAD: a fala do agente cita preço, horário
 * e endereço o tempo todo e envenenaria toda a contagem.
 */
export function classifyObjections(rawText: string): ObjectionKey[] {
  const t = normalizeText(rawText);
  // Mensagem muito curta é resposta de fluxo ("sim", "ok", "tarde"), não
  // objeção. O piso evita que um "nao" solto — que costuma responder a uma
  // pergunta fechada do agente — vire "sem interesse".
  if (t.length < 4) return [];
  const out: ObjectionKey[] = [];
  for (const key of OBJECTION_ORDER) {
    if (PATTERNS[key].some((re) => re.test(t))) out.push(key);
  }
  return out;
}

/**
 * Agrupa variações do mesmo interesse ("Lipo enzimática", "lipo enzimatica",
 * "LIPO ENZIMÁTICA  ") numa chave só, devolvendo o rótulo mais legível que
 * apareceu. Sem isto o top de interesses vira uma lista de quase-duplicatas.
 */
export function interestKey(raw: string): string {
  return normalizeText(raw).replace(/[^a-z0-9 ]/g, "").trim();
}

/** Texto de interesse aproveitável? Descarta lixo e frase solta. */
export function isUsableInterest(raw: string | null | undefined): boolean {
  const t = (raw ?? "").trim();
  if (t.length < 3 || t.length > 60) return false;
  // Frase inteira não é um interesse — é o agente ou o lead conversando.
  if (t.split(/\s+/).length > 6) return false;
  return /[a-zA-ZÀ-ÿ]/.test(t);
}

/** Conta ocorrências e devolve o top N já ordenado, com o rótulo mais comum. */
export function topCounts(
  entries: { key: string; label: string }[],
  limit: number,
): { label: string; count: number }[] {
  const byKey = new Map<string, { label: string; count: number }>();
  for (const e of entries) {
    if (!e.key) continue;
    const cur = byKey.get(e.key);
    if (cur) cur.count += 1;
    else byKey.set(e.key, { label: e.label, count: 1 });
  }
  return [...byKey.values()].sort((a, b) => b.count - a.count).slice(0, limit);
}

/** Mediana de uma lista numérica (0 se vazia). */
export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? Math.round((s[mid - 1]! + s[mid]!) / 2) : s[mid]!;
}

/** Percentil (0-100) por interpolação de índice. 0 se vazia. */
export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const idx = Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1));
  return s[idx]!;
}
