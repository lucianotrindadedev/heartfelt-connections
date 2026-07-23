import { describe, expect, it } from "vitest";

import { buildSlotOfferFallback, chaveDoDiaBrt } from "./slot-offer-fallback";

// Expediente do caso real: Odonto Carioca Campo Grande atende Seg–Sex.
const SEG_A_SEX = ["seg", "ter", "qua", "qui", "sex"];
const SLOTS = [
  { date_label: "quinta-feira, 23/07", time_label: "13:30" },
  { date_label: "quinta-feira, 23/07", time_label: "13:45" },
];

const FRASE_REAL = "Olha eu estou pensando em ir aí no sábado, mais não tenho certeza até nesse momento";

describe("chaveDoDiaBrt", () => {
  it("resolve a chave do dia da semana em BRT", () => {
    expect(chaveDoDiaBrt("2026-07-25")).toBe("sab"); // 25/07/2026 = sábado
    expect(chaveDoDiaBrt("2026-07-23")).toBe("qui");
    expect(chaveDoDiaBrt("2026-07-27")).toBe("seg");
  });
  it("data inválida → null", () => {
    expect(chaveDoDiaBrt("nao-e-data")).toBeNull();
  });
});

describe("buildSlotOfferFallback — caso Odonto Carioca (21 97558-2703)", () => {
  it("lead pede SÁBADO e a clínica não abre → informa que não atende, sem repetir a oferta cega", () => {
    const r = buildSlotOfferFallback({
      lastUserMsg: FRASE_REAL,
      offeredSlots: SLOTS,
      diasAtivos: SEG_A_SEX,
    });
    expect(r.motivo).toBe("dia_fechado");
    expect(r.diaPedido).toBe("sab");
    expect(r.reply).toContain("sábado");
    expect(r.reply).toContain("não atende");
    // continua ajudando: oferece o que existe
    expect(r.reply).toContain("13:30");
    // e NÃO é o texto robótico antigo
    expect(r.reply).not.toMatch(/^Tenho estes horários disponíveis/);
  });

  it("mesma frase sem expediente configurado → não afirma nada sobre o dia", () => {
    const r = buildSlotOfferFallback({
      lastUserMsg: FRASE_REAL,
      offeredSlots: SLOTS,
      diasAtivos: [],
    });
    expect(r.motivo).toBe("reoferta");
    expect(r.reply).not.toContain("não atende");
  });

  it("lead pede um dia que a clínica ATENDE → reconhece o pedido em vez de repetir", () => {
    const r = buildSlotOfferFallback({
      lastUserMsg: "consigo ir na segunda?",
      offeredSlots: SLOTS,
      diasAtivos: SEG_A_SEX,
    });
    expect(r.motivo).toBe("dia_pedido_disponivel");
    expect(r.diaPedido).toBe("seg");
    expect(r.reply).toContain("segunda-feira");
    expect(r.reply).not.toMatch(/^Tenho estes horários disponíveis/);
  });

  it("dia fechado e sem slots em mãos → informa e pede outro dia", () => {
    const r = buildSlotOfferFallback({
      lastUserMsg: FRASE_REAL,
      offeredSlots: [],
      diasAtivos: SEG_A_SEX,
    });
    expect(r.motivo).toBe("dia_fechado");
    expect(r.reply).toContain("não atende");
    expect(r.reply).toContain("outro dia");
  });

  it("lead NÃO pediu dia → mantém a re-oferta de sempre (sem regressão)", () => {
    const r = buildSlotOfferFallback({
      lastUserMsg: "Com certeza",
      offeredSlots: SLOTS,
      diasAtivos: SEG_A_SEX,
    });
    expect(r.motivo).toBe("reoferta");
    expect(r.reply).toMatch(/^Tenho estes horários disponíveis/);
  });

  it("sem dia pedido e sem slots → pergunta genérica (sem regressão)", () => {
    const r = buildSlotOfferFallback({
      lastUserMsg: "Com certeza",
      offeredSlots: [],
      diasAtivos: SEG_A_SEX,
    });
    expect(r.motivo).toBe("sem_slots");
  });
});
