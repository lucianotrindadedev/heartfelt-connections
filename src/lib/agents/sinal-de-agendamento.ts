// O lead já deu algum sinal de que quer AGENDAR (visita, consulta, avaliação)?
//
// Caso real (Amazing CCZ, 11 97046-2234, 29/10/2026): "Gostaria de informações
// / Sobre o ensino médio / 1 ano do médio para o ano de 2027 / Rafaella" — e o
// qualifier chamou listar_horarios por conta própria e ofertou "quinta 13:00
// ou 14:00", pulando a apresentação da escola e o convite para a visita que o
// prompt da conta manda fazer antes. O scaffold técnico dizia "quando o
// interesse estiver claro, sinalize SLOT_OFFER" e o modelo leu interesse como
// pedido. Varredura de 30 dias na Amazing: 11 das 13 ofertas de horário saíram
// antes do convite, 10 sem o lead ter pedido nada.
//
// Esta função não decide o fluxo — só responde "houve pedido?". Reaproveita os
// detectores que já existem (detectSignals, turno, dia da semana, pergunta de
// rotina do #97) em vez de reimplementar. PURO: sem I/O.

import { requestedPeriodoFromText, requestedWeekdayFromText } from "@/lib/booking-template";
import { perguntaSobreHorarioDoServico } from "./pergunta-informativa";
import { detectSignals } from "./stage-signals";

function normalizar(texto: string): string {
  return (texto ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\s+/g, " ");
}

// Palavras de pedido de agenda. "horário" entra — "tem horário?" é o pedido
// mais comum —, mas a pergunta sobre a ROTINA ("horário de aula", "é
// integral?") sai antes, pelo detector do #97.
const PEDIDO_RE =
  /\b(visita|visitar|agend\w*|marca|marcar|marcacao|remarcar|consulta|avaliacao|horario|horarios|disponib\w*|vaga|vagas|encaixe|conhecer (?:a escola|o colegio|o espaco|a clinica|voces|pessoalmente)|ver (?:a escola|o colegio|a clinica|o espaco)|quando (?:posso|eu posso|podemos|da)|posso ir|ir ai|passar ai|ir conhecer)\b/;

// Referência de QUANDO ("amanhã", "semana que vem", "dia 7", "em novembro").
const QUANDO_RE =
  /\b(hoje|amanha|semana (?:que|q) vem|proxima semana|fim de semana|final de semana|dia \d{1,2}|janeiro|fevereiro|marco|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro)\b/;

// Frase sobre idade/aniversário: o "quando" ali é do nascimento, não da visita.
// Caso real (Amazing, 11 98213-3577, 28/10): "ele tem 4 anos e faz 5 em junho".
const IDADE_RE = /\b(\d+\s*anos?|aniversario|nasceu|nascid[ao]|nascimento|faz \d+|fara \d+|completa|completou)\b/;

type Turno = { role: "user" | "assistant"; content: string };

/** Uma mensagem do lead pede agenda (palavra de pedido, dia ou turno)? */
export function mensagemPedeAgendamento(texto: string): boolean {
  if (!texto?.trim() || perguntaSobreHorarioDoServico(texto)) return false;
  const t = normalizar(texto);
  if (PEDIDO_RE.test(t)) return true;
  if (IDADE_RE.test(t)) return false;
  if (QUANDO_RE.test(t)) return true;
  return !!(requestedPeriodoFromText(texto) || requestedWeekdayFromText(texto));
}

/**
 * Em algum momento da conversa o lead pediu agenda — ou acabou de dizer "sim"
 * a uma proposta de ver horários, ou citou uma data?
 */
export function leadPediuAgendamento(history: Turno[]): boolean {
  if (history.some((m) => m.role === "user" && mensagemPedeAgendamento(m.content))) return true;
  const s = detectSignals({ stage: "QUALIFICATION", leadData: {}, history, hasBookingIntegration: true });
  return s.userAcceptedSchedulingProposal || s.userAskedDateAvailability || s.slotSelectionTurn;
}

/**
 * Opção do agente `settings.oferta_so_com_pedido = "true"`: a qualificação só
 * consulta a agenda e oferta horário DEPOIS de um pedido do lead. Desligada por
 * padrão — nas clínicas ofertar logo após o "sim" do paciente é o fluxo pedido
 * pelo dono (varredura de 30 dias: 96 das 98 ofertas sem pedido explícito eram
 * de clínicas). Feita para escola, onde o prompt manda apresentar e convidar
 * antes ("Quer que eu veja um horário para a sua visita?").
 *
 * true = a qualificação deve SEGURAR a oferta neste turno.
 */
export function ofertaAguardaPedido(
  settings: Record<string, unknown> | null | undefined,
  history: Turno[],
  offeredSlots?: unknown[] | null,
): boolean {
  if (String(settings?.oferta_so_com_pedido ?? "").trim().toLowerCase() !== "true") return false;
  if ((offeredSlots?.length ?? 0) > 0) return false;
  return !leadPediuAgendamento(history);
}

/**
 * Turnos do lead = rajadas de mensagens seguidas, não mensagens soltas. O
 * qualifier contava mensagens e chamava isso de "ciclos": a lead da Amazing
 * (11 97046-2234) quebrou 3 respostas em 6 mensagens e o prompt dizia "Ciclos
 * de conversa já completos: 6" — e as regras de avanço ("após 3-4 ciclos,
 * oferte horário") leem esse número.
 */
export function contarTurnosDoLead(history: Turno[]): number {
  let turnos = 0;
  for (let i = 0; i < history.length; i++) {
    if (history[i]!.role === "user" && history[i - 1]?.role !== "user") turnos++;
  }
  return turnos;
}

/** Linha do ESTADO ATUAL do qualifier enquanto a oferta aguarda o pedido. */
export const LINHA_OFERTA_AGUARDA_PEDIDO =
  '- 🚫 O LEAD AINDA NÃO PEDIU VISITA/HORÁRIO: não consulte a agenda, não cite horário e não use next_stage="SLOT_OFFER" neste turno. Siga o fluxo do prompt do proprietário (apresentação, dúvidas) e termine com o CONVITE dele para agendar — a agenda só abre depois que o lead aceitar ou pedir.';
