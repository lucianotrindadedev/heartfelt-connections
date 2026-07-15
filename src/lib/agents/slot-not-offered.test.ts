import { describe, it, expect } from "vitest";
import { isSlotNotOffered } from "./scheduler.server";

// Trava de horário fantasma: o horário a agendar TEM que ser um dos que a busca
// ofereceu. Caso real (Costa Lima Recreio, Osiane 21 96678-6864): ofertou a
// tarde (17/07 13:00), a lead pediu manhã, offered_slots virou os da manhã, mas
// selected_slot_iso ficou preso em 13:00 → o create tentava marcar 13:00.
describe("isSlotNotOffered", () => {
  const manha = [
    { iso: "2026-07-17T09:45:00-03:00" },
    { iso: "2026-07-17T10:30:00-03:00" },
    { iso: "2026-07-17T11:15:00-03:00" },
  ];

  it("bloqueia o slot velho da tarde que sobrou (13:00) — caso Osiane", () => {
    expect(isSlotNotOffered("2026-07-17T13:00:00-03:00", manha)).toBe(true);
  });

  it("bloqueia um horário fantasma que não existe nos ofertados (09:30)", () => {
    expect(isSlotNotOffered("2026-07-17T09:30:00-03:00", manha)).toBe(true);
  });

  it("permite quando o slot escolhido está entre os ofertados", () => {
    expect(isSlotNotOffered("2026-07-17T10:30:00-03:00", manha)).toBe(false);
  });

  it("não valida (permite) quando não há offered_slots — deixa outros guards agir", () => {
    expect(isSlotNotOffered("2026-07-17T10:30:00-03:00", [])).toBe(false);
  });

  it("vazio/nulo → não bloqueia (outro guard trata 'selected ausente')", () => {
    expect(isSlotNotOffered("", manha)).toBe(false);
    expect(isSlotNotOffered(null, manha)).toBe(false);
    expect(isSlotNotOffered(undefined, manha)).toBe(false);
  });
});
