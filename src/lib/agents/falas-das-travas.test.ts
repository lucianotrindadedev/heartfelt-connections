// Textos que as travas (anti-repetição, confirmação falsa, anti-stall) mandam
// no lugar da resposta do modelo. Casos reais da Sorriso Saúde, set/2026.
import { describe, expect, it } from "vitest";
import { addressLineIfAsked, joinLeadIn } from "@/lib/booking-template";
import {
  NEUTRAL_REPEAT_ACK,
  REPHRASE_PREFIX,
  rephraseRepeatedQuestion,
} from "./duplicate-fallback";

const PERGUNTA_NOME = "Perfeito. Para finalizar, me envia por favor seu nome completo?";

describe("joinLeadIn", () => {
  it("não emenda 'Perfeito. Para finalizar' depois da vírgula (Ana)", () => {
    expect(
      joinLeadIn(
        "Quase lá! Pra fechar seu horário de quarta-feira, 16/09 às 08:30,",
        PERGUNTA_NOME,
      ),
    ).toBe(
      "Quase lá! Pra fechar seu horário de quarta-feira, 16/09 às 08:30, me envia por favor seu nome completo?",
    );
  });

  it("não repete a abertura depois de 'Desculpa insistir!'", () => {
    expect(joinLeadIn("Desculpa insistir!", PERGUNTA_NOME)).toBe(
      "Desculpa insistir! Me envia por favor seu nome completo?",
    );
  });

  it("preserva o nome do lead em maiúscula", () => {
    expect(
      joinLeadIn(
        "Quase lá! Pra fechar seu horário de quinta-feira, 24/09 às 08:30,",
        "Kelly, me confirma seu sobrenome? Preciso do nome completo pro cadastro.",
      ),
    ).toBe(
      "Quase lá! Pra fechar seu horário de quinta-feira, 24/09 às 08:30, Kelly, me confirma seu sobrenome? Preciso do nome completo pro cadastro.",
    );
  });

  it("separador de parágrafo", () => {
    expect(joinLeadIn("Perfeito, já anotei o horário aqui! 😊", PERGUNTA_NOME, "\n\n")).toBe(
      "Perfeito, já anotei o horário aqui! 😊\n\nMe envia por favor seu nome completo?",
    );
  });
});

describe("addressLineIfAsked", () => {
  const END = "Rua Francisco Alves, nº 88 – Campo Grande – Cariacica – ES";

  it.each([
    "Quarta às 08:30 e onde fica a clínica?",
    "Mas aonde fica a  Clínica?",
    "Esse horário de uma e meia fica melhor agora também me manda também o endereço da localização aí.",
    "Manda o endereço",
  ])("responde o endereço: %s", (msg) => {
    expect(addressLineIfAsked([msg], END)).toBe(`📍 Nosso endereço: ${END}`);
  });

  it("sem pergunta de endereço, nada", () => {
    expect(addressLineIfAsked(["As 14:30"], END)).toBe("");
  });

  it("sem endereço configurado, nada", () => {
    expect(addressLineIfAsked(["qual o endereço?"], "")).toBe("");
  });
});

describe("rephraseRepeatedQuestion", () => {
  it("refaz a pergunta pendente com outra abertura (Fia: 'Sim perdi')", () => {
    expect(rephraseRepeatedQuestion("Entendi. Você perdeu um dente ou mais de um?")).toBe(
      `${REPHRASE_PREFIX} você perdeu um dente ou mais de um?`,
    );
  });

  it("ignora o 'Oi!' de abertura (mariana: 'Oi')", () => {
    expect(rephraseRepeatedQuestion("Oi! 😊 Como você prefere que eu te chame?")).toBe(
      `${REPHRASE_PREFIX} como você prefere que eu te chame?`,
    );
  });

  it("'tudo bem?' não é a pergunta pendente", () => {
    expect(rephraseRepeatedQuestion("Fico por aqui, tudo bem?")).toBeNull();
  });

  it("resposta sem pergunta (despedida repetida) não é reformulada", () => {
    expect(
      rephraseRepeatedQuestion(
        "Entendi! Para assuntos de RH e oportunidades de emprego, você precisa falar direto com a equipe administrativa da clínica.",
      ),
    ).toBeNull();
    expect(NEUTRAL_REPEAT_ACK).not.toMatch(/confundi/);
  });
});
