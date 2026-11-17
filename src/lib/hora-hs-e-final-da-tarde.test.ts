import { describe, expect, it } from "vitest";

import { rankSlotsByRequestedHour, requestedHoraFromText } from "./booking-template";

// Caso real: Odonto Carioca Campo Grande, Layla (21) 98590-9224, 14–15/11/2026.
//
// A lead pediu "final da tarde", "As 16hs" e "a partir das 16hs". O leitor de
// hora não entendia "hs" e "final da tarde" só virava o turno "tarde" (12–18h),
// então o corte de 6 vagas pegava as primeiras da tarde (13:30–14:45). A IA
// concluiu "a clínica não tem horários disponíveis após as 16:00" — com
// 16:00–17:00 livres na quarta 18/11.

describe("requestedHoraFromText — abreviações 'hs' / 'hr' / 'hrs'", () => {
  it("frases reais da Layla", () => {
    expect(requestedHoraFromText("Será que conseguiria na quarta ? As 16hs")).toBe(16);
    expect(requestedHoraFromText("Só consigo no final da tarde msm a partir das 16hs")).toBe(16);
  });

  it("variações", () => {
    expect(requestedHoraFromText("pode ser 16hs?")).toBe(16);
    expect(requestedHoraFromText("às 17hrs")).toBe(17);
    expect(requestedHoraFromText("as 15hr")).toBe(15);
    expect(requestedHoraFromText("depois das 4hs")).toBe(16); // 1h–6h coloquial = tarde
  });

  it("o que já funcionava continua igual", () => {
    expect(requestedHoraFromText("tem vaga 9h?")).toBe(9);
    expect(requestedHoraFromText("às 16 horas")).toBe(16);
    expect(requestedHoraFromText("pode ser 16:00")).toBe(16);
    expect(requestedHoraFromText("dia 23/07")).toBeNull();
    expect(requestedHoraFromText("tenho 23 anos")).toBeNull();
  });
});

describe("requestedHoraFromText — 'final da tarde' sem hora", () => {
  it("vale como pedido de 17h", () => {
    expect(
      requestedHoraFromText(
        "Vcs teriam essa semana algum horário no final da tarde , pois só consigo nesses horários por conta d e trabalho",
      ),
    ).toBe(17);
    expect(
      requestedHoraFromText("Infelizmente pra mim só consigo no finalzinho da tarde msm"),
    ).toBe(17);
    expect(requestedHoraFromText("prefiro no fim da tarde")).toBe(17);
    expect(requestedHoraFromText("fim de tarde é melhor")).toBe(17);
  });

  it("hora dita vence o 'final da tarde'", () => {
    expect(requestedHoraFromText("no final da tarde, umas 16h")).toBe(16);
  });

  it("negado não conta", () => {
    expect(requestedHoraFromText("no final da tarde não consigo")).toBeNull();
    expect(requestedHoraFromText("não posso no final da tarde")).toBeNull();
  });

  it("tarde sem 'final' não vira hora", () => {
    expect(requestedHoraFromText("pode ser de tarde")).toBeNull();
    expect(requestedHoraFromText("boa tarde")).toBeNull();
  });
});

describe("ranking com a agenda real da quarta 18/11 (turno tarde)", () => {
  const TARDE_18 = [
    "13:30",
    "13:45",
    "14:45",
    "15:00",
    "15:15",
    "15:30",
    "15:45",
    "16:00",
    "16:15",
    "16:30",
    "16:45",
    "17:00",
  ];
  const min = (h: string) => Number(h.slice(0, 2)) * 60 + Number(h.slice(3));

  it("sem hora pedida: o corte de 6 fica nas primeiras (comportamento do caso)", () => {
    const r = rankSlotsByRequestedHour(TARDE_18, null, min).slice(0, 6);
    expect(r).toEqual(["13:30", "13:45", "14:45", "15:00", "15:15", "15:30"]);
  });

  it("'a partir das 16hs': 16:00 em diante entram no corte", () => {
    const hora = requestedHoraFromText("Só consigo no final da tarde msm a partir das 16hs");
    const r = rankSlotsByRequestedHour(TARDE_18, hora, min).slice(0, 6);
    expect(r).toEqual(expect.arrayContaining(["16:00", "16:15", "16:30", "16:45"]));
    // As duas primeiras (o par que o agente oferta) não ficam antes das 16:00.
    expect(r.slice(0, 2)).toEqual(["16:00", "16:15"]);
  });

  it("empate de distância: o mais tarde vem antes", () => {
    const r = rankSlotsByRequestedHour(["15:45", "16:15"], 16, min);
    expect(r).toEqual(["16:15", "15:45"]);
  });

  it("'final da tarde': 17:00 e 16:45 vêm primeiro", () => {
    const hora = requestedHoraFromText("só consigo no finalzinho da tarde msm");
    const r = rankSlotsByRequestedHour(TARDE_18, hora, min).slice(0, 2);
    expect(r).toEqual(expect.arrayContaining(["17:00", "16:45"]));
  });
});
