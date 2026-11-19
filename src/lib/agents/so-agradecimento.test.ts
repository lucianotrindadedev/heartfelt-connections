import { describe, expect, it } from "vitest";

import {
  ehSoAgradecimento,
  falasAtuaisDoLead,
  perguntouSobreMudarAgendamento,
} from "./so-agradecimento";

describe("agradecimento não é pedido de remarcação", () => {
  it("caso real: 'Obrigada' depois de remarcar", () => {
    expect(ehSoAgradecimento("Obrigada")).toBe(true);
  });

  it("variações de agradecimento", () => {
    for (const t of ["obrigado!", "Ok, obrigada", "Perfeito, muito obrigada!!", "valeu", "Obg", "Deus abençoe, obrigada", "obrigada, até lá"]) {
      expect(ehSoAgradecimento(t), t).toBe(true);
    }
  });

  it("'ok'/'certo'/'perfeito' sozinhos podem ser consentimento: não contam", () => {
    for (const t of ["ok", "Certo", "Perfeito", "sim"]) expect(ehSoAgradecimento(t), t).toBe(false);
  });

  it("pedido junto do agradecimento não é só agradecimento", () => {
    for (const t of [
      "Obrigada, mas preciso remarcar",
      "obrigada, pode ser outro dia?",
      "Pra mim só dá 19horas",
      "Obrigada, segunda às 19h",
      "não vou conseguir, obrigada",
    ]) {
      expect(ehSoAgradecimento(t), t).toBe(false);
    }
  });

  it("pergunta nossa sobre remarcar libera a ferramenta", () => {
    expect(perguntouSobreMudarAgendamento("Quer que eu remarque para outro dia?")).toBe(true);
    expect(perguntouSobreMudarAgendamento("Vou remarcar sua consulta para segunda-feira, 23/11 às 19:00. Tudo certo! 😊")).toBe(false);
  });

  it("rajada atual do lead = falas depois da última nossa", () => {
    expect(
      falasAtuaisDoLead([
        { role: "user", content: "As 19horas" },
        { role: "assistant", content: "Tudo certo!" },
        { role: "user", content: "Obrigada" },
        { role: "user", content: "🙏" },
      ]),
    ).toEqual(["Obrigada", "🙏"]);
  });
});
