// Guard anti-"agenda fechada inventada".
//
// Caso real (Odonto Carioca Campo Grande, 21 99826-0816, 11/08): o lead viu no
// Instagram o evento "Resgatando Sorrisos" do dia 12 e perguntou por esse dia.
// A resposta foi:
//
//   "Infelizmente a agenda de amanhã já está fechada para novos agendamentos."
//
// Essa mensagem saiu com tools=[]. O agente não consultou nada — recebeu, no
// turno anterior, uma lista de horários que só tinha quinta 13/08 e RACIONALIZOU
// a ausência do dia 12. A agenda tinha 2 vagas naquele dia (11:00 e 11:15). O
// lead foi atraído por uma campanha e ouviu que o dia da campanha estava fechado.
//
// O erro de fundo não é o dia errado — é o agente afirmar um FATO que ele nunca
// teve como saber. E há dois fatos distintos, com fontes de verdade distintas:
//
//   "a clínica não abre nesse dia"  -> só o EXPEDIENTE (business_hours_json)
//                                      sustenta isso;
//   "não tenho horário nesse dia"   -> só uma consulta REAL à agenda
//                                      (listar_horarios neste turn) sustenta.
//
// O modelo trata as duas como intercambiáveis. Aqui elas têm barras de prova
// diferentes: afirmar fechamento sem expediente que confirme é bloqueado mesmo
// que a agenda tenha sido consultada; afirmar falta de vaga sem ter consultado
// é bloqueado mesmo que o dia seja atípico.
//
// PURO: sem I/O. O orquestrador passa expediente e tools_called já resolvidos.
import { requestedDateFromText } from "@/lib/booking-template";

import { canonizaDia, chaveDoDiaBrt } from "./slot-offer-fallback";

const NOME_DIA: Record<string, string> = {
  dom: "domingo",
  seg: "segunda-feira",
  ter: "terça-feira",
  qua: "quarta-feira",
  qui: "quinta-feira",
  sex: "sexta-feira",
  sab: "sábado",
};

/**
 * A frase fala de um DIA? Sem isso não dá para saber se a negativa é sobre a
 * agenda ou sobre outra coisa qualquer.
 *
 * É o que separa "não atendemos nesse dia" (afirmação sobre expediente) de
 * "não atendemos Unimed" / "não atendemos por telefone" — negativas legítimas
 * que aparecem o tempo todo e que o guard não pode reescrever.
 */
const MARCADOR_DE_DIA =
  /\b(?:(?:n?[ae]ss[ea]|est[ea])\s+dia|no\s+dia|desse\s+dia|amanh[ãa]|hoje|segunda|ter[çc]a|quarta|quinta|sexta|s[áa]bado|domingo|feriado|fim\s+de\s+semana|finais\s+de\s+semana|\d{1,2}\/\d{1,2})/;

/**
 * Divide em ORAÇÕES — os guards abaixo avaliam uma por vez, para não casar a
 * negativa de uma com o dia de outra.
 *
 * Corta também nas adversativas ("mas", "porém"), porque a resposta típica do
 * agente é "nega um dia MAS oferece outro" na mesma frase, e os dois dias
 * disputavam a resolução. Casos reais: "Amanhã (terça) não temos vaga, mas
 * achei um horário bem pertinho: quarta-feira, 12/08" — o dia resolvia como
 * quarta, batia com a vaga ofertada e o guard acusava contradição onde não
 * havia. Cortar aqui deixa cada afirmação com o seu próprio dia.
 */
function frases(t: string): string[] {
  return t
    .split(/[.!?\n]+|\b(?:mas|por[ée]m|contudo|entretanto|todavia)\b/)
    .map((f) => (f ?? "").trim())
    .filter(Boolean);
}

/** "sábados" → "sábado". O agente fala no plural o tempo todo ("não atendemos
 *  aos sábados") e o resolvedor de data só entende o singular. */
function singularizaDias(t: string): string {
  return t.replace(
    /\b(domingo|segunda|ter[çc]a|quarta|quinta|sexta|s[áa]bado)s\b/g,
    "$1",
  );
}

const STEMS_DIA = ["domingo", "segunda", "terca", "quarta", "quinta", "sexta", "sabado"];

/** A oração cita algum dia em que a clínica NÃO abre? */
function citaDiaFechado(f: string, ativos: Set<string>): boolean {
  const semAcc = f.normalize("NFD").replace(/[̀-ͯ]/g, "");
  return STEMS_DIA.some(
    (stem) => new RegExp(`\\b${stem}s?\\b`).test(semAcc) && !ativos.has(canonizaDia(stem)),
  );
}

/**
 * O agente afirma que a clínica NÃO FUNCIONA / está fechada naquele dia. É uma
 * afirmação sobre o EXPEDIENTE, não sobre disponibilidade.
 *
 * "fechado" solto NÃO conta: é a gíria de confirmação mais usada pelo agente
 * ("Fechado! Te espero quinta", "Fechado, seu agendamento está confirmado").
 * Por isso cada padrão amarra o "fechado" a um sujeito de agenda/clínica.
 */
export function claimsClinicClosed(reply: string): boolean {
  return frases((reply ?? "").toLowerCase()).some(
    (f) => MARCADOR_DE_DIA.test(f) && afirmaFechamento(f),
  );
}

/** Idem, para UMA frase já em minúsculas (sem checar o marcador de dia). */
function afirmaFechamento(f: string): boolean {
  {
    // "a agenda de amanhã já está fechada"
    if (/\b(agenda|cl[íi]nica|unidade|consult[óo]rio)\b[^,;]{0,45}?\bfechad[oa]/.test(f)) {
      return true;
    }
    // "fechada para novos agendamentos"
    if (/\bfechad[oa]s?\b[^,;]{0,25}?\bpara\s+(?:novos\s+)?agendamentos?\b/.test(f)) return true;
    // "estamos fechados", "fica fechado"
    if (/\b(?:estamos|est[áa]|ficamos|fica|fic[áa]mos)\s+fechad[oa]s?\b/.test(f)) return true;
    // 1ª pessoa do plural: o sujeito é sempre a clínica.
    // "não atendemos aos sábados", "não abrimos", "não funcionamos".
    if (
      /\bn[ãa]o\s+(?:\w+\s+){0,2}?(?:atendemos|abrimos|funcionamos|trabalhamos)\b/.test(f)
    ) {
      return true;
    }
    // 3ª pessoa: só quando o sujeito NOMEADO é a clínica. Sem esta amarra,
    // "a dentista de manutenção não atende aqui na quarta-feira" (real, e
    // verdadeiro) disparava o guard e uma resposta correta era descartada — o
    // sujeito ali é um profissional, não a clínica.
    if (
      /\b(?:a\s+gente|a\s+cl[íi]nica|o\s+consult[óo]rio|a\s+unidade|a\s+empresa)\s+n[ãa]o\s+(?:\w+\s+){0,2}?(?:atende|abre|funciona|trabalha)\b/.test(
        f,
      )
    ) {
      return true;
    }
    if (/\bn[ãa]o\s+(?:h[áa]|tem|temos)\s+(?:\w+\s+){0,2}?atendimento\b/.test(f)) return true;
    return false;
  }
}

/**
 * O agente afirma que NÃO HÁ VAGA naquele dia. É uma afirmação sobre a AGENDA.
 */
export function claimsNoAvailability(reply: string): boolean {
  return frases((reply ?? "").toLowerCase()).some(
    (f) => MARCADOR_DE_DIA.test(f) && afirmaFaltaDeVaga(f),
  );
}

/** Idem, para UMA frase já em minúsculas (sem checar o marcador de dia). */
function afirmaFaltaDeVaga(f: string): boolean {
  {
    if (
      /\bn[ãa]o\s+(?:\w+\s+){0,3}?(?:h[áa]|tem|temos|tenho|restou|sobrou|consigo|consegui)\b[^,;]{0,45}?\b(?:hor[áa]rios?|vagas?|disponibilidade|encaixes?)\b/.test(
        f,
      )
    ) {
      return true;
    }
    if (/\bsem\s+(?:hor[áa]rios?|vagas?|disponibilidade)\b/.test(f)) return true;
    // O adjetivo precisa estar amarrado à AGENDA ou ao DIA. Solto ele fala de
    // um horário específico: "esse horário acabou de ficar indisponível 😕 Mas
    // consigo te encaixar terça 11/08 às 15:15" é real, correto, e não é uma
    // afirmação sobre o dia — bloquear trocaria uma resposta boa pela do guard.
    if (
      /\b(?:agenda|dia)\b[^,;]{0,30}?\b(?:lotad[oa]s?|cheia|completa|esgotad[oa]s?)\b/.test(f)
    ) {
      return true;
    }
    if (/\b(?:hor[áa]rios?|vagas?)\b[^,;]{0,25}?\b(?:esgotaram|esgotou)\b/.test(f)) return true;
    return false;
  }
}

/**
 * A afirmação é sobre uma FATIA do dia (turno ou horário), não sobre o dia.
 *
 * "No sábado de manhã não temos vaga, mas tenho três horários no sábado à
 * tarde" e "terça-feira, 18/08 não tem vaga às 14:30" são corretas e comuns —
 * e o expediente, que é diário, não tem o que dizer sobre elas. Sem esta
 * exclusão o guard descartava respostas boas: na varredura de produção, 6 dos
 * 24 bloqueios eram exatamente isto.
 */
const FATIA_DO_DIA =
  /\b(?:de\s+manh[ãa]|pela\s+manh[ãa]|à?\s*tarde|à?\s*noite|nesse\s+hor[áa]rio|neste\s+hor[áa]rio|ap[óo]s\s+as?\s+\d|antes\s+das?\s+\d|\d{1,2}\s*[:h]\s*\d{2}|\bàs?\s+\d{1,2}\b)/;

export interface ClosedAgendaClaimInput {
  /** Texto que o agente vai enviar. */
  reply: string;
  /** Última mensagem do lead — usada só quando a própria frase do agente não
   *  nomeia o dia. */
  lastUserMsg: string;
  /** Horários em mãos (lead_data.offered_slots). */
  offeredSlots: { iso?: string | null; date_label?: string | null; time_label?: string | null }[];
  /** Dias ativos do expediente ("seg","ter",…), de activeWeekdayKeys().
   *  Vazio = expediente não configurado. */
  diasAtivos: string[];
}

export type ClosedAgendaMotivo =
  /** A agenda tem vaga no dia — a afirmação é demonstravelmente falsa. */
  | "tem_vaga_no_dia"
  /** O expediente diz que a clínica ABRE nesse dia. */
  | "expediente_diz_que_abre"
  /** Sem expediente configurado não há como afirmar fechamento. */
  | "expediente_desconhecido";

export interface ClosedAgendaClaimResult {
  motivo: ClosedAgendaMotivo;
  /** Dia (YYYY-MM-DD BRT) sobre o qual a afirmação foi feita. */
  diaIso: string;
}

/**
 * Devolve o motivo do bloqueio, ou null se a afirmação pode passar.
 *
 * Avalia FRASE A FRASE, e o dia sai da própria frase que faz a afirmação — não
 * da mensagem do lead. Caso real que mostra a diferença: "se você prefere o dia
 * 24/08 (que é um domingo), infelizmente a gente não atende no domingo" — o
 * lead tinha perguntado de SEXTA, e resolver pelo pedido dele fazia o guard
 * bloquear uma frase correta sobre DOMINGO. A mensagem do lead só entra como
 * segunda opção, quando a frase do agente não nomeia dia nenhum.
 */
export function unfoundedClosedAgendaClaim(
  input: ClosedAgendaClaimInput,
): ClosedAgendaClaimResult | null {
  const diaDoLead = requestedDateFromText(input.lastUserMsg ?? "");
  const ativos = new Set((input.diasAtivos ?? []).map(canonizaDia));

  for (const f of frases((input.reply ?? "").toLowerCase())) {
    if (!MARCADOR_DE_DIA.test(f)) continue;
    const afirmaFechado = afirmaFechamento(f);
    const afirmaSemVaga = afirmaFaltaDeVaga(f);
    if (!afirmaFechado && !afirmaSemVaga) continue;
    // Turno/horário: o expediente é diário e não fala sobre fatias do dia.
    if (FATIA_DO_DIA.test(f)) continue;

    // A oração cita um dia que a clínica realmente NÃO abre → a afirmação se
    // sustenta, não importa que outros dias apareçam junto. Sem isto, "a gente
    // não atende aos sábados, o atendimento é de segunda a sexta" resolvia o dia
    // como SEGUNDA — tirado da descrição do expediente, não da negativa — e o
    // guard descartava uma resposta correta. Idem "hoje é domingo, então não
    // temos atendimento".
    if (afirmaFechado && ativos.size > 0 && citaDiaFechado(f, ativos)) continue;

    const diaIso = requestedDateFromText(singularizaDias(f)) ?? diaDoLead;
    if (!diaIso) continue;

    // A agenda é a fonte de verdade sobre disponibilidade real. Se ela já
    // devolveu vaga nesse dia, nenhuma das duas afirmações se sustenta — é a
    // mesma invariante do slot-offer-fallback ("não atendo nesse dia, mas tenho
    // vaga nesse dia" na mesma frase).
    if ((input.offeredSlots ?? []).some((s) => (s.iso ?? "").slice(0, 10) === diaIso)) {
      return { motivo: "tem_vaga_no_dia", diaIso };
    }

    // Daqui pra baixo só o fechamento é verificável. "Não tenho vaga" sem
    // contradição na agenda fica livre de propósito: é uma afirmação legítima e
    // frequente, e não existe fonte que a desminta aqui. Tentei usar
    // `tools_called` como prova e não funciona — o agente também sabe da agenda
    // pelos horários do turno anterior, e a varredura de produção acusou 8
    // bloqueios indevidos por isso.
    if (!afirmaFechado) continue;

    // Expediente é a ÚNICA fonte para "a clínica não abre". Agenda vazia num dia
    // útil pode ser agenda cheia, feriado, ou busca ancorada no dia errado —
    // nada disso autoriza dizer que a clínica não funciona.
    if (ativos.size === 0) return { motivo: "expediente_desconhecido", diaIso };
    const chave = chaveDoDiaBrt(diaIso);
    if (chave && ativos.has(canonizaDia(chave))) {
      return { motivo: "expediente_diz_que_abre", diaIso };
    }
    // Expediente confirma que o dia é fechado — a afirmação é verdadeira.
  }
  return null;
}

/** "quarta-feira, 12/08" a partir de YYYY-MM-DD. "" se inválido. */
export function rotuloDoDiaBrt(diaIso: string): string {
  const chave = chaveDoDiaBrt(diaIso);
  const d = new Date(`${diaIso}T12:00:00-03:00`);
  if (!chave || isNaN(d.getTime())) return "";
  const ddmm = new Intl.DateTimeFormat("pt-BR", {
    timeZone: "America/Sao_Paulo",
    day: "2-digit",
    month: "2-digit",
  }).format(d);
  return `${NOME_DIA[chave]}, ${ddmm}`;
}

/**
 * Resposta que substitui a afirmação sem prova.
 *
 * NÃO afirma que o dia está aberto (também não sabemos) e NÃO promete "vou
 * verificar e te aviso" — promessa vazia é o padrão que já prendeu leads em loop
 * por dias (ver o branch do qualifier em false-booking-claim). Mostra o que
 * existe em mãos e devolve a decisão ao lead, o que faz o próximo turn buscar o
 * dia certo.
 */
export function closedAgendaSafeReply(
  diaIso: string,
  offeredSlots: { date_label?: string | null; time_label?: string | null }[],
): string {
  const opcoes = (offeredSlots ?? [])
    .slice(0, 2)
    .map((s) => `${s.date_label ?? ""} às ${s.time_label ?? ""}`.trim())
    .filter((s) => s !== "às")
    .join(" ou ");
  const rotulo = rotuloDoDiaBrt(diaIso);
  const dia = rotulo || "esse dia";

  if (opcoes) {
    return `Deixa eu te mostrar o que tenho em mãos: ${opcoes}. Se você prefere ${dia}, me confirma que eu busco os horários desse dia. 😊`;
  }
  return `Sobre ${dia}: me confirma que eu busco os horários desse dia pra você. 😊`;
}
