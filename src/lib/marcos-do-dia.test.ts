import { describe, expect, it } from "vitest";

import { requestedPeriodoFromText } from "./booking-template";

// Caso real: Odonto Carioca Campo Grande, (21) 99027-0086, 12/08.
// O lead escreveu "Pode ser depois do almoço." e recebeu 09:30 e 09:45. O turno
// ficava nulo, a busca não filtrava nada e a oferta vinha com os horários mais
// cedo da agenda.
describe("marcos do dia viram turno", () => {
  it("a frase real do caso", () => {
    expect(requestedPeriodoFromText("Pode ser depois do almoço.")).toBe("tarde");
  });

  it("depois do almoço, em todas as formas que aparecem em produção", () => {
    for (const t of [
      "depois do almoço",
      "Depois do almoço",
      "após o almoço",
      "apos o almoco",
      "pós-almoço",
      "pos almoco",
      "só depois do almoço",
      "depois que eu almoçar",
      "depois de almoçar",
      "Hoje eu vou poder, depois do almoço",
      "Tem amanhã, depois do meio-dia",
      "depois do meio dia",
    ]) {
      expect(requestedPeriodoFromText(t), t).toBe("tarde");
    }
  });

  it("antes do almoço / antes do meio-dia é MANHÃ", () => {
    for (const t of [
      "antes do almoço",
      "Qualquer horário antes de meio dia",
      "antes do meio-dia",
      "antes de almoçar",
    ]) {
      expect(requestedPeriodoFromText(t), t).toBe("manha");
    }
  });

  it("depois do jantar é NOITE", () => {
    expect(requestedPeriodoFromText("só consigo depois do jantar")).toBe("noite");
  });
});

describe("o que NÃO pode virar turno", () => {
  it("almoço solto é narrativa, não preferência", () => {
    // Sem a exigência de direção, todas estas virariam filtro de TARDE — e o
    // lead receberia só horários da tarde por ter contado uma história.
    for (const t of [
      "Ontem no almoço a dentadura quebrou",
      "Estou fazendo o almoço para levar o filho para escola",
      "Eu estava almoçando",
      "Ele está vindo almoçar",
      "Leidyane tá indo almoçar de que horas?",
      "Meu almoço 13:30 as 15:20",
      // Removido da lista após a varredura: fala de quando alguém RETORNA.
      "Eu vou falar com ela na volta do almoço e aí eu te aviso",
    ]) {
      expect(requestedPeriodoFromText(t), t).toBeNull();
    }
  });

  it("o marco do dia se comporta EXATAMENTE como a palavra literal", () => {
    // periodoExcluido só roda quando há DOIS+ turnos na frase — com um só, a
    // função devolve direto, e isso vale igual para "tarde" e para "depois do
    // almoço". A negação isolada ("depois do almoço não dá") NÃO é tratada aqui
    // hoje; é uma lacuna PRÉ-EXISTENTE do detector, não introduzida por este
    // marco. O teste trava a PARIDADE: se um dia divergirem, quebra.
    for (const [marco, literal] of [
      ["depois do almoço não dá", "de tarde não dá"],
      ["não posso depois do almoço", "não posso de tarde"],
      ["trabalho depois do almoço", "trabalho de tarde"],
    ]) {
      expect(requestedPeriodoFromText(marco!), marco).toBe(requestedPeriodoFromText(literal!));
    }
  });
});

describe("convivência com o vocabulário antigo (sem regressão)", () => {
  it("turno explícito segue funcionando", () => {
    expect(requestedPeriodoFromText("prefiro de tarde")).toBe("tarde");
    expect(requestedPeriodoFromText("de manhã fica melhor")).toBe("manha");
    expect(requestedPeriodoFromText("só consigo à noite")).toBe("noite");
    expect(requestedPeriodoFromText("pode ser amanhã")).toBeNull();
  });

  it("saudação continua não sendo turno", () => {
    expect(requestedPeriodoFromText("Boa tarde")).toBeNull();
    expect(requestedPeriodoFromText("Boa tarde, pode ser depois do almoço")).toBe("tarde");
  });

  it("o último sinal citado vence, marco do dia incluído", () => {
    // "trabalho de manhã" é cláusula de exclusão; sobra o marco do dia.
    expect(requestedPeriodoFromText("trabalho de manhã, só posso depois do almoço")).toBe("tarde");
  });
});
