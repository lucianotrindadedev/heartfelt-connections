import { describe, expect, it } from "vitest";

import { buildSlotOfferFallback, chaveDoDiaBrt, canonizaDia } from "./slot-offer-fallback";

// Expediente do caso real: Odonto Carioca Campo Grande atende Seg–Sex.
const SEG_A_SEX = ["seg", "ter", "qua", "qui", "sex"];
const SLOTS = [
  { date_label: "quinta-feira, 23/07", time_label: "13:30" },
  { date_label: "quinta-feira, 23/07", time_label: "13:45" },
];

const FRASE_REAL = "Olha eu estou pensando em ir aí no sábado, mais não tenho certeza até nesse momento";

// ── Datas DINÂMICAS ────────────────────────────────────────────────────────
// buildSlotOfferFallback resolve o dia pedido ("sábado") para a PRÓXIMA
// ocorrência a partir de HOJE. Testes que fixam o `iso` do slot só passam na
// semana em que foram escritos: em 10/08/2026 (segunda) "sábado" vira 15/08 e
// um slot fixo em 08/08 deixa de casar — o invariante "tem vaga no dia pedido"
// quebrava sem regressão nenhuma no código. Gera o slot no dia REAL pedido.
const BRT = "America/Sao_Paulo";
function proximoDiaBrt(stem: string): { iso: string; label: string } {
  for (let i = 0; i <= 7; i++) {
    const d = new Date(Date.now() + i * 86_400_000);
    const nome = new Intl.DateTimeFormat("pt-BR", { timeZone: BRT, weekday: "long" }).format(d);
    const canon = nome
      .replace("-feira", "")
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .slice(0, 3);
    if (canon === stem) {
      const iso = new Intl.DateTimeFormat("en-CA", { timeZone: BRT }).format(d);
      const ddmm = new Intl.DateTimeFormat("pt-BR", {
        timeZone: BRT,
        day: "2-digit",
        month: "2-digit",
      }).format(d);
      return { iso, label: `${nome}, ${ddmm}` };
    }
  }
  throw new Error(`dia não encontrado: ${stem}`);
}
/** Slot no próximo <dia> real (ex.: slotNo("sab", "10:00")). */
function slotNo(stem: string, hora: string) {
  const { iso, label } = proximoDiaBrt(stem);
  return { iso: `${iso}T${hora}:00-03:00`, date_label: label, time_label: hora };
}

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
      // expediente diz Seg–Sex, mas a agenda TEM vaga no próximo sábado real
      offeredSlots: [slotNo("sab", "10:00")],
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

// ── Caso Escudero Odontologia (12 98114-1612, 12/08) ──────────────────────
// A lead disse "A tarde!! Depois do dia 21!!" e ouviu "Consigo verificar
// sexta-feira... Por enquanto tenho quarta-feira, 12/08 às 09:00" — uma vaga
// ANTERIOR à data que ela acabara de excluir. Aconteceu duas vezes na mesma
// conversa; na segunda ela pediu desculpa pela confusão. Na varredura de
// produção, 7 dos 8 usos deste ramo ofertavam um dia diferente do pedido.
describe("nunca oferta vaga ANTERIOR ao dia pedido", () => {
  /** Próximo dia ÚTIL a pelo menos `min` dias de hoje. */
  function utilDaqui(min: number) {
    for (let i = min; i <= min + 7; i++) {
      const d = new Date(Date.now() + i * 86_400_000);
      const nome = new Intl.DateTimeFormat("pt-BR", { timeZone: BRT, weekday: "long" }).format(d);
      if (/domingo|sábado/.test(nome)) continue;
      const iso = new Intl.DateTimeFormat("en-CA", { timeZone: BRT }).format(d);
      const ddmm = new Intl.DateTimeFormat("pt-BR", {
        timeZone: BRT,
        day: "2-digit",
        month: "2-digit",
      }).format(d);
      return { iso, ddmm, nome, label: `${nome}, ${ddmm}` };
    }
    throw new Error("sem dia útil");
  }
  const pedido = utilDaqui(9);
  const antigo = utilDaqui(1);
  const slotAntigo = {
    iso: `${antigo.iso}T09:00:00-03:00`,
    date_label: antigo.label,
    time_label: "09:00",
  };
  const slotNoPedido = {
    iso: `${pedido.iso}T14:00:00-03:00`,
    date_label: pedido.label,
    time_label: "14:00",
  };
  const pedeDepois = `Só posso a tarde e depois do dia ${pedido.ddmm.replace("/", "/")} ok`;

  it("só há vaga ANTES do dia pedido → não cita nenhuma", () => {
    const r = buildSlotOfferFallback({
      lastUserMsg: pedeDepois,
      offeredSlots: [slotAntigo],
      diasAtivos: SEG_A_SEX_EXTENSO,
    });
    expect(r.reply, "citou a data recusada").not.toContain(antigo.ddmm);
    expect(r.reply).toContain(pedido.ddmm);
    expect(r.reply).toMatch(/me confirma/i);
  });

  it("nomeia a DATA, não só o dia da semana", () => {
    // "consigo verificar sexta-feira" não diz QUAL sexta — foi onde a conversa
    // real derrapou, porque a lead tinha falado "depois do dia 21".
    const r = buildSlotOfferFallback({
      lastUserMsg: pedeDepois,
      offeredSlots: [slotAntigo],
      diasAtivos: SEG_A_SEX_EXTENSO,
    });
    expect(r.reply).toContain(`${pedido.nome}, ${pedido.ddmm}`);
  });

  it("vaga NO dia pedido continua sendo oferecida", () => {
    const r = buildSlotOfferFallback({
      lastUserMsg: pedeDepois,
      offeredSlots: [slotAntigo, slotNoPedido],
      diasAtivos: SEG_A_SEX_EXTENSO,
    });
    expect(r.reply).toContain("14:00");
    expect(r.reply).not.toContain(antigo.ddmm);
  });

  it("vaga DEPOIS do dia pedido também serve", () => {
    const depois = utilDaqui(12);
    const r = buildSlotOfferFallback({
      lastUserMsg: pedeDepois,
      offeredSlots: [
        slotAntigo,
        { iso: `${depois.iso}T16:00:00-03:00`, date_label: depois.label, time_label: "16:00" },
      ],
      diasAtivos: SEG_A_SEX_EXTENSO,
    });
    expect(r.reply).toContain(depois.ddmm);
    expect(r.reply).not.toContain(antigo.ddmm);
  });

  it("sem dia pedido, nada é filtrado (sem regressão)", () => {
    const r = buildSlotOfferFallback({
      lastUserMsg: "Com certeza",
      offeredSlots: [slotAntigo],
      diasAtivos: SEG_A_SEX_EXTENSO,
    });
    expect(r.motivo).toBe("reoferta");
    expect(r.reply).toContain(antigo.ddmm);
  });
});

describe("prioriza o dia pedido na oferta", () => {
  it("pediu quinta e há vaga na quinta → cita a quinta, não a terça", () => {
    // Datas dinâmicas: o slot precisa cair na PRÓXIMA quinta real, senão o
    // filtro por dia pedido não casa e o teste passaria por acaso (a quinta
    // apareceria só porque a oferta lista todos os slots).
    const terca = slotNo("ter", "09:00");
    const quinta = slotNo("qui", "12:00");
    const r = buildSlotOfferFallback({
      lastUserMsg: "consigo na quinta?",
      offeredSlots: [terca, quinta],
      diasAtivos: SEG_A_SEX_EXTENSO,
    });
    expect(r.reply).toContain(`${quinta.date_label} às ${quinta.time_label}`);
    expect(r.reply).not.toContain(terca.date_label);
  });
});
