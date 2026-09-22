// Delta sobre o PR #57 (fix/compromisso-nao-e-escolha), que corrigiu o caso da
// Marcelene (Sorriso Saúde, 27 99703-3358, 22/09): "Pela manhã tenho
// compromisso" era lido como PEDIDO de manhã.
//
// A correção dele passou a aplicar periodoExcluido também com um turno só —
// o essencial. O que este delta muda é a MECÂNICA da exclusão:
//
//   1. testa cláusula a cláusula, não o texto inteiro;
//   2. as janelas não atravessam outra palavra de turno;
//   3. "amanhã" não conta como turno (contém "manh");
//   4. todos os turnos excluídos devolve null, em vez de um deles;
//   5. substantivo de impedimento vale solto ("só trabalho na parte da tarde"),
//      sem exigir o verbo gatilho de COMPROMISSO_SRC.
//
// Num gabarito de 16 falas com resposta conhecida, o #57 sozinho acerta 10 e
// com este delta vai a 16. Contra as 3.615 falas reais de 120 dias, o delta
// recupera 21 pedidos legítimos que o #57 zerava e neutraliza 25 impedimentos
// que ele deixava passar.

import { describe, expect, it } from "vitest";

import { requestedPeriodoFromText } from "./booking-template";

describe("exclusão de turno é por cláusula, não pelo texto inteiro", () => {
  it("REGRESSÃO: um 'não' em outra frase não apaga o pedido", () => {
    // Transcrição de áudio vem com os dois assuntos juntos. Varrendo o texto
    // todo, o "não puder" da 2ª frase matava o pedido explícito da 1ª.
    expect(
      requestedPeriodoFromText(
        "Eu prefiro ser atendido pela manhã. Se não puder na terça-feira pela manhã, embora não seja minha preferência, eu iria na sexta após as 17h",
      ),
    ).toBe("manha");
    expect(
      requestedPeriodoFromText(
        "Boa tarde, minha amiga. Olha só, amanhã pra mim não dá. Ou terça-feira, mas tem que ser na parte da manhã",
      ),
    ).toBe("manha");
    expect(
      requestedPeriodoFromText(
        "Amanhã não posso. Já tenho médico marcado. E 6af só posso pela manhã. As 13h estou no trabalho",
      ),
    ).toBe("manha");
  });

  it('REGRESSÃO: "amanhã" não é a palavra "manhã"', () => {
    // "amanhã" contém "manh". Sem fronteira de palavra na janela, o
    // impedimento nunca alcançava o turno do outro lado do "amanhã".
    expect(requestedPeriodoFromText("Não pode ser amanhã a tarde")).toBeNull();
  });

  it("a janela não atravessa outra palavra de turno", () => {
    // O impedimento é da TARDE; sem o tempero, ele contaminava a manhã e a
    // lead que pedia manhã recebia tarde. Fala real.
    expect(
      requestedPeriodoFromText(
        "Na parte da manhã pode marcar qualquer dia, que eu só trabalho na parte da tarde",
      ),
    ).toBe("manha");
    expect(requestedPeriodoFromText("eu trabalho de manha só posso de tarde")).toBe("tarde");
  });

  it("todos os turnos excluídos devolve null", () => {
    // Devolver um deles ofertava justamente o que o lead acabou de recusar.
    expect(requestedPeriodoFromText("de manhã trabalho e à tarde tenho aula")).toBeNull();
  });

  it("substantivo de impedimento vale solto, sem verbo gatilho", () => {
    expect(requestedPeriodoFromText("só trabalho na parte da tarde")).toBeNull();
    expect(requestedPeriodoFromText("tenho aula à tarde")).toBeNull();
  });
});

describe("o que o #57 já acertava continua acertando", () => {
  it("o caso da Marcelene", () => {
    expect(requestedPeriodoFromText("Pela manhã tenho compromisso")).toBeNull();
  });

  it("compromisso com palavra no meio ('tenho OUTRO compromisso')", () => {
    // Fala real. O COMPROMISSO_SRC exigia verbo e substantivo quase colados.
    expect(requestedPeriodoFromText("Manhã eu tenho outro compromisso")).toBeNull();
    expect(requestedPeriodoFromText("de manhã tenho meu médico")).toBeNull();
  });

  it("negação e trabalho", () => {
    for (const f of [
      "De manhã não posso",
      "De manhã to no trabalho",
      "Pela manhã eu estou no trabalho",
      "Na parte da manhã não posso, estou no trabalho",
      "Na quarta tenho médico agendado de manhã",
    ]) {
      expect(requestedPeriodoFromText(f), f).toBeNull();
    }
  });

  it("pedido continua sendo pedido", () => {
    expect(requestedPeriodoFromText("prefiro de manhã")).toBe("manha");
    expect(requestedPeriodoFromText("pode ser de manhã")).toBe("manha");
    expect(requestedPeriodoFromText("de tarde")).toBe("tarde");
    // "consulta" e "exame" só impedem COM verbo gatilho — numa clínica,
    // "quero a consulta de manhã" é pedido.
    expect(requestedPeriodoFromText("quero a consulta de manhã")).toBe("manha");
    expect(requestedPeriodoFromText("de manhã não dá, tem que ser de tarde")).toBe("tarde");
  });
});
