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

export interface SlotOfferFallbackInput {
  /** Última mensagem do lead. */
  lastUserMsg: string;
  /** Horários já ofertados (lead_data.offered_slots). */
  offeredSlots: { date_label?: string | null; time_label?: string | null }[];
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
  const temOpcoes = slots.length > 0;
  const opcoes = slots
    .slice(0, 2)
    .map((s) => `${s.date_label ?? ""} às ${s.time_label ?? ""}`.trim())
    .join(" ou ");

  const dataPedida = requestedDateFromText(input.lastUserMsg);
  const chave = dataPedida ? chaveDoDiaBrt(dataPedida) : null;

  // Só afirmamos "não atendemos nesse dia" com expediente configurado.
  if (chave && input.diasAtivos.length > 0) {
    const nome = NOME_DIA[chave] ?? "esse dia";
    if (!input.diasAtivos.includes(chave)) {
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
    return {
      motivo: "dia_pedido_disponivel",
      diaPedido: chave,
      reply: temOpcoes
        ? `Consigo verificar ${nome} pra você! 😊 Por enquanto tenho ${opcoes}. Prefere um desses ou quer que eu busque os horários de ${nome}?`
        : `Consigo verificar ${nome} pra você! 😊 Me confirma que eu já busco os horários desse dia.`,
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
