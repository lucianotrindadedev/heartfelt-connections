import { describe, it, expect } from "vitest";
import { filterSlotsByClosing } from "./clinicorp.server";

// A consulta INTEIRA (fromTime + duração) precisa caber antes do fim do
// expediente — o fim da última janela da grade daquele dia/profissional. Dados
// reais (Odonto Carioca/occampogrande, 16/07): a última janela era 17:15-17:30,
// e um slot de 17:15 com consulta de 40min (→17:55) era ofertado indevidamente.
const P = 6365110001467392;
const win = (fromTime: string, toTime: string, dentistPersonId = P) => ({
  localDate: "2026-07-16",
  fromTime,
  toTime,
  dentistPersonId,
});
const DUR = 40;

describe("filterSlotsByClosing", () => {
  it("derruba o slot cuja consulta passa do fim da última janela (17:15 → 17:55, fecha 17:30)", () => {
    const slots = [
      win("16:30", "16:45"),
      win("16:45", "17:00"),
      win("17:00", "17:15"),
      win("17:15", "17:30"), // última janela → fechamento 17:30
    ];
    const kept = filterSlotsByClosing(slots, DUR).map((s) => s.fromTime);
    // 16:50 caberia (17:30), mas o último fromTime que cabe aqui é 16:45 (→17:25);
    // 17:00 (→17:40) e 17:15 (→17:55) passam de 17:30.
    expect(kept).toEqual(["16:30", "16:45"]);
  });

  it("mantém slots do meio do dia mesmo com buraco depois (buraco = agendamento, não fechamento)", () => {
    // 13:15 tem grade só até 17:30; 13:15→13:55 cabe folgado. Não derruba por
    // causa de um buraco às 13:30 (isso é tarefa do cross-check de ocupados).
    const slots = [
      win("13:15", "13:30"),
      // 13:30-13:45 ausente (ocupado)
      win("13:45", "14:00"),
      win("17:15", "17:30"),
    ];
    const kept = filterSlotsByClosing(slots, DUR).map((s) => s.fromTime);
    expect(kept).toContain("13:15");
    expect(kept).toContain("13:45");
  });

  it("fecha por profissional: o expediente de um não corta o slot do outro", () => {
    const A = 1,
      B = 2;
    const slots = [
      win("11:30", "11:45", A), // A fecha 12:00 → 11:30+40=12:10 NÃO cabe
      win("11:45", "12:00", A),
      win("11:30", "11:45", B), // B fecha 18:00 → 11:30 cabe
      win("11:45", "12:00", B),
      win("17:45", "18:00", B),
    ];
    const kept = filterSlotsByClosing(slots, DUR);
    expect(kept.some((s) => s.fromTime === "11:30" && s.dentistPersonId === A)).toBe(false);
    expect(kept.some((s) => s.fromTime === "11:30" && s.dentistPersonId === B)).toBe(true);
  });

  it("duração que cabe exatamente no fechamento é mantida (16:50 → 17:30 = fecha 17:30)", () => {
    const slots = [win("16:50", "17:05"), win("17:15", "17:30")];
    const kept = filterSlotsByClosing(slots, DUR).map((s) => s.fromTime);
    expect(kept).toContain("16:50"); // 16:50+40=17:30 <= 17:30
    expect(kept).not.toContain("17:15"); // 17:15+40=17:55 > 17:30
  });
});
