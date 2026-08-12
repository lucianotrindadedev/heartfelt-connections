// Resposta de fallback do guard anti-stall no estágio SLOT_OFFER.
//
// O guard substitui a "enrolação" do modelo por um próximo passo concreto. No
// ramo "ainda não escolheu horário" essa substituição era ESTÁTICA: re-oferecia
// sempre os mesmos `offered_slots`, sem olhar o que o lead acabou de pedir.
//
// Caso real (Odonto Carioca Campo Grande, 21 97558-2703, 23/07): o lead disse
// "estou pensando em ir aí no SÁBADO"; o guard respondeu "Tenho estes horários:
// quinta 23/07 às 13:30 ou 13:45" — ignorando o pedido. O lead repetiu, o guard
// repetiu o MESMO texto, e a conversa virou um loop de 3 mensagens idênticas
// (sensação de robô). Pior: a clínica NÃO abre sábado, e isso nunca foi dito,
// porque o guard curto-circuita antes de qualquer chamada de agenda.
//
// Aqui a resposta passa a considerar o dia pedido. Quando o dia não está no
// expediente, respondemos isso DETERMINISTICAMENTE — sem depender de tool.
//
// PURO: sem I/O. O orquestrador passa os dias ativos já resolvidos.
import { requestedDateFromText } from "@/lib/booking-template";

/** Nome por extenso das chaves usadas no business_hours_json. */
const NOME_DIA: Record<string, string> = {
  dom: "domingo",
  seg: "segunda-feira",
  ter: "terça-feira",
  qua: "quarta-feira",
  qui: "quinta-feira",
  sex: "sexta-feira",
  sab: "sábado",
};

const ABBR_PARA_CHAVE: Record<string, string> = {
  Sun: "dom",
  Mon: "seg",
  Tue: "ter",
  Wed: "qua",
  Thu: "qui",
  Fri: "sex",
  Sat: "sab",
};

/** Chave do dia da semana ("sab") de uma data YYYY-MM-DD, no fuso BRT. */
export function chaveDoDiaBrt(dataIso: string): string | null {
  const d = new Date(`${dataIso}T12:00:00-03:00`);
  if (isNaN(d.getTime())) return null;
  const abbr = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Sao_Paulo",
    weekday: "short",
  }).format(d);
  return ABBR_PARA_CHAVE[abbr] ?? null;
}

/** "2026-08-21" → "21/08" (BRT). "" se inválido. */
export function ddmmBrt(dataIso: string): string {
  const d = new Date(`${dataIso}T12:00:00-03:00`);
  if (isNaN(d.getTime())) return "";
  return new Intl.DateTimeFormat("pt-BR", {
    timeZone: "America/Sao_Paulo",
    day: "2-digit",
    month: "2-digit",
  }).format(d);
}

/**
 * Canoniza a chave de dia para comparação. As duas pontas falam vocabulários
 * DIFERENTES: activeWeekdayKeys() devolve nome por extenso sem acento
 * ("segunda","terca","quinta"), enquanto chaveDoDiaBrt() devolve a abreviação
 * do business_hours_json ("seg","ter","qui").
 *
 * Comparar os dois cru fazia `diasAtivos.includes("qui")` ser SEMPRE falso — e
 * o fallback afirmava "a gente não atende nesse dia" para TODOS os dias da
 * semana. Regressão real introduzida em 23/07 e detectada em 03/08 (Odonto
 * Carioca Campo Grande, 21 97558-2703): "sobre quinta-feira: a gente não atende
 * nesse dia" numa clínica que atende Seg–Sex — 26 mensagens erradas em produção.
 */
export function canonizaDia(chave: string): string {
  const base = (chave ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim()
    .replace(/[-\s]*feira$/, "")
    .trim();
  return base.slice(0, 3);
}

export interface SlotOfferFallbackInput {
  /** Última mensagem do lead. */
  lastUserMsg: string;
  /** Horários já ofertados (lead_data.offered_slots). O `iso` é obrigatório
   *  para saber se alguma vaga cai no dia pedido — sem ele não dá para impedir
   *  a contradição "não atendo nesse dia, mas tenho vaga nesse dia". */
  offeredSlots: { iso?: string | null; date_label?: string | null; time_label?: string | null }[];
  /** Dias ativos do expediente ("seg","ter",…) — de activeWeekdayKeys().
   *  Vazio = expediente não configurado; aí não afirmamos nada sobre o dia. */
  diasAtivos: string[];
}

export type SlotOfferFallbackMotivo =
  | "dia_fechado"
  | "dia_pedido_disponivel"
  | "reoferta"
  | "sem_slots";

export interface SlotOfferFallbackResult {
  reply: string;
  motivo: SlotOfferFallbackMotivo;
  /** Dia da semana pedido pelo lead ("sab"), quando houver. */
  diaPedido?: string;
}

/**
 * Monta a resposta do fallback levando em conta o dia que o lead pediu.
 * Nunca repete cegamente a mesma oferta quando o lead pediu outro dia.
 */
export function buildSlotOfferFallback(
  input: SlotOfferFallbackInput,
): SlotOfferFallbackResult {
  const slots = input.offeredSlots ?? [];
  const dataPedida = requestedDateFromText(input.lastUserMsg);

  // Se há vaga no dia que o lead pediu, ela vem PRIMEIRO — ele pediu quinta,
  // não faz sentido citar terça tendo quinta em mãos.
  const noDiaPedido = dataPedida
    ? slots.filter((s) => (s.iso ?? "").slice(0, 10) === dataPedida)
    : [];

  // NUNCA citar vaga ANTERIOR ao dia pedido. O lead que diz "depois do dia 21"
  // ou "a partir do dia 25" está EXCLUINDO o que veio antes — reoferecer isso
  // é ignorar o que ele acabou de falar, e o texto ainda se contradiz sozinho:
  // "Consigo verificar sexta-feira... Por enquanto tenho quarta-feira, 12/08".
  // Caso real (Escudero Odontologia, 12 98114-1612, 12/08): aconteceu duas
  // vezes na mesma conversa e a lead pediu desculpa pela confusão. Na varredura
  // de produção, 7 dos 8 usos deste ramo ofertavam um dia diferente do pedido.
  //
  // Slot sem `iso` fica: não dá para afirmar que é anterior, e barrar por
  // suposição descartaria a oferta inteira.
  const naoAnteriores = dataPedida
    ? slots.filter((s) => {
        const dia = (s.iso ?? "").slice(0, 10);
        return dia === "" || dia >= dataPedida;
      })
    : slots;

  const paraCitar = noDiaPedido.length > 0 ? noDiaPedido : naoAnteriores;
  const opcoes = paraCitar
    .slice(0, 2)
    .map((s) => `${s.date_label ?? ""} às ${s.time_label ?? ""}`.trim())
    .join(" ou ");
  // Baseado no que SOBROU de citável, não no que existe em mãos: filtrado tudo,
  // o texto precisa cair na variante que não mostra horário nenhum.
  const temOpcoes = opcoes !== "";

  const chave = dataPedida ? chaveDoDiaBrt(dataPedida) : null;

  // INVARIANTE: se a AGENDA já tem vaga no dia pedido, esse dia NÃO está
  // fechado — ponto final, independente do que o expediente configurado diga.
  // Sem isto o texto se contradizia na mesma frase: "a gente não atende
  // quinta-feira... mas consigo te encaixar quinta-feira 06/08 às 12:00".
  // A agenda é a fonte de verdade sobre disponibilidade real; o expediente é
  // só uma configuração que pode estar errada, desatualizada — ou comparada
  // com o vocabulário errado, que foi o bug de origem.
  const temVagaNoDiaPedido = noDiaPedido.length > 0;

  // Só afirmamos "não atendemos nesse dia" com expediente configurado.
  if (chave && input.diasAtivos.length > 0) {
    const nome = NOME_DIA[chave] ?? "esse dia";
    const ativos = new Set(input.diasAtivos.map(canonizaDia));
    const diaAtivo = ativos.has(canonizaDia(chave));
    if (!diaAtivo && !temVagaNoDiaPedido) {
      return {
        motivo: "dia_fechado",
        diaPedido: chave,
        reply: temOpcoes
          ? `Ah, sobre ${nome}: a gente não atende nesse dia, viu? 😊 Mas consigo te encaixar ${opcoes}. Algum desses funciona pra você?`
          : `Ah, sobre ${nome}: a gente não atende nesse dia, viu? 😊 Me diz outro dia que fique bom pra você que eu já vejo os horários.`,
      };
    }
    // Dia ATIVO, mas fora dos horários que temos em mãos: reconhece o pedido em
    // vez de repetir a mesma oferta (era isso que virava loop).
    //
    // Nomeia a DATA, não só o dia da semana. Quando o lead diz "depois do dia
    // 21", responder "consigo verificar sexta-feira" não confirma que
    // entendemos QUAL sexta — e foi justamente aí que a conversa real derrapou.
    const rotulo = `${nome}, ${ddmmBrt(dataPedida!)}`;
    return {
      motivo: "dia_pedido_disponivel",
      diaPedido: chave,
      reply: temOpcoes
        ? `Consigo verificar ${rotulo} pra você! 😊 Por enquanto tenho ${opcoes}. Prefere um desses ou quer que eu busque os horários de ${rotulo}?`
        : `Consigo verificar ${rotulo} pra você! 😊 Me confirma que eu já busco os horários desse dia.`,
    };
  }

  if (temOpcoes) {
    return {
      motivo: "reoferta",
      reply: `Tenho estes horários disponíveis: ${opcoes}. Qual fica melhor pra você? 😊`,
    };
  }
  return {
    motivo: "sem_slots",
    reply: "Pra seguir com seu agendamento, qual horário fica melhor pra você?",
  };
}
