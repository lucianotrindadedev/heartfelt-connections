import { describe, expect, it } from "vitest";
import { isReplyTooSimilar, scheduleTokens } from "./reply-similarity";

describe("scheduleTokens", () => {
  it("normaliza horários e datas", () => {
    expect([...scheduleTokens("sábado, 19/09 às 08:30 ou 9h, e 9h30")].sort()).toEqual(
      ["19/9", "8:30", "9:00", "9:30"].sort(),
    );
  });
});

describe("isReplyTooSimilar", () => {
  it("texto idêntico é repetição", () => {
    const t =
      "Os horários que consigo são sexta-feira, 18/09 às 13:00 ou 13:30. Qual deles fica melhor pra você?";
    expect(isReplyTooSimilar(t, t)).toBe(true);
  });

  it("oferta de OUTRO dia não é repetição (Marcos, pediu sábado)", () => {
    expect(
      isReplyTooSimilar(
        "Perfeito! Tenho horários no sábado que vem, 19/09 pela manhã: sábado, 19/09 às 08:30 ou sábado, 19/09 às 09:00. Qual fica melhor para você?",
        "Entendi, Marcos. Consigo te encaixar na segunda-feira, 14/09: segunda-feira, 14/09 às 08:30 ou segunda-feira, 14/09 às 09:00. Qual fica melhor para você?",
      ),
    ).toBe(false);
  });

  it("oferta de OUTRO horário no mesmo dia não é repetição (Osvaldina)", () => {
    expect(
      isReplyTooSimilar(
        "Entendi! Na segunda de manhã tenho segunda-feira, 14/09 às 09:30 ou segunda-feira, 14/09 às 10:00. Qual desses funciona melhor pra você?",
        "Verifiquei aqui e na segunda-feira, 14/09 de manhã tenho segunda-feira, 14/09 às 08:30 ou segunda-feira, 14/09 às 09:00. Qual desses fica melhor para você?",
      ),
    ).toBe(false);
  });

  it("pergunta repetida sem horário continua sendo repetição", () => {
    expect(
      isReplyTooSimilar(
        "Entendi. Você perdeu um dente ou mais de um?",
        "Oi! Que bom que você está buscando essa solução. Antes de te contar tudo sobre o protocolo, deixa eu entender melhor sua situação. Você perdeu um dente ou mais de um?",
      ),
    ).toBe(true);
  });

  it("texto curto demais não é avaliado", () => {
    expect(isReplyTooSimilar("Tudo bem!", "Tudo bem, fico no aguardo!")).toBe(false);
  });
});
