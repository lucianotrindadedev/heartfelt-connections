import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { unfoundedClosedAgendaClaim } from "./agents/closed-agenda-claim";
import {
  filterSlotsToWeekday,
  mentionsUnavailability,
  requestedDateFromText,
  requestedWeekdayFromText,
  requestedWeekdaysFromText,
  shouldWidenSlotWindow,
} from "./booking-template";

// Caso real: Odonto Carioca Campo Grande, Sonia (21) 97681-1078, 09/11/2026.
//
// Agendada para segunda 09/11 14:15, ela escreveu às 09:33:
//   "Vou ter que remarcar aconteceu um imprevisto e não vai dar pra ir hoje vê
//    por favor se tem vaga pra quinta feira ou sexta-feira?"
//
// requestedDateFromText devolvia HOJE (o "hoje" da desculpa vencia a quinta do
// pedido), a busca ancorou em segunda à tarde e o modelo explicou a ausência
// da quinta com "a agenda de quinta e sexta ainda não abriu". A recepção marcou
// quinta 12/11 15:45 na mão.

const SEG_A_SEX = ["seg", "ter", "qua", "qui", "sex"];
const MSG_REAL =
  "Bom dia! Vou ter que remarcar aconteceu um imprevisto e não vai dar pra ir hoje vê por favor se tem vaga pra quinta feira ou sexta-feira?";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-09T09:33:23-03:00")); // segunda-feira
});
afterEach(() => {
  vi.useRealTimers();
});

describe("requestedDateFromText — recusa de hoje/amanhã com outro dia pedido", () => {
  it("mensagem real: vale a quinta, não o hoje recusado", () => {
    expect(requestedDateFromText(MSG_REAL)).toBe("2026-11-12");
  });

  it("variações da mesma forma", () => {
    expect(requestedDateFromText("hoje não consigo, pode ser quinta?")).toBe("2026-11-12");
    expect(requestedDateFromText("amanhã não vai dar, tem na sexta?")).toBe("2026-11-13");
    expect(requestedDateFromText("não posso amanhã, consegue dia 18?")).toBe("2026-11-18");
    expect(requestedDateFromText("não vou conseguir ir hoje, quarta à tarde tem?")).toBe(
      "2026-11-11",
    );
  });

  it("o outro dia também recusado → sem pedido", () => {
    expect(requestedDateFromText("hoje não dá, quinta também não")).toBeNull();
    expect(requestedDateFromText("não consigo hoje nem quinta")).toBeNull();
  });

  it("recusa de hoje sem outro dia → sem pedido (não ancora no dia recusado)", () => {
    expect(requestedDateFromText("não vai dar pra ir hoje")).toBeNull();
    expect(requestedDateFromText("amanhã não vai dar")).toBeNull();
  });

  it("o que já funcionava continua igual", () => {
    expect(requestedDateFromText("pode ser hoje?")).toBe("2026-11-09");
    expect(requestedDateFromText("amanhã de manhã")).toBe("2026-11-10");
    expect(requestedDateFromText("quinta feira")).toBe("2026-11-12");
    expect(requestedDateFromText("quinta não dá")).toBeNull();
  });
});

describe("mentionsUnavailability — 'não vai dar'", () => {
  it("reconhece a forma com 'vai'", () => {
    expect(mentionsUnavailability("não vai dar pra ir hoje")).toBe(true);
    expect(mentionsUnavailability("nao vai rolar amanhã")).toBe(true);
    expect(mentionsUnavailability("não vai ser possível")).toBe(true);
  });

  it("não confunde com pedido", () => {
    expect(mentionsUnavailability("vai dar sim, pode marcar")).toBe(false);
    expect(mentionsUnavailability("pode ser quinta")).toBe(false);
  });
});

describe("unfoundedClosedAgendaClaim — 'a agenda ainda não abriu'", () => {
  const SLOTS_HOJE = [
    { iso: "2026-11-09T13:15:00-03:00", date_label: "segunda-feira, 09/11", time_label: "13:15" },
    { iso: "2026-11-09T14:30:00-03:00", date_label: "segunda-feira, 09/11", time_label: "14:30" },
  ];

  it("resposta real é bloqueada (quinta é dia útil)", () => {
    const r = unfoundedClosedAgendaClaim({
      reply:
        "Fico feliz em ajudar! Infelizmente a agenda de quinta e sexta ainda não abriu, mas consegui alguns horários disponíveis ainda hoje à tarde, que são bem pertinho. Você prefere um desses ou prefere que eu veja quando abre quinta e sexta?",
      lastUserMsg: MSG_REAL,
      offeredSlots: SLOTS_HOJE,
      diasAtivos: SEG_A_SEX,
    });
    expect(r?.motivo).toBe("expediente_diz_que_abre");
    expect(r?.diaIso).toBe("2026-11-12");
  });

  it("variações: não foi liberada / não está aberta", () => {
    for (const reply of [
      "A agenda de sexta não foi liberada ainda.",
      "A agenda de quinta ainda não está aberta.",
      "A agenda da quinta ainda não liberou.",
    ]) {
      expect(
        unfoundedClosedAgendaClaim({
          reply,
          lastUserMsg: "",
          offeredSlots: [],
          diasAtivos: SEG_A_SEX,
        }),
      ).not.toBeNull();
    }
  });

  it("dia que a clínica realmente não abre continua livre", () => {
    expect(
      unfoundedClosedAgendaClaim({
        reply: "A agenda de sábado não abre, a gente atende de segunda a sexta.",
        lastUserMsg: "tem sábado?",
        offeredSlots: [],
        diasAtivos: SEG_A_SEX,
      }),
    ).toBeNull();
  });
});

// "quinta ou sexta" são DOIS dias aceitos. A restrição guardava só a quinta: sem
// vaga nela, a busca ampliava atrás da PRÓXIMA quinta e a sexta ficava de fora.
describe("requestedWeekdaysFromText — vários dias aceitos", () => {
  it("mensagem real: quinta e sexta", () => {
    expect(requestedWeekdaysFromText(MSG_REAL)).toEqual(["qui", "sex"]);
  });

  it("formas comuns", () => {
    expect(requestedWeekdaysFromText("pode ser terça ou quarta")).toEqual(["ter", "qua"]);
    expect(requestedWeekdaysFromText("segunda, quarta ou sexta")).toEqual(["seg", "qua", "sex"]);
    expect(requestedWeekdaysFromText("quinta")).toEqual(["qui"]);
  });

  it("faixa, ordinal e dia recusado não entram", () => {
    expect(requestedWeekdaysFromText("atendem de segunda a sexta?")).toEqual([]);
    expect(requestedWeekdaysFromText("quero uma segunda opinião, pode ser quinta")).toEqual([
      "qui",
    ]);
    expect(requestedWeekdaysFromText("pode ser quinta, sexta não")).toEqual(["qui"]);
    expect(requestedWeekdaysFromText("quinta, nem sexta")).toEqual(["qui"]);
  });

  it("requestedWeekdayFromText continua devolvendo o primeiro", () => {
    expect(requestedWeekdayFromText(MSG_REAL)).toBe("qui");
  });
});

describe("restrição com dois dias — sem vaga na quinta, oferta a sexta", () => {
  // Janela ampla sem nenhuma vaga na quinta 12/11.
  const SLOTS = [
    { start: "2026-11-10T14:00:00-03:00" }, // terça
    { start: "2026-11-13T14:00:00-03:00" }, // sexta 13 ← a que a lead aceitou
    { start: "2026-11-13T15:45:00-03:00" },
    { start: "2026-11-16T14:00:00-03:00" }, // segunda
    { start: "2026-11-19T14:00:00-03:00" }, // quinta seguinte
  ];

  it("filtra pelos dois dias e a sexta vem antes da quinta seguinte", () => {
    const r = filterSlotsToWeekday(SLOTS, ["qui", "sex"], (s) => s.start);
    expect(r.map((s) => s.start.slice(0, 10))).toEqual(["2026-11-13", "2026-11-13", "2026-11-19"]);
  });

  it("só a quinta (comportamento antigo) pularia a sexta", () => {
    const r = filterSlotsToWeekday(SLOTS, "qui", (s) => s.start);
    expect(r.map((s) => s.start.slice(0, 10))).toEqual(["2026-11-19"]);
  });

  it("janela próxima com sexta já basta — não amplia", () => {
    const near = SLOTS.slice(0, 3);
    expect(
      shouldWidenSlotWindow({
        totalSlots: near.length,
        explicitWindowDays: null,
        requestedWeekday: ["qui", "sex"],
        slotsOnRequestedWeekday: filterSlotsToWeekday(near, ["qui", "sex"], (s) => s.start).length,
      }),
    ).toBe(false);
  });

  it("lista vazia de dias não restringe nem amplia", () => {
    expect(filterSlotsToWeekday(SLOTS, [], (s) => s.start)).toHaveLength(SLOTS.length);
    expect(
      shouldWidenSlotWindow({
        totalSlots: 3,
        explicitWindowDays: null,
        requestedWeekday: [],
        slotsOnRequestedWeekday: 0,
      }),
    ).toBe(false);
  });
});
