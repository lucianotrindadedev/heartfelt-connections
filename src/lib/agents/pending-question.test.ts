// Repergunta legítima x loop de verdade.
//
// Regressão: Escudero, 12 99189-4420, 13/08. "No seu caso, seria protocolo na
// arcada superior, inferior ou nas duas?" → lead responde "Sim" → a trava
// anti-loop bloqueou a repergunta e mandou "Desculpa, acho que me confundi
// aqui! 😅", zerando a conversa para refazer a MESMA pergunta no turno seguinte.

import { describe, expect, it } from "vitest";

import {
  extractOptionsQuestion,
  isBareAffirmation,
  leadSkippedOptionsQuestion,
} from "./pending-question";

const PERGUNTA_ARCADA = "No seu caso, seria protocolo na arcada superior, inferior ou nas duas?";

describe("leadSkippedOptionsQuestion — o caso real", () => {
  it("reconhece que 'Sim' não responde a pergunta das arcadas", () => {
    expect(leadSkippedOptionsQuestion("Sim", PERGUNTA_ARCADA)).toBe(true);
  });

  it("vale também quando a pergunta vem no fim de uma resposta maior", () => {
    const reply = `Boa tarde! 😊 Estamos em Rua Santa Clara 45, Vila Adyana, São José dos Campos - São Paulo. Mas antes de você vir, gostaria de entender melhor seu caso. ${PERGUNTA_ARCADA}`;
    expect(leadSkippedOptionsQuestion("Sim", reply)).toBe(true);
  });

  it("quando o lead ESCOLHE uma opção, não há repergunta a isentar", () => {
    for (const escolha of ["As duas", "Superior", "nas duas", "a inferior mesmo"]) {
      expect(leadSkippedOptionsQuestion(escolha, PERGUNTA_ARCADA)).toBe(false);
    }
  });

  it("pergunta sem opções não isenta nada — repetir ali é loop", () => {
    expect(leadSkippedOptionsQuestion("Sim", "Qual é o seu nome completo?")).toBe(false);
    expect(leadSkippedOptionsQuestion("ok", "Podemos seguir com o agendamento?")).toBe(false);
  });

  it("resposta anterior sem pergunta nenhuma não isenta", () => {
    expect(leadSkippedOptionsQuestion("Sim", "Perfeito, vou verificar aqui pra você.")).toBe(false);
  });
});

// prettier-ignore
const CONCORDANCIAS = ["Sim", "SIM", " sim ", "ok", "Ok!", "isso", "isso mesmo", "aham", "pode ser", "beleza", "tá bom", "Perfeito"];
// prettier-ignore
const ESCOLHAS = ["As duas", "superior", "quero agendar horário", "amanhã de manhã", "9:30", "não", "Alex de Vasconcelos"];

describe("isBareAffirmation", () => {
  for (const v of CONCORDANCIAS) {
    it(`trata ${JSON.stringify(v)} como concordância sem escolha`, () => {
      expect(isBareAffirmation(v)).toBe(true);
    });
  }

  for (const v of ESCOLHAS) {
    it(`NÃO trata ${JSON.stringify(v)} como concordância vazia`, () => {
      expect(isBareAffirmation(v)).toBe(false);
    });
  }

  it("texto longo nunca é concordância vazia", () => {
    expect(isBareAffirmation("sim, pode ser na arcada superior por favor")).toBe(false);
  });

  it("vazio/nulo não é concordância", () => {
    expect(isBareAffirmation("")).toBe(false);
    expect(isBareAffirmation(null)).toBe(false);
  });
});

describe("extractOptionsQuestion", () => {
  it("extrai a pergunta com opções", () => {
    expect(extractOptionsQuestion(PERGUNTA_ARCADA)).toBe(PERGUNTA_ARCADA);
  });

  it("pega a ÚLTIMA pergunta quando há mais de uma", () => {
    const r = "Tudo bem por aí? No seu caso, seria na arcada superior ou inferior?";
    expect(extractOptionsQuestion(r)).toBe("No seu caso, seria na arcada superior ou inferior?");
  });

  it("ignora 'ou' que ficou numa frase anterior à pergunta", () => {
    const r = "Pode ser hoje ou amanhã. Qual é o seu nome completo?";
    expect(extractOptionsQuestion(r)).toBeNull();
  });

  it("não confunde 'ou' dentro de outra palavra", () => {
    expect(extractOptionsQuestion("Eu sou a Samara, tudo certo?")).toBeNull();
  });

  it("sem interrogação, não há pergunta pendente", () => {
    expect(extractOptionsQuestion("Seria superior ou inferior.")).toBeNull();
    expect(extractOptionsQuestion("")).toBeNull();
    expect(extractOptionsQuestion(null)).toBeNull();
  });
});
