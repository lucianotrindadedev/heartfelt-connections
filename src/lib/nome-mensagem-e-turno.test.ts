// Clínica Bomfim, lead do Instagram, 28/10:
// 1) "Mensagem" (placeholder da Helena p/ conteúdo não suportado) virou o nome
//    da lead e o sobrenome do paciente ("<Nome> Mensagem");
// 2) "Nao tem nenhum horario a tarde" + "Amanha" agendou 29/10 às 09:00.
import { describe, expect, it } from "vitest";
import { isPlatformNotice, isUnsupportedContentPlaceholder } from "./platform-notice";
import {
  leadPeriodContradictsSlot,
  mergePartialName,
  nameHasPlaceholderWord,
  sanitizeLeadDataPatch,
} from "./booking-template";

describe('"Mensagem" é placeholder, não fala do lead', () => {
  it("palavra solta (com ou sem pontuação/caixa) é aviso da plataforma", () => {
    for (const t of ["Mensagem", "mensagem", " MENSAGEM ", "Mensagem.", "Message"]) {
      expect(isUnsupportedContentPlaceholder(t)).toBe(true);
      expect(isPlatformNotice(t)).toBe(true);
    }
  });

  it("frase que contém a palavra continua sendo fala do lead", () => {
    for (const t of ["Mandei mensagem ontem", "Mensagem recebida, obrigada", "Carlos"]) {
      expect(isPlatformNotice(t)).toBe(false);
    }
  });

  it("o aviso clássico continua detectado", () => {
    expect(isPlatformNotice("*Atenção:* o tipo da mensagem enviada pelo contato não é suportado.")).toBe(true);
  });
});

describe("nome nunca leva o placeholder", () => {
  it('"Carlos" + "Mensagem" não vira "<Nome> Mensagem"', () => {
    expect(mergePartialName("Carlos", "Mensagem")).toBe("Carlos");
    expect(mergePartialName("Ana", "Souza")).toBe("Ana Souza");
  });

  it("detecta o placeholder dentro do nome", () => {
    expect(nameHasPlaceholderWord("<Nome> Mensagem")).toBe(true);
    expect(nameHasPlaceholderWord("Mensagem")).toBe(true);
    expect(nameHasPlaceholderWord("Carlos Silva")).toBe(false);
  });

  it("o patch do LLM com name='Mensagem' é descartado", () => {
    const out = sanitizeLeadDataPatch({ name: "Mensagem" } as never);
    expect((out as { name?: string }).name).toBeUndefined();
  });
});

describe("turno pedido x turno do horário", () => {
  const burst = [
    "Nao tem nenhum horario a tarde",
    "Amanha",
    "Porq ele vai ver la no trabalho",
    "E ele. Em sabe ainda q estou fazendo isso",
  ];

  it("pediu tarde, o slot é 09:00 → diverge (o caso real)", () => {
    expect(leadPeriodContradictsSlot(burst, "2026-10-29T09:00:00-03:00")).toEqual({
      pedido: "tarde",
      doSlot: "manha",
    });
  });

  it("pediu tarde, o slot é 13:30 → ok", () => {
    expect(leadPeriodContradictsSlot(burst, "2026-10-29T13:30:00-03:00")).toBeNull();
  });

  it("sem turno citado → não opina", () => {
    expect(leadPeriodContradictsSlot(["Amanha"], "2026-10-29T09:00:00-03:00")).toBeNull();
  });

  it('"Boa tarde" é saudação, não pedido de turno', () => {
    expect(leadPeriodContradictsSlot(["Boa tarde, pode ser esse"], "2026-10-29T09:00:00-03:00")).toBeNull();
  });

  it('"não TENHO horário de manhã" continua sendo recusa da manhã (não pedido)', () => {
    expect(leadPeriodContradictsSlot(["não tenho horário de manhã"], "2026-10-29T14:00:00-03:00")).toBeNull();
  });

  it('"não teria vaga de manhã?" é pedido da manhã', () => {
    expect(leadPeriodContradictsSlot(["não teria vaga de manhã?"], "2026-10-29T14:00:00-03:00")).toEqual({
      pedido: "manha",
      doSlot: "tarde",
    });
  });

  it("pediu manhã, slot à tarde → diverge", () => {
    expect(leadPeriodContradictsSlot(["prefiro de manhã"], "2026-10-29T14:00:00-03:00")).toEqual({
      pedido: "manha",
      doSlot: "tarde",
    });
  });
});
