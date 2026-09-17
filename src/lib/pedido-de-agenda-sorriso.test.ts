// Pedidos de dia/turno/hora que a IA da Sorriso Saúde (set/2026) não entendia
// e por isso reofertava justamente o que o lead tinha recusado.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  leadAnsweredFieldAfterSlotRestated,
  leadTimeContradictsSlot,
  requestedDateFromText,
  scrubInventedTimeOffers,
  tryAutoSelectOfferedSlot,
  requestedHoraFromText,
  requestedPeriodoFromText,
} from "./booking-template";

describe("pedido de semana seguinte", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // quinta-feira, 10/09/2026 18:00 em São Paulo
    vi.setSystemTime(new Date("2026-09-10T21:00:00Z"));
  });
  afterEach(() => vi.useRealTimers());

  it('"Na outra semana entao" → segunda da semana seguinte', () => {
    expect(requestedDateFromText("Na outra semana entao")).toBe("2026-09-14");
  });

  it("negação da semana atual + pedido da seguinte (Jona)", () => {
    expect(
      requestedDateFromText("Essa  semana  não  dá  mais  vou  deixar  pra  semana  que  vem"),
    ).toBe("2026-09-14");
  });

  it("semana que vem NEGADA não vira pedido", () => {
    expect(requestedDateFromText("semana que vem não posso")).toBeNull();
    expect(requestedDateFromText("não consigo na semana que vem")).toBeNull();
  });

  it("dia da semana citado continua mandando", () => {
    expect(requestedDateFromText("sexta não dá, só na quarta da semana que vem")).not.toBe(
      "2026-09-14",
    );
  });

  it("negação sem referência adiante segue descartada", () => {
    expect(requestedDateFromText("Amanhã eu tenho médico não dá")).toBeNull();
  });
});

describe("hora e turno", () => {
  it('"5 e meia da tarde" é 17h (Josias)', () => {
    expect(requestedHoraFromText("Uma 5 e meia da tarde seria um horário ideal")).toBe(17);
    expect(requestedPeriodoFromText("Uma 5 e meia da tarde seria um horário ideal")).toBe("tarde");
  });

  it('"a partir das 15 horas" é 15h (Adriana)', () => {
    expect(requestedHoraFromText("Só a partir das 15 horas que dar para mim")).toBe(15);
  });

  it('"atarde" colado é tarde', () => {
    expect(requestedPeriodoFromText("Quinta feira atarde tem")).toBe("tarde");
  });
});

describe("hora digitada pelo lead x horário escolhido (Kelly)", () => {
  const SLOT_0830 = "2026-09-24T08:30:00-03:00";
  const SLOT_1430 = "2026-09-25T14:30:00-03:00";

  it('"As 14:30" contradiz 08:30', () => {
    expect(leadTimeContradictsSlot(["As 14:30"], SLOT_0830)).toBe(true);
  });

  it('"As 14:30" casa com 14:30', () => {
    expect(leadTimeContradictsSlot(["As 14:30"], SLOT_1430)).toBe(false);
  });

  it('"5 da tarde" casa com 17:00', () => {
    expect(leadTimeContradictsSlot(["pode ser 5 da tarde"], "2026-09-25T17:00:00-03:00")).toBe(
      false,
    );
  });

  it("sem hora digitada não há contradição", () => {
    expect(leadTimeContradictsSlot(["o primeiro"], SLOT_0830)).toBe(false);
    expect(leadTimeContradictsSlot(["Pode ser quinta-feira"], SLOT_0830)).toBe(false);
  });

  it("uma das horas citadas bate", () => {
    expect(leadTimeContradictsSlot(["13:30 14h"], "2026-09-25T14:00:00-03:00")).toBe(false);
  });

  it("tryAutoSelectOfferedSlot não escolhe 08:30 para quem escreveu 14:30", () => {
    const leadData = {
      offered_slots: [{ iso: SLOT_0830, date_label: "quinta-feira, 24/09", time_label: "08:30" }],
    };
    const history = [
      {
        role: "assistant" as const,
        content:
          "Verifiquei aqui e consigo abrir um encaixe para você na parte da tarde de quinta-feira, 24/09.\n\nTenho 14:00 ou 14:30. Qual fica melhor para você?",
      },
      { role: "user" as const, content: "As 14:30" },
    ];
    expect(
      tryAutoSelectOfferedSlot("SLOT_OFFER", leadData, history).selected_slot_iso,
    ).toBeUndefined();
  });
});

describe("oferta inventada em lista (Kelly)", () => {
  const reply =
    "Verifiquei aqui e consigo abrir um encaixe para você na parte da tarde de quinta-feira, 24/09.\n\nTenho 14:00 ou 14:30. Qual fica melhor para você?";

  it("hora real de OUTRO dia não passa como se fosse do dia anunciado", () => {
    const offered = [
      { date_label: "quinta-feira, 24/09", time_label: "08:30" },
      { date_label: "sexta-feira, 25/09", time_label: "14:00" },
      { date_label: "sexta-feira, 25/09", time_label: "14:30" },
    ];
    const r = scrubInventedTimeOffers(reply, offered);
    expect(r.scrubbed).toBe(true);
    expect(r.reply).not.toMatch(/Tenho 14:00 ou 14:30/);
  });

  it("hora que não existe em dia nenhum é removida", () => {
    const r = scrubInventedTimeOffers(reply, [
      { date_label: "quinta-feira, 24/09", time_label: "08:30" },
    ]);
    expect(r.scrubbed).toBe(true);
  });

  it("oferta real em lista passa intacta", () => {
    const ok = "Na sexta-feira, 25/09 à tarde: tenho 14:00 ou 14:30. Qual fica melhor?";
    const offered = [
      { date_label: "sexta-feira, 25/09", time_label: "14:00" },
      { date_label: "sexta-feira, 25/09", time_label: "14:30" },
    ];
    expect(scrubInventedTimeOffers(ok, offered)).toEqual({ reply: ok, scrubbed: false });
  });
});

describe("nome enviado depois de o agente repetir o horário confirma o agendamento", () => {
  const u = (content: string) => ({ role: "user" as const, content });
  const a = (content: string) => ({ role: "assistant" as const, content });

  it("Carla: escolheu quarta, agente repetiu 09:30 e pediu sobrenome, ela mandou o nome", () => {
    const history = [
      a(
        "Tenho dois horários pela manhã: quarta-feira, 09/09 às 09:30 ou quinta-feira, 10/09 às 08:30. Qual fica melhor para você?",
      ),
      u("Manda o endereço"),
      u("Na quarta feira pra mim tá bom"),
      a(
        "Quase lá! Pra fechar seu horário de quarta-feira, 09/09 às 09:30, Carla, me confirma seu sobrenome? Preciso do nome completo pro cadastro.",
      ),
      u("Carla Azevedo Alves Ribeiro"),
    ];
    expect(leadAnsweredFieldAfterSlotRestated(history, "2026-09-09T09:30:00-03:00")).toBe(true);
  });

  it("Osvaldina: 'Então fica segunda-feira, 14/09 às 09:30… me envia seu nome completo?'", () => {
    const history = [
      u("É, tem que estourar de 9 e meia, se tiver dá."),
      a(
        "Perfeito! Então fica segunda-feira, 14/09 às 09:30 para você. 😊 Para finalizar seu agendamento, me envia por favor seu nome completo?",
      ),
      u("Osvaldina de oliveira cravo"),
    ];
    expect(leadAnsweredFieldAfterSlotRestated(history, "2026-09-14T09:30:00-03:00")).toBe(true);
  });

  it("Kelly: o agente repetiu um horário ERRADO — o nome não confirma nada", () => {
    const history = [
      a("Tenho 14:00 ou 14:30. Qual fica melhor para você?"),
      u("As 14:30"),
      a(
        "Quase lá! Pra fechar seu horário de quinta-feira, 24/09 às 08:30, Kelly, me confirma seu sobrenome? Preciso do nome completo pro cadastro.",
      ),
      u("Kelly Cristina Vieira"),
    ];
    expect(leadAnsweredFieldAfterSlotRestated(history, "2026-09-24T08:30:00-03:00")).toBe(false);
  });

  it("lead responde com recusa", () => {
    const history = [
      a("Pra fechar seu horário de quarta-feira, 09/09 às 09:30, me envia seu nome completo?"),
      u("Nesse dia não posso mais"),
    ];
    expect(leadAnsweredFieldAfterSlotRestated(history, "2026-09-09T09:30:00-03:00")).toBe(false);
  });

  it("agente não repetiu o horário", () => {
    const history = [
      a("Para finalizar, me envia por favor seu nome completo?"),
      u("Carla Ribeiro"),
    ];
    expect(leadAnsweredFieldAfterSlotRestated(history, "2026-09-09T09:30:00-03:00")).toBe(false);
  });
});
