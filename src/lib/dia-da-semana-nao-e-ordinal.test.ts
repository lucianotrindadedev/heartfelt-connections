// Caso real (Clínica Bomfim, Milene Cristine Torres, 21 99004-9579, 21/09/2026).
//
// Ela escreveu "Preciso de uma segunda opinião" às 12:07. O reconhecimento de
// dia da semana — /\b(...|segunda|...)(?:-?feira)?\b/, com o "-feira" OPCIONAL
// — leu isso como segunda-feira, e a leitura virou RESTRIÇÃO de dia (a mesma
// regra criada para o "tem q ser no sábado" do Wellington, Implanto Master,
// 12–14/09). A busca passou a ofertar só segundas; 21/09, a âncora, era uma
// segunda sem vaga; a próxima segunda com vaga era 28/09.
//
// Às 12:46 a lead ouviu "Consegui dois horários para você na próxima semana:
// segunda-feira, 28/09 às 11:30 ou 13:00" — com 22/09 (5 vagas), 23/09 (11) e
// 24/09 (12) livres na agenda da Pechincha. O prompt manda ofertar os dois
// horários reais mais próximos, e o modelo obedeceu: a LISTA é que chegou
// filtrada só com segundas.
//
// Varredura de 90 dias: 29 conversas em 12 contas. A Clínica Bomfim lidera com
// 9 justamente porque o posicionamento dela atrai lead de segunda opinião.
//
// Validado contra 5.442 falas reais de lead (120 dias): 535 falsos positivos
// eliminados, 27 corrigidos para outro dia, ZERO pedidos legítimos perdidos.

import { describe, expect, it } from "vitest";

import { requestedWeekdayFromText, requestedDateFromText } from "./booking-template";

describe("REGRESSÃO: ordinal não é dia da semana", () => {
  it("a fala exata da Milene não vira segunda-feira", () => {
    expect(requestedWeekdayFromText("Preciso de uma segunda opinião")).toBeNull();
    // A DATA vinha da mesma leitura e também apontava para a próxima segunda.
    expect(requestedDateFromText("Preciso de uma segunda opinião")).toBeNull();
  });

  it("as outras falas reais que caíam na mesma armadilha", () => {
    for (const fala of [
      "Buscando segunda opinião",
      "Busco sim, uma segunda opinião",
      "Estou querendo uma segunda opinião",
      "Segunda opinião para ver se realmente há necessidade de implante e valores",
      "Gostaria de uma segunda opinião e sentir mais segurança em relação a prótese",
      "Ah, sou eu de novo. Eu queria saber se para essa segunda opinião se paga alguma consulta.",
      "Já é a segunda vez",
      "é a segunda vez que eu procuro!",
      "Ja é a segunda vez que voces tao me ligando !",
      "Fiz Canal e o bloco caiu pela segunda vez",
      "Pela segunda vez NÃO ESTOU DISPONIVEL",
    ]) {
      expect(requestedWeekdayFromText(fala), fala).toBeNull();
    }
  });

  it("a mesma armadilha nos outros dias", () => {
    expect(requestedWeekdayFromText("moro na segunda rua depois do shopping")).toBeNull();
    expect(requestedWeekdayFromText("minha filha está na quarta série")).toBeNull();
    expect(requestedWeekdayFromText("é a quinta vez que tento")).toBeNull();
    expect(requestedWeekdayFromText("preciso da segunda via do boleto")).toBeNull();
    expect(requestedWeekdayFromText("vamos para a segunda etapa do tratamento")).toBeNull();
  });
});

describe("pedido de dia CONTINUA sendo reconhecido", () => {
  it('"-feira" explícito sempre vale, mesmo colado num ordinal depois', () => {
    expect(requestedWeekdayFromText("pode ser quinta-feira?")).toBe("qui");
    expect(requestedWeekdayFromText("na terça feira as 15h")).toBe("ter");
    // Caso real (clareamento): a vírgula separa o pedido do ordinal — pede
    // QUINTA, não a sexta que aparece mais adiante na frase.
    expect(
      requestedWeekdayFromText(
        "gostaria de saber se é possível a gente adiantar para quinta-feira, a segunda parte do clareamento",
      ),
    ).toBe("qui");
  });

  it("palavra solta, como o lead responde de verdade", () => {
    // As respostas de uma palavra são o caso mais comum no histórico real.
    expect(requestedWeekdayFromText("quarta")).toBe("qua");
    expect(requestedWeekdayFromText("Pode ser quarta")).toBe("qua");
    expect(requestedWeekdayFromText("pode ser sábado")).toBe("sab");
    expect(requestedWeekdayFromText("ser na terça")).toBe("ter");
    expect(requestedWeekdayFromText("segunda não posso")).toBe("seg");
  });

  it('"segunda à tarde" é pedido de segunda, não faixa', () => {
    // A faixa exige outro DIA depois do "a" — "tarde" não é dia.
    expect(requestedWeekdayFromText("segunda a tarde")).toBe("seg");
    expect(requestedWeekdayFromText("terça a tarde")).toBe("ter");
  });

  it("o caso do Wellington, que originou a restrição de dia, segue valendo", () => {
    // Implanto Master Venda Nova, 31 99726-9556, 12–14/09.
    expect(requestedWeekdayFromText("Tem q ser no sábado")).toBe("sab");
    expect(requestedWeekdayFromText("tem que ser no sabado")).toBe("sab");
  });

  it("domingo e sábado nunca são ordinais em português", () => {
    expect(requestedWeekdayFromText("pode ser domingo")).toBe("dom");
    expect(requestedWeekdayFromText("sábado")).toBe("sab");
  });
});

describe("faixa de dias não é pedido de dia", () => {
  it("quem diz que trabalha de segunda a sexta não está pedindo segunda", () => {
    // Antes isto devolvia "seg" — exatamente os dias em que o lead NÃO pode.
    expect(requestedWeekdayFromText("Eu trabalho de segunda a sexta")).toBeNull();
    expect(requestedWeekdayFromText("Eu trabalho de domingo a domingo")).toBeNull();
    expect(requestedWeekdayFromText("Nosso horário é de segunda à sexta das 9h às 17h")).toBeNull();
  });

  it("depois da faixa, um dia de verdade ainda é lido", () => {
    // Caso real: o lead diz quando NÃO pode e em seguida quando pode.
    expect(
      requestedWeekdayFromText("Eu trabalho de segunda a sexta. Só tem cada sábado e domingo."),
    ).toBe("sab");
    expect(
      requestedWeekdayFromText(
        "sou pedreiro, ao trabalho de segunda a sexta. Só dá pra mim sábado ou domingo.",
      ),
    ).toBe("sab");
  });
});
