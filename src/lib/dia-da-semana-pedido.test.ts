import { describe, expect, it } from "vitest";

import {
  filterSlotsToWeekday,
  requestedWeekdayFromText,
  scrubInventedTimeOffers,
  shouldWidenSlotWindow,
  weekdayKeyOfIso,
} from "./booking-template";

// Caso real: Implanto Master Venda Nova, Wellington (31) 99726-9556, 12–14/09.
//
//   "Tem q ser no sábado"  → requestedDateFromText resolve 19/09 (sábado, certo)
//   janela = âncora + 4 dias = 19/09 → 23/09
//   agenda real nessa janela: 21/09 seg, 22/09 ter, 23/09 qua — nenhum sábado
//   próximo sábado COM VAGA: 26/09, três dias além do fim da janela
//
// A ampliação para 60 dias existia, mas estava desligada por DOIS motivos ao
// mesmo tempo: exigia `slots.length === 0` (e a busca voltou 28 vagas) e exigia
// `!anchor` (e havia âncora). O agente ofertou segunda e terça chamando-as de
// "sábado", entrou em loop de cinco turnos e a recepção marcou 26/09 na mão.

describe("requestedWeekdayFromText", () => {
  it("reconhece o dia da semana nas frases reais do lead", () => {
    expect(requestedWeekdayFromText("Tem q ser no sábado")).toBe("sab");
    expect(requestedWeekdayFromText("Sábado às 10:30")).toBe("sab");
    expect(requestedWeekdayFromText("Sábado da p mim")).toBe("sab");
    expect(requestedWeekdayFromText("pode ser quinta-feira?")).toBe("qui");
    expect(requestedWeekdayFromText("segunda-feira, 21/09")).toBe("seg");
  });

  it("não inventa dia quando o lead não citou nenhum", () => {
    expect(requestedWeekdayFromText("Náo posso dia de semana")).toBeNull();
    expect(requestedWeekdayFromText("10 30")).toBeNull();
    expect(requestedWeekdayFromText("dia 20/08")).toBeNull();
    expect(requestedWeekdayFromText("")).toBeNull();
    expect(requestedWeekdayFromText(null)).toBeNull();
  });
});

describe("weekdayKeyOfIso", () => {
  it("resolve em BRT, aceitando ISO completo ou só a data", () => {
    expect(weekdayKeyOfIso("2026-09-19")).toBe("sab");
    expect(weekdayKeyOfIso("2026-09-21T10:30:00-03:00")).toBe("seg");
    expect(weekdayKeyOfIso("2026-09-26")).toBe("sab");
    expect(weekdayKeyOfIso("")).toBeNull();
    expect(weekdayKeyOfIso("nao-e-data")).toBeNull();
  });
});

describe("filterSlotsToWeekday", () => {
  const slots = [
    { start: "2026-09-21T08:30:00-03:00" },
    { start: "2026-09-22T09:00:00-03:00" },
    { start: "2026-09-26T09:30:00-03:00" },
  ];

  it("mantém só o dia da semana pedido", () => {
    expect(filterSlotsToWeekday(slots, "sab", (s) => s.start)).toEqual([
      { start: "2026-09-26T09:30:00-03:00" },
    ]);
  });

  it("sem restrição, devolve tudo", () => {
    expect(filterSlotsToWeekday(slots, null, (s) => s.start)).toHaveLength(3);
  });
});

describe("shouldWidenSlotWindow", () => {
  it("o caso do Wellington: 28 vagas, nenhuma no sábado pedido → amplia", () => {
    expect(
      shouldWidenSlotWindow({
        totalSlots: 28,
        explicitWindowDays: null,
        requestedDay: "2026-09-19",
        slotsOnRequestedDay: 0,
        requestedWeekday: "sab",
        slotsOnRequestedWeekday: 0,
      }),
    ).toBe(true);
  });

  it("regra antiga preservada: nada encontrado → amplia", () => {
    expect(shouldWidenSlotWindow({ totalSlots: 0, explicitWindowDays: null })).toBe(true);
  });

  it("achou vaga no dia da semana pedido → não amplia", () => {
    expect(
      shouldWidenSlotWindow({
        totalSlots: 12,
        explicitWindowDays: null,
        requestedWeekday: "sab",
        slotsOnRequestedWeekday: 5,
      }),
    ).toBe(false);
  });

  it("janela explícita do LLM manda — nunca amplia por cima dela", () => {
    expect(
      shouldWidenSlotWindow({
        totalSlots: 0,
        explicitWindowDays: 7,
        requestedWeekday: "sab",
        slotsOnRequestedWeekday: 0,
      }),
    ).toBe(false);
  });

  it("sem pedido nenhum e com vagas → não amplia", () => {
    expect(shouldWidenSlotWindow({ totalSlots: 6, explicitWindowDays: null })).toBe(false);
  });
});

describe("scrub pega o dia da semana inventado", () => {
  // Os slots REAIS eram de segunda; o agente escreveu "sábado, 21/09 às 08:30".
  // Hora real, data real, dia da semana falso — passava pelos dois guards que
  // existiam (um só olha horário, o outro só olha dd/mm).
  const reais = [
    { date_label: "segunda-feira, 21/09", time_label: "08:30" },
    { date_label: "segunda-feira, 21/09", time_label: "10:30" },
  ];

  it("barra a frase que chama segunda de sábado", () => {
    const r = scrubInventedTimeOffers(
      "Oi Wellington! O próximo sábado disponível é 21/09. Tenho sábado, 21/09 às 08:30.",
      reais,
    );
    expect(r.scrubbed).toBe(true);
    expect(r.reply).not.toMatch(/sábado, 21\/09 às 08:30/);
  });

  it("deixa passar a oferta com o dia CERTO", () => {
    const r = scrubInventedTimeOffers(
      "Tenho segunda-feira, 21/09 às 08:30 ou segunda-feira, 21/09 às 10:30.",
      reais,
    );
    expect(r.scrubbed).toBe(false);
  });

  it("não confunde fala de expediente com oferta", () => {
    const r = scrubInventedTimeOffers(
      "A gente atende sábado de manhã e de segunda a sexta o dia todo.",
      reais,
    );
    expect(r.scrubbed).toBe(false);
  });
});
