// Caso real (Sorriso Saúde, Goreth 27 98800-0072, 23/09/2026 08:06).
//
// Ela escreveu "Prefiro na,quarta ,q,vem, a tarde". A IA chamou listar_horarios
// — não inventou nada — e respondeu:
//
//   "verifiquei aqui e pela tarde a agenda está fechada nos próximos dias.
//    Mas consegui abrir um encaixe pela manhã na quarta que vem: tenho 08:30,
//    09:00, 09:30, 10:00 ou 10:30."
//
// A quarta 30/09 tinha 8 vagas de tarde, até 16:30.
//
// Reproduzindo a chamada com o histórico real, variando só o `periodo`:
//   periodo="tarde" -> 12:00, 13:30, 14:00, 14:30, 15:00, 15:30
//   periodo="manha" -> 08:30, 09:00, 09:30, 10:00, 10:30, 11:00   <== o que ela recebeu
//
// Ou seja: o modelo passou periodo="manha", a busca respondeu certo à pergunta
// errada, e ele concluiu que a tarde estava fechada. O fallback existente só
// cobria o modelo OMITIR o turno — um turno ERRADO vencia o lead.
//
// A mesma frase apareceu com 27 98837-6103 (22/09) e com a Marcelene
// 27 99703-3358 (22/09), na mesma semana e na mesma conta.

import { describe, expect, it } from "vitest";

import { resolvePeriodoBusca, resumeToolArgs } from "./booking-template";
import { turnoNegadoComVagaEmMaos } from "./agents/closed-agenda-claim";

describe("resolvePeriodoBusca", () => {
  it("REGRESSÃO: turno errado do modelo não vence o do lead", () => {
    expect(resolvePeriodoBusca({ doModelo: "manha", doLead: "tarde" })).toEqual({
      periodo: "tarde",
      origem: "lead_sobrepos_modelo",
    });
  });

  it("modelo omitiu: vale o do lead, como já valia", () => {
    expect(resolvePeriodoBusca({ doModelo: undefined, doLead: "tarde" })).toEqual({
      periodo: "tarde",
      origem: "lead",
    });
    expect(resolvePeriodoBusca({ doModelo: "", doLead: "manha" }).periodo).toBe("manha");
  });

  it("lead não pediu turno: vale o do modelo", () => {
    expect(resolvePeriodoBusca({ doModelo: "noite", doLead: null })).toEqual({
      periodo: "noite",
      origem: "modelo",
    });
  });

  it("os dois concordam: sem sobreposição", () => {
    expect(resolvePeriodoBusca({ doModelo: "tarde", doLead: "tarde" }).origem).toBe("modelo");
  });

  it("ninguém pediu: sem filtro de turno", () => {
    expect(resolvePeriodoBusca({})).toEqual({ periodo: undefined, origem: "nenhum" });
  });

  it("turno inválido do modelo é ignorado, não propagado", () => {
    expect(resolvePeriodoBusca({ doModelo: "manhazinha", doLead: "tarde" }).periodo).toBe("tarde");
    expect(resolvePeriodoBusca({ doModelo: "qualquer", doLead: null }).periodo).toBeUndefined();
  });
});

describe("resumeToolArgs", () => {
  it("grava o que o modelo passou — era isso que faltava no meta", () => {
    expect(resumeToolArgs("listar_horarios", '{"data_alvo":"2026-09-30","periodo":"manha"}')).toBe(
      "listar_horarios(data_alvo=2026-09-30 periodo=manha)",
    );
  });

  it("omite vazio e aguenta args ilegíveis", () => {
    expect(resumeToolArgs("listar_horarios", '{"periodo":"","data_alvo":null}')).toBe(
      "listar_horarios()",
    );
    expect(resumeToolArgs("x", "{quebrado")).toBe("x(<args ilegiveis>)");
    expect(resumeToolArgs("x", "")).toBe("x()");
  });
});

describe("turnoNegadoComVagaEmMaos", () => {
  const TARDE = [
    { iso: "2026-09-30T13:30:00-03:00", date_label: "quarta-feira, 30/09", time_label: "13:30" },
    { iso: "2026-09-30T14:00:00-03:00", date_label: "quarta-feira, 30/09", time_label: "14:00" },
  ];
  const MANHA = [
    { iso: "2026-09-30T08:30:00-03:00", date_label: "quarta-feira, 30/09", time_label: "08:30" },
  ];

  it("REGRESSÃO: negar a tarde com vaga de tarde em mãos é bloqueado", () => {
    const r = turnoNegadoComVagaEmMaos({
      reply: "Goreth, verifiquei aqui e pela tarde a agenda está fechada nos próximos dias.",
      offeredSlots: TARDE,
    });
    expect(r?.turno).toBe("tarde");
    expect(r?.diaIso).toBe("2026-09-30");
  });

  it("a variante que apareceu com outra lead na mesma semana", () => {
    expect(
      turnoNegadoComVagaEmMaos({
        reply: "Verifiquei aqui e a agenda da tarde está fechada nos próximos dias.",
        offeredSlots: TARDE,
      })?.turno,
    ).toBe("tarde");
  });

  it("sem vaga NAQUELE turno em mãos, não há o que contradizer", () => {
    // É rede, não conserto: se a busca só trouxe manhã, a trava não opina.
    expect(
      turnoNegadoComVagaEmMaos({
        reply: "pela tarde a agenda está fechada nos próximos dias",
        offeredSlots: MANHA,
      }),
    ).toBeNull();
    expect(
      turnoNegadoComVagaEmMaos({
        reply: "pela tarde a agenda está fechada",
        offeredSlots: [],
      }),
    ).toBeNull();
  });

  it("oferta legítima de tarde não é bloqueada", () => {
    expect(
      turnoNegadoComVagaEmMaos({
        reply: "Tenho quarta-feira, 30/09 às 13:30 ou às 14:00 pela tarde. Qual fica melhor?",
        offeredSlots: TARDE,
      }),
    ).toBeNull();
  });

  it("negar a MANHÃ tendo só tarde em mãos também não é bloqueado", () => {
    expect(
      turnoNegadoComVagaEmMaos({
        reply: "pela manhã não tenho vaga nos próximos dias",
        offeredSlots: TARDE,
      }),
    ).toBeNull();
  });
});
