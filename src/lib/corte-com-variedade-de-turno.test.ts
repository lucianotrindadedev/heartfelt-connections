// O corte das vagas mais próximas pegava as N primeiras — e elas podem ser
// todas do mesmo turno.
//
// Caso real (Clínica Bomfim, Milene 21 99004-9579, 21/09/2026): a janela
// próxima tinha 22/09 às 13:00, 15:30, 16:00, 16:30, 17:00 e 23/09 às 13:00.
// Seis vagas, TODAS à tarde — com 24/09 livre de manhã (09:00, 10:30, 11:00,
// 11:30) dentro da mesma janela de busca.
//
// O prompt da conta manda "sempre 2 horários, em contraturno: um pela manhã e
// um à tarde". Com uma lista só de tarde isso não tem como ser cumprido: ou o
// agente quebra a instrução, ou vai buscar mais longe — foi o que aconteceu.
//
// A decisão aqui foi ajustar o código, não o prompt: a instrução de
// contraturno é da clínica e permanece.

import { describe, expect, it } from "vitest";

import { limitarComVariedadeDeTurno, turnoDeMinutos } from "./booking-template";

/** Slot mínimo para o teste: rótulo e minutos do dia. */
const s = (label: string) => ({
  label,
  min: Number(label.slice(0, 2)) * 60 + Number(label.slice(3)),
});
const minutos = (x: { min: number }) => x.min;
const labels = (xs: { label: string }[]) => xs.map((x) => x.label);

describe("turnoDeMinutos", () => {
  it("fronteiras iguais às de pickSlotByPreference", () => {
    expect(turnoDeMinutos(11 * 60 + 59)).toBe("manha");
    expect(turnoDeMinutos(12 * 60)).toBe("tarde");
    expect(turnoDeMinutos(17 * 60 + 59)).toBe("tarde");
    expect(turnoDeMinutos(18 * 60)).toBe("noite");
  });
});

describe("limitarComVariedadeDeTurno", () => {
  it("REGRESSÃO: o caso da Milene — a manhã entra na lista", () => {
    // Ordem por proximidade: as 6 primeiras eram todas tarde.
    const ranked = [
      s("13:00"), // 22/09
      s("15:30"),
      s("16:00"),
      s("16:30"),
      s("17:00"),
      s("13:00"), // 23/09
      s("09:00"), // 24/09 — a manhã que ficava de fora
      s("10:30"),
    ];
    const out = limitarComVariedadeDeTurno(ranked, 6, minutos);
    expect(out).toHaveLength(6);
    expect(labels(out)).toContain("09:00");
    // A vaga MAIS próxima nunca é sacrificada.
    expect(out[0]!.label).toBe("13:00");
  });

  it("cede o lugar da vaga MENOS próxima do turno mais repetido", () => {
    const ranked = [s("13:00"), s("14:00"), s("15:00"), s("09:00")];
    const out = limitarComVariedadeDeTurno(ranked, 3, minutos);
    // 15:00 (a última das tardes) sai; 13:00 e 14:00 ficam.
    expect(labels(out)).toEqual(["13:00", "14:00", "09:00"]);
  });

  it("cobre os três turnos quando os três existem", () => {
    const ranked = [s("13:00"), s("13:30"), s("14:00"), s("14:30"), s("19:00"), s("09:00")];
    const out = limitarComVariedadeDeTurno(ranked, 4, minutos);
    const turnos = new Set(out.map((x) => turnoDeMinutos(x.min)));
    expect(turnos).toEqual(new Set(["manha", "tarde", "noite"]));
  });

  it("lista de um turno só não muda nada", () => {
    const ranked = [s("13:00"), s("14:00"), s("15:00"), s("16:00")];
    expect(labels(limitarComVariedadeDeTurno(ranked, 2, minutos))).toEqual(["13:00", "14:00"]);
  });

  it("lista menor que o limite volta inteira, na ordem", () => {
    const ranked = [s("09:00"), s("13:00")];
    expect(labels(limitarComVariedadeDeTurno(ranked, 6, minutos))).toEqual(["09:00", "13:00"]);
    const vazio: { label: string; min: number }[] = [];
    expect(labels(limitarComVariedadeDeTurno(vazio, 6, minutos))).toEqual([]);
  });

  it("não esvazia um turno que tem um único representante", () => {
    // 09:00 é a única manhã e 19:00 a única noite: nenhuma das duas pode ser
    // descartada para dar lugar à outra.
    const ranked = [s("09:00"), s("13:00"), s("14:00"), s("19:00")];
    const out = limitarComVariedadeDeTurno(ranked, 3, minutos);
    const turnos = new Set(out.map((x) => turnoDeMinutos(x.min)));
    expect(turnos).toEqual(new Set(["manha", "tarde", "noite"]));
    expect(labels(out)).toContain("09:00");
    expect(labels(out)).toContain("19:00");
  });

  it("a ordem de proximidade é preservada no que fica", () => {
    const ranked = [s("16:00"), s("15:00"), s("14:00"), s("13:00"), s("10:00")];
    const out = limitarComVariedadeDeTurno(ranked, 3, minutos);
    // Mantém as duas tardes mais próximas na ordem em que vieram.
    expect(labels(out).slice(0, 2)).toEqual(["16:00", "15:00"]);
  });
});
