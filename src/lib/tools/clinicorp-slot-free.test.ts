import { describe, it, expect } from "vitest";
import { isSlotFreeAgainstBusy } from "./clinicorp.server";

// Cross-check: a agenda online do Clinicorp devolve horários "livres" que já têm
// consulta marcada; só ofertamos o que está de fato livre. Dados reais (Costa
// Lima Recreio, 17/07, profissional 5120441025822721, consulta de 40min).
const busy = [
  { localDate: "2026-07-17", professionalId: 5120441025822721, fromMin: 9 * 60, toMin: 9 * 60 + 45 }, // 09:00-09:45 Rodrigo
  { localDate: "2026-07-17", professionalId: 5120441025822721, fromMin: 9 * 60 + 45, toMin: 10 * 60 }, // 09:45-10:00 Maria
  { localDate: "2026-07-17", professionalId: 5120441025822721, fromMin: 10 * 60 + 15, toMin: 10 * 60 + 30 }, // 10:15-10:30 Geisa
  { localDate: "2026-07-17", professionalId: 5120441025822721, fromMin: 11 * 60, toMin: 11 * 60 + 15 }, // 11:00-11:15 Marinalva
];
const DUR = 40;
const slot = (fromTime: string) => ({ localDate: "2026-07-17", fromTime, dentistPersonId: 5120441025822721 });

describe("isSlotFreeAgainstBusy", () => {
  it("09:45 (colide com Maria 09:45-10:00) → OCUPADO", () => {
    expect(isSlotFreeAgainstBusy(slot("9:45"), DUR, busy)).toBe(false);
  });
  it("10:30 (09:45-... na verdade 10:30-11:10 colide com nada aqui) e 11:15 livre", () => {
    // 11:15-11:55 não colide com Marinalva (11:00-11:15, adjacente) → LIVRE
    expect(isSlotFreeAgainstBusy(slot("11:15"), DUR, busy)).toBe(true);
  });
  it("13:00 (tarde, sem nada marcado) → LIVRE", () => {
    expect(isSlotFreeAgainstBusy(slot("13:00"), DUR, busy)).toBe(true);
  });
  it("agendamento ADJACENTE não conflita (09:00-09:45 não bloqueia um slot que começa 09:45+? não — 09:45 colide com Maria). Testa 09:45 sem a Maria:", () => {
    const soRodrigo = [busy[0]!];
    // 09:45-10:25 vs Rodrigo 09:00-09:45: adjacentes (09:45 não é < 09:45) → LIVRE
    expect(isSlotFreeAgainstBusy(slot("9:45"), DUR, soRodrigo)).toBe(true);
  });
  it("profissional DIFERENTE não conflita", () => {
    const outroProf = [{ localDate: "2026-07-17", professionalId: 999, fromMin: 13 * 60, toMin: 13 * 60 + 40 }];
    expect(isSlotFreeAgainstBusy(slot("13:00"), DUR, outroProf)).toBe(true);
  });
  it("sem agendamentos → tudo livre", () => {
    expect(isSlotFreeAgainstBusy(slot("9:45"), DUR, [])).toBe(true);
  });
});
