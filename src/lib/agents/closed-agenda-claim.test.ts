import { describe, expect, it } from "vitest";

import {
  claimsClinicClosed,
  claimsNoAvailability,
  closedAgendaSafeReply,
  unfoundedClosedAgendaClaim,
} from "./closed-agenda-claim";

const SEG_A_SEX = ["segunda", "terca", "quarta", "quinta", "sexta"];
const BRT = "America/Sao_Paulo";
const DAY = 86_400_000;

// ── Datas DINÂMICAS ────────────────────────────────────────────────────────
// Nada de data fixa: já quebramos a main três vezes com teste que passa no dia
// em que foi escrito. Tudo deriva de Date.now().
function partes(offsetDias: number) {
  const d = new Date(Date.now() + offsetDias * DAY);
  const iso = new Intl.DateTimeFormat("en-CA", { timeZone: BRT }).format(d);
  const nome = new Intl.DateTimeFormat("pt-BR", { timeZone: BRT, weekday: "long" }).format(d);
  const ddmm = new Intl.DateTimeFormat("pt-BR", {
    timeZone: BRT,
    day: "2-digit",
    month: "2-digit",
  }).format(d);
  return { iso, nome, ddmm, dia: Number(iso.slice(8)), mes: Number(iso.slice(5, 7)) };
}
/** Próximo dia ÚTIL (a clínica do caso atende Seg–Sex). */
function proximoDiaUtil() {
  for (let i = 1; i <= 7; i++) {
    const p = partes(i);
    if (!/domingo|sábado/.test(p.nome)) return p;
  }
  throw new Error("sem dia útil");
}
/** Próximo dia em que a clínica NÃO abre. */
function proximoDiaFechado() {
  for (let i = 1; i <= 7; i++) {
    const p = partes(i);
    if (/domingo|sábado/.test(p.nome)) return p;
  }
  throw new Error("sem fim de semana");
}
const MESES = [
  "janeiro", "fevereiro", "março", "abril", "maio", "junho",
  "julho", "agosto", "setembro", "outubro", "novembro", "dezembro",
];

describe("claimsClinicClosed — afirmação sobre EXPEDIENTE", () => {
  it("reconhece a frase real do caso 21 99826-0816", () => {
    expect(
      claimsClinicClosed(
        "Infelizmente a agenda de amanhã já está fechada para novos agendamentos.",
      ),
    ).toBe(true);
  });

  it("reconhece as outras formas comuns", () => {
    for (const t of [
      "A gente não atende nesse dia, viu?",
      "Não atendemos aos sábados.",
      "A clínica não abre no domingo.",
      "Nesse dia estamos fechados.",
      "Não funcionamos amanhã, é feriado.",
      "Não temos atendimento nesse dia.",
      "A agenda de quinta está fechada.",
    ]) {
      expect(claimsClinicClosed(t), t).toBe(true);
    }
  });

  it("'fechado' como gíria de confirmação NÃO dispara", () => {
    // O agente usa "Fechado!" o tempo todo para confirmar. Bloquear isso
    // trocaria uma confirmação legítima pela resposta do guard.
    for (const t of [
      "Fechado! Te espero quinta-feira às 14h.",
      "Fechado, seu agendamento está confirmado para amanhã às 09:00.",
      "Fechado então! Qualquer coisa é só me chamar.",
      "Combinado, fechado para quinta-feira, 14/08 às 10:00!",
    ]) {
      expect(claimsClinicClosed(t), t).toBe(false);
    }
  });

  it("negativa que não é sobre dia NÃO dispara", () => {
    // Sem esta guarda o agente perderia respostas corretas sobre convênio,
    // canal de atendimento e procedimento.
    for (const t of [
      "Não atendemos Unimed, só particular.",
      "Não atendemos por telefone, só por aqui mesmo.",
      "Infelizmente não trabalhamos com esse convênio.",
      "A gente não faz esse procedimento aqui.",
    ]) {
      expect(claimsClinicClosed(t), t).toBe(false);
    }
  });

  it("negativa sobre um PROFISSIONAL não é a clínica fechada", () => {
    // Real, e verdadeiro: quem não atende na quarta é uma dentista específica.
    // A clínica abre. Bloquear isso descartaria uma resposta correta.
    expect(
      claimsClinicClosed(
        "Vi aqui agora, na quarta só temos atendimento pelo plano, a dentista de manutenção não atende aqui na quarta-feira",
      ),
    ).toBe(false);
    expect(claimsClinicClosed("O Dr. Paulo não atende na sexta, mas a Dra. Ana sim.")).toBe(false);
  });

  it("o marcador de dia precisa estar na MESMA frase", () => {
    // "quinta" numa frase, a negativa em outra: não são a mesma afirmação.
    expect(
      claimsClinicClosed("Consigo te encaixar quinta-feira. Não atendemos convênio, tá?"),
    ).toBe(false);
  });
});

describe("claimsNoAvailability — afirmação sobre a AGENDA", () => {
  it("reconhece as formas comuns", () => {
    for (const t of [
      "Não tenho horário disponível nesse dia.",
      "Não temos mais vagas para amanhã.",
      "A agenda de quinta está lotada.",
      "Estamos sem horários no dia 12/08.",
      "Os horários de amanhã já esgotaram.",
      "Não consegui nenhum encaixe nesse dia.",
    ]) {
      expect(claimsNoAvailability(t), t).toBe(true);
    }
  });

  it("oferta normal não dispara", () => {
    for (const t of [
      "Tenho quinta-feira às 12:00 ou 12:15. Qual fica melhor?",
      "Consigo te encaixar amanhã às 14h!",
      "Amanhã tenho vaga de manhã e de tarde.",
    ]) {
      expect(claimsNoAvailability(t), t).toBe(false);
    }
  });

  it("um HORÁRIO específico que caiu não é o dia sem vaga", () => {
    // Real: a resposta explica por que o slot escolhido falhou e já oferece
    // alternativas. O adjetivo solto ("indisponível", "lotado") fala do
    // horário, não do dia — trocar isso pela resposta do guard seria pior.
    expect(
      claimsNoAvailability(
        "Ihh, esse horário acabou de ficar indisponível 😕 Mas consigo te encaixar em terça-feira, 11/08 às 15:15",
      ),
    ).toBe(false);
  });
});

// ── O caso real ────────────────────────────────────────────────────────────
describe("unfoundedClosedAgendaClaim — caso Odonto Carioca (21 99826-0816)", () => {
  const util = proximoDiaUtil();
  // offered_slots caem em OUTRO dia — foi exatamente isso que o modelo
  // racionalizou como "o dia pedido está fechado".
  const outroDia = partes(6);
  const SLOTS = [
    {
      iso: `${outroDia.iso}T12:00:00-03:00`,
      date_label: `${outroDia.nome}, ${outroDia.ddmm}`,
      time_label: "12:00",
    },
    {
      iso: `${outroDia.iso}T12:15:00-03:00`,
      date_label: `${outroDia.nome}, ${outroDia.ddmm}`,
      time_label: "12:15",
    },
  ];

  it("afirma fechamento de um dia ÚTIL → bloqueia", () => {
    const r = unfoundedClosedAgendaClaim({
      reply: `Oi! Verdade, o evento Resgatando Sorrisos é dia ${util.dia}. Infelizmente a agenda de ${util.nome} já está fechada para novos agendamentos. Mas consegui dois horários bem próximos para você.`,
      lastUserMsg: `Bom dia mas no Instagram esta falando sobre a avaliação gratuita no dia ${util.dia} de ${MESES[util.mes - 1]}`,
      offeredSlots: SLOTS,
      diasAtivos: SEG_A_SEX,
    });
    expect(r?.motivo).toBe("expediente_diz_que_abre");
    expect(r?.diaIso).toBe(util.iso);
  });

  it("agenda vazia num dia útil NÃO autoriza afirmar fechamento", () => {
    // Agenda vazia num dia útil pode ser agenda cheia, feriado, ou busca
    // ancorada no dia errado — nada disso é "a clínica não abre".
    const r = unfoundedClosedAgendaClaim({
      reply: `A agenda de ${util.nome} está fechada.`,
      lastUserMsg: `posso ir dia ${util.dia}/${util.mes}?`,
      offeredSlots: [],
      diasAtivos: SEG_A_SEX,
    });
    expect(r?.motivo).toBe("expediente_diz_que_abre");
  });

  it("sem expediente configurado, não há como afirmar fechamento", () => {
    const r = unfoundedClosedAgendaClaim({
      reply: `Não atendemos ${util.nome}.`,
      lastUserMsg: `dá pra ir ${util.nome}?`,
      offeredSlots: [],
      diasAtivos: [],
    });
    expect(r?.motivo).toBe("expediente_desconhecido");
  });

  it("INVARIANTE: com vaga na agenda naquele dia, a afirmação é falsa", () => {
    const comVaga = [
      {
        iso: `${util.iso}T12:00:00-03:00`,
        date_label: `${util.nome}, ${util.ddmm}`,
        time_label: "12:00",
      },
    ];
    const r = unfoundedClosedAgendaClaim({
      reply: `A gente não atende ${util.nome}, viu?`,
      lastUserMsg: `consigo na ${util.nome}?`,
      offeredSlots: comVaga,
      diasAtivos: SEG_A_SEX,
    });
    expect(r?.motivo).toBe("tem_vaga_no_dia");
  });
});

describe("unfoundedClosedAgendaClaim — o que NÃO pode ser bloqueado", () => {
  const fechado = proximoDiaFechado();
  const util = proximoDiaUtil();

  it("dia REALMENTE fechado no expediente → afirmação passa", () => {
    const r = unfoundedClosedAgendaClaim({
      reply: `Ah, sobre ${fechado.nome}: a gente não atende nesse dia, viu? 😊`,
      lastUserMsg: `posso ir no ${fechado.nome}?`,
      offeredSlots: [],
      diasAtivos: SEG_A_SEX,
    });
    expect(r).toBeNull();
  });

  it("'não tenho vaga', sem contradizer a agenda, passa", () => {
    // Decisão explícita: falta de vaga é afirmação legítima e frequente, e não
    // existe fonte aqui que a desminta. Tentei usar tools_called como prova de
    // que o agente consultou a agenda — na varredura de produção isso gerou 8
    // bloqueios indevidos, porque o agente também sabe da agenda pelos horários
    // do turno anterior. Só o fechamento tem fonte de verdade (o expediente).
    const r = unfoundedClosedAgendaClaim({
      reply: `Não tenho horário disponível ${util.nome}, mas tenho na semana que vem.`,
      lastUserMsg: `consigo na ${util.nome}?`,
      offeredSlots: [],
      diasAtivos: SEG_A_SEX,
    });
    expect(r).toBeNull();
  });

  it("afirmação sobre TURNO/HORÁRIO não é sobre o dia", () => {
    // Reais, corretas e frequentes. O expediente é diário e não tem o que dizer
    // sobre uma fatia do dia — e a agenda ter vaga à tarde não desmente uma
    // negativa sobre a manhã.
    const comVagaNoDia = [
      {
        iso: `${util.iso}T15:00:00-03:00`,
        date_label: `${util.nome}, ${util.ddmm}`,
        time_label: "15:00",
      },
    ];
    for (const reply of [
      `No ${util.nome} de manhã não temos vaga, mas tenho três horários à tarde.`,
      `${util.nome}, ${util.ddmm} não tem vaga às 14:30.`,
      `${util.nome} não tem vaga disponível nesse horário.`,
      `Infelizmente ${util.nome} à noite não temos disponibilidade após as 16h.`,
    ]) {
      const r = unfoundedClosedAgendaClaim({
        reply,
        lastUserMsg: `consigo na ${util.nome}?`,
        offeredSlots: comVagaNoDia,
        diasAtivos: SEG_A_SEX,
      });
      expect(r, reply).toBeNull();
    }
  });

  it("o dia sai da FRASE do agente, não do pedido do lead", () => {
    // Real: o lead perguntou sobre sexta; a frase fala de domingo. Resolver pelo
    // pedido do lead fazia o guard bloquear uma afirmação correta.
    const r = unfoundedClosedAgendaClaim({
      reply: `Deixa eu esclarecer: ${util.nome}, ${util.ddmm} é essa semana. Mas se você prefere o dia ${fechado.ddmm} (que é um ${fechado.nome}), infelizmente a gente não atende no ${fechado.nome}.`,
      lastUserMsg: `é ${util.nome} agora?`,
      offeredSlots: [],
      diasAtivos: SEG_A_SEX,
    });
    expect(r).toBeNull();
  });

  it("negar um dia e descrever o expediente na mesma frase", () => {
    // Real: "a gente não atende aos sábados, o atendimento é de segunda a
    // sexta". O dia resolvia como SEGUNDA — tirado da descrição do expediente,
    // não da negativa — e o guard descartava uma resposta correta.
    const r = unfoundedClosedAgendaClaim({
      reply: `Que bom que você já está se organizando! 😊 Só um detalhe: a gente não atende aos ${fechado.nome}s, o atendimento é de segunda a sexta.`,
      lastUserMsg: `dá pra ir ${fechado.nome}?`,
      offeredSlots: [],
      diasAtivos: SEG_A_SEX,
    });
    expect(r).toBeNull();
  });

  it("a oração adversativa não contamina o dia da negativa", () => {
    // "nega um dia MAS oferece outro" é a resposta mais comum do agente. Sem
    // cortar no "mas", o dia da OFERTA era usado para checar a negativa e o
    // guard acusava contradição onde não havia.
    const amanha = partes(1);
    const r = unfoundedClosedAgendaClaim({
      reply: `Não temos vaga hoje, mas tenho ${amanha.nome}, ${amanha.ddmm} às 10:00.`,
      lastUserMsg: "consigo hoje?",
      offeredSlots: [
        {
          iso: `${amanha.iso}T10:00:00-03:00`,
          date_label: `${amanha.nome}, ${amanha.ddmm}`,
          time_label: "10:00",
        },
      ],
      diasAtivos: SEG_A_SEX,
    });
    expect(r).toBeNull();
  });

  it("nenhuma referência a dia → o guard não avalia", () => {
    const r = unfoundedClosedAgendaClaim({
      reply: "Infelizmente a agenda está fechada para novos agendamentos.",
      lastUserMsg: "oi, tudo bem?",
      offeredSlots: [],
      diasAtivos: SEG_A_SEX,
    });
    expect(r).toBeNull();
  });

  it("resposta normal de oferta nunca é bloqueada", () => {
    const r = unfoundedClosedAgendaClaim({
      reply: `Consigo te encaixar ${util.nome} às 12:00 ou 12:15. Qual fica melhor? 😊`,
      lastUserMsg: `consigo na ${util.nome}?`,
      offeredSlots: [],
      diasAtivos: SEG_A_SEX,
    });
    expect(r).toBeNull();
  });
});

describe("closedAgendaSafeReply", () => {
  const util = proximoDiaUtil();

  it("não afirma fechamento nem promete verificar depois", () => {
    const r = closedAgendaSafeReply(util.iso, [
      { date_label: "quinta-feira, 13/08", time_label: "12:00" },
    ]);
    expect(r).not.toMatch(/fechad|n[ãa]o atend|lotad|sem hor[áa]rio/i);
    // "vou verificar e te aviso" é promessa vazia — o padrão que já prendeu
    // lead em loop por dias.
    expect(r).not.toMatch(/te aviso|te retorno|j[áa] te falo|volto j[áa]/i);
    expect(r).toContain("12:00");
  });

  it("nomeia o dia pedido para o lead poder confirmar", () => {
    const r = closedAgendaSafeReply(util.iso, []);
    expect(r).toContain(util.ddmm);
  });
});
