// Classificação de eco/loopback da Helena.
//
// Regressão principal: Maple Bear Guarujá, 13 99602-7940, 13/08. O agente
// perguntou "Como você se chama?" (19 chars). O piso de 25 chars fazia o eco
// dessa pergunta passar batido e ser gravado como mensagem de atendente — a
// resposta "Larissa" da lead ficou escondida e ela passou 1h04 sem resposta.

import { describe, expect, it } from "vitest";

import { classifyEchoAgainstOwnSends } from "./helena-echo.server";

const PERGUNTA_NOME = "Como você se chama?";

describe("eco curto vindo como saída (TO_HUB / atendente)", () => {
  it("descarta a cópia literal de uma pergunta curta nossa", () => {
    expect(
      classifyEchoAgainstOwnSends(PERGUNTA_NOME, [PERGUNTA_NOME], { fromLead: false }),
    ).toBe("confirmed");
  });

  it("ignora diferença de caixa e espaços", () => {
    expect(
      classifyEchoAgainstOwnSends("  como   VOCÊ se chama?  ", [PERGUNTA_NOME], {
        fromLead: false,
      }),
    ).toBe("confirmed");
  });

  it("marca como suspeita a bolha curta de uma resposta quebrada em partes", () => {
    const respostaInteira =
      "Perfeito! Só para eu te orientar certo sobre a turma, qual é a data de nascimento completa da sua criança? (dia, mês e ano)";
    expect(
      classifyEchoAgainstOwnSends("(dia, mês e ano)", [respostaInteira], { fromLead: false }),
    ).toBe("suspect");
  });

  it("deixa passar fala real de atendente que não casa com nossos envios", () => {
    expect(
      classifyEchoAgainstOwnSends("Oi, aqui é a Paula, assumi o atendimento", [PERGUNTA_NOME], {
        fromLead: false,
      }),
    ).toBe("none");
  });
});

describe("mensagem curta do lead (FROM_HUB) nunca é tratada como eco", () => {
  for (const texto of ["Bom dia", "Perfeito!", PERGUNTA_NOME]) {
    it(`preserva ${JSON.stringify(texto)} mesmo coincidindo com envio nosso`, () => {
      expect(classifyEchoAgainstOwnSends(texto, [texto], { fromLead: true })).toBe("none");
    });
  }
});

describe("texto longo — comportamento anterior preservado", () => {
  const longa =
    "Olá! Tudo bem com você? 🐻 Eu sou a Clara, da Maple Bear Guarujá! Você já é pai/mãe de aluno?";

  it("descarta cópia literal longa vinda do lead", () => {
    expect(classifyEchoAgainstOwnSends(longa, [longa], { fromLead: true })).toBe("confirmed");
  });

  it("descarta bolha longa contida na resposta inteira", () => {
    expect(
      classifyEchoAgainstOwnSends("Olá! Tudo bem com você? 🐻 Eu sou a Clara, da Maple Bear Guarujá!", [longa], {
        fromLead: false,
      }),
    ).toBe("confirmed");
  });

  it("não confunde mensagem longa e diferente do lead", () => {
    expect(
      classifyEchoAgainstOwnSends(
        "Bom dia, gostaria de saber o valor da mensalidade do Nursery para 2027",
        [longa],
        { fromLead: true },
      ),
    ).toBe("none");
  });
});

// Escudero, 12 99189-4420, 13/08: às 15:36 a Helena reentregou de uma vez 10
// mensagens, incluindo a pergunta que o agente fez às 01:49 — 14h antes. Fora da
// janela recente, o eco antigo é MARCADO, nunca descartado (um atendente pode
// legitimamente copiar nossa frase horas depois).
describe("janela longa (stale) — marca, nunca descarta", () => {
  const pergunta = "No seu caso, seria protocolo na arcada superior, inferior ou nas duas?";

  it("rebaixa cópia literal antiga de confirmed para suspect", () => {
    expect(classifyEchoAgainstOwnSends(pergunta, [pergunta], { fromLead: false })).toBe("confirmed");
    expect(
      classifyEchoAgainstOwnSends(pergunta, [pergunta], { fromLead: false, stale: true }),
    ).toBe("suspect");
  });

  it("rebaixa containment antigo de texto longo", () => {
    const inteira = `Oi! Tudo bem? Eu sou Samara, da Escudero Odontologia. ${pergunta}`;
    expect(
      classifyEchoAgainstOwnSends(pergunta, [inteira], { fromLead: false, stale: true }),
    ).toBe("suspect");
  });

  it("texto sem relação continua none mesmo na janela longa", () => {
    expect(
      classifyEchoAgainstOwnSends("Bom dia, qual o endereço de vocês?", [pergunta], {
        fromLead: false,
        stale: true,
      }),
    ).toBe("none");
  });

  it("mensagem curta do lead segue intocada na janela longa", () => {
    expect(classifyEchoAgainstOwnSends("Sim", ["Sim"], { fromLead: true, stale: true })).toBe("none");
  });
});

describe("bordas", () => {
  it("texto vazio não é eco", () => {
    expect(classifyEchoAgainstOwnSends("", ["qualquer coisa"], { fromLead: false })).toBe("none");
    expect(classifyEchoAgainstOwnSends(null, ["qualquer coisa"], { fromLead: false })).toBe("none");
  });

  it("sem envios recentes nada é eco", () => {
    expect(classifyEchoAgainstOwnSends(PERGUNTA_NOME, [], { fromLead: false })).toBe("none");
  });

  it("envios nulos/vazios são ignorados na comparação", () => {
    expect(
      classifyEchoAgainstOwnSends(PERGUNTA_NOME, [null, "", "   "], { fromLead: false }),
    ).toBe("none");
  });
});
