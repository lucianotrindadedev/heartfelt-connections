import { describe, expect, it } from "vitest";

import { buildSlotOfferFallback, chaveDoDiaBrt, canonizaDia } from "./slot-offer-fallback";

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

// ── REGRESSÃO 03/08: "não atende quinta" numa clínica Seg–Sex ──────────────
// activeWeekdayKeys() devolve nome por extenso ("segunda","quinta"), mas
// chaveDoDiaBrt() devolve abreviação ("seg","qui"). Comparados crus, o
// includes() era SEMPRE falso e o fallback negava TODOS os dias. 26 mensagens
// erradas em produção entre 23/07 e 03/08 (Odonto Carioca, 21 97558-2703).
const SEG_A_SEX_EXTENSO = ["segunda", "terca", "quarta", "quinta", "sexta"];

describe("canonizaDia — as duas pontas falam vocabulários diferentes", () => {
  it("abreviação e nome por extenso convergem", () => {
    expect(canonizaDia("qui")).toBe(canonizaDia("quinta"));
    expect(canonizaDia("seg")).toBe(canonizaDia("segunda"));
    expect(canonizaDia("sab")).toBe(canonizaDia("sábado"));
    expect(canonizaDia("ter")).toBe(canonizaDia("terça"));
  });
  it("tolera acento, caixa e sufixo -feira", () => {
    expect(canonizaDia("QUINTA-FEIRA")).toBe(canonizaDia("qui"));
    expect(canonizaDia("terça-feira")).toBe(canonizaDia("ter"));
  });
  it("dias diferentes não colidem", () => {
    const todos = ["dom", "seg", "ter", "qua", "qui", "sex", "sab"].map(canonizaDia);
    expect(new Set(todos).size).toBe(7);
  });
});

describe("dia FECHADO — regressão do vocabulário", () => {
  const QUINTA = [
    { iso: "2026-08-06T12:00:00-03:00", date_label: "quinta-feira, 06/08", time_label: "12:00" },
    { iso: "2026-08-06T12:15:00-03:00", date_label: "quinta-feira, 06/08", time_label: "12:15" },
  ];

  it("clínica Seg–Sex NÃO pode dizer que não atende quinta", () => {
    const r = buildSlotOfferFallback({
      lastUserMsg: "Consegue confirmar uma avaliação para quinta feira às 09:15?",
      offeredSlots: QUINTA,
      diasAtivos: SEG_A_SEX_EXTENSO,
    });
    expect(r.motivo).not.toBe("dia_fechado");
    expect(r.reply).not.toContain("não atende");
  });

  it("nenhum dia útil é negado (varredura Seg–Sex)", () => {
    for (const dia of ["segunda", "terça", "quarta", "quinta", "sexta"]) {
      const r = buildSlotOfferFallback({
        lastUserMsg: `consigo na ${dia}?`,
        offeredSlots: QUINTA,
        diasAtivos: SEG_A_SEX_EXTENSO,
      });
      expect(r.reply, dia).not.toContain("não atende");
    }
  });

  it("sábado (realmente fechado) continua sendo negado", () => {
    const r = buildSlotOfferFallback({
      lastUserMsg: "posso ir no sábado?",
      offeredSlots: [
        { iso: "2026-08-06T12:00:00-03:00", date_label: "quinta-feira, 06/08", time_label: "12:00" },
      ],
      diasAtivos: SEG_A_SEX_EXTENSO,
    });
    expect(r.motivo).toBe("dia_fechado");
    expect(r.reply).toContain("não atende");
  });
});

describe("INVARIANTE: nunca negar um dia em que existe vaga ofertada", () => {
  it("mesmo com o expediente dizendo fechado, a agenda manda", () => {
    const r = buildSlotOfferFallback({
      lastUserMsg: "posso no sábado?",
      // expediente diz Seg–Sex, mas a agenda TEM vaga no sábado 08/08
      offeredSlots: [
        { iso: "2026-08-08T10:00:00-03:00", date_label: "sábado, 08/08", time_label: "10:00" },
      ],
      diasAtivos: SEG_A_SEX_EXTENSO,
    });
    expect(r.reply).not.toContain("não atende");
  });

  it("a resposta nunca nega e oferece o MESMO dia na mesma frase", () => {
    for (const dia of ["segunda", "terça", "quarta", "quinta", "sexta", "sábado", "domingo"]) {
      const r = buildSlotOfferFallback({
        lastUserMsg: `consigo na ${dia}?`,
        offeredSlots: [
          { iso: "2026-08-06T12:00:00-03:00", date_label: "quinta-feira, 06/08", time_label: "12:00" },
        ],
        diasAtivos: SEG_A_SEX_EXTENSO,
      });
      if (r.reply.includes("não atende")) {
        // A negação nomeia o dia de propósito ("sobre domingo: não atendemos").
        // O que NÃO pode é a parte da OFERTA citar esse mesmo dia.
        const oferta = r.reply.split("Mas consigo te encaixar")[1] ?? "";
        expect(oferta, `${dia}: nega e oferece o mesmo dia`).not.toContain(
          NOME_DIA_TESTE[r.diaPedido!],
        );
      }
    }
  });
});

const NOME_DIA_TESTE: Record<string, string> = {
  dom: "domingo", seg: "segunda-feira", ter: "terça-feira", qua: "quarta-feira",
  qui: "quinta-feira", sex: "sexta-feira", sab: "sábado",
};

describe("prioriza o dia pedido na oferta", () => {
  it("pediu quinta e há vaga na quinta → cita a quinta, não a terça", () => {
    const r = buildSlotOfferFallback({
      lastUserMsg: "consigo na quinta?",
      offeredSlots: [
        { iso: "2026-08-04T09:00:00-03:00", date_label: "terça-feira, 04/08", time_label: "09:00" },
        { iso: "2026-08-06T12:00:00-03:00", date_label: "quinta-feira, 06/08", time_label: "12:00" },
      ],
      diasAtivos: SEG_A_SEX_EXTENSO,
    });
    expect(r.reply).toContain("quinta-feira, 06/08 às 12:00");
  });
});
