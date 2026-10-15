// Caso real (Odonto Sorrisos, 87 99824-4791, 15/10/2026): a lead disse "…estou
// vendo sua mensagem agora, nega" e a IA respondeu "Nega, infelizmente…".
// Frases abaixo tiradas das respostas reais de 60 dias (varredura 15/10).
import { describe, expect, it } from "vitest";

import { removerVocativoInformal, VOCATIVO_RULE } from "./vocativo-guard";

describe("removerVocativoInformal — tira o vocativo que chama o lead", () => {
  it.each([
    [
      "Nega, infelizmente essa semana a agenda de 16h está fechada. Qual fica melhor pra você?",
      "Infelizmente essa semana a agenda de 16h está fechada. Qual fica melhor pra você?",
    ],
    [
      "Obrigada, amor! 😍 Quer conhecer nossos procedimentos?",
      "Obrigada! 😍 Quer conhecer nossos procedimentos?",
    ],
    [
      "Entendo perfeitamente, querida. Dor de coluna é complicado.",
      "Entendo perfeitamente. Dor de coluna é complicado.",
    ],
    ["Fica bem, Francisco! Até breve, mano! 🙌", "Fica bem, Francisco! Até breve! 🙌"],
    [
      "Oi! Tudo bem sim, flor! 🌼 Que bom te ver por aqui.",
      "Oi! Tudo bem sim! 🌼 Que bom te ver por aqui.",
    ],
    [
      "Oi, meu bem! Só checando: continua tudo bem por aí? 😊",
      "Oi! Só checando: continua tudo bem por aí? 😊",
    ],
    [
      "Irmão, não precisa se desculpar de nada. Entendo perfeitamente.",
      "Não precisa se desculpar de nada. Entendo perfeitamente.",
    ],
    [
      "Perfeito, Paulinho! 🎯\n\nSó mais um ponto importante, irmão. Nossos horários…",
      "Perfeito, Paulinho! 🎯\n\nSó mais um ponto importante. Nossos horários…",
    ],
    ["Tudo bem, querida? Me conta o que te incomoda.", "Tudo bem? Me conta o que te incomoda."],
    ["Entendi, mano, vou ver aqui pra você.", "Entendi, vou ver aqui pra você."],
  ])("%j", (antes, depois) => {
    expect(removerVocativoInformal(antes)).toBe(depois);
  });
});

describe("removerVocativoInformal — não mexe no que não é vocativo", () => {
  it.each([
    "Seu sorriso vai ficar lindo e natural!",
    "Um amigo indicou a gente? Que bom!",
    "Pode vir com seu irmão ou um acompanhante.",
    "Cuidamos de cada paciente com amor e atenção.",
    "Opa, Paulinho! Claro que lembro de você!",
    "Oi, Rosa! Sem problema nenhum! 😊",
    "Fico por aqui, viu? Qualquer coisa é só chamar.",
    // Texto sem vocativo volta idêntico, mesmo com pontuação estranha.
    "Que legal, ! 😊 Me conta o que você quer resolver.",
  ])("%j", (t) => {
    expect(removerVocativoInformal(t)).toBe(t);
  });

  it("não remove a palavra quando ela é o nome do lead", () => {
    expect(removerVocativoInformal("Perfeito, Flor! Te espero amanhã.", "Flor de Lima")).toBe(
      "Perfeito, Flor! Te espero amanhã.",
    );
  });
});

describe("VOCATIVO_RULE", () => {
  it("proíbe copiar o apelido mesmo quando o lead usa", () => {
    expect(VOCATIVO_RULE).toMatch(/nem se o próprio lead chamar você assim/);
  });
});
