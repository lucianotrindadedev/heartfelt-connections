import { describe, it, expect } from "vitest";
import { mergeLeadDataPatch } from "@/lib/booking-template";
import { stripNullishFields } from "./parse-llm-json.server";
import type { LeadData } from "./stage";

// O orquestrador faz: stripNullishFields(patch) → mergeLeadDataPatch(leadData, patch).
// Reproduz esse caminho para provar que zerar com `undefined` NÃO persiste (o
// bug real da Silvia 12 97407-5229: o guard "limpou" o slot mas o lead_data
// gravado seguiu com selected_slot_iso=2026-07-16T16:00 e o agente reafirmou o
// dia que ela tinha acabado de recusar).
const persistir = (atual: LeadData, patch: Partial<LeadData>): LeadData =>
  mergeLeadDataPatch(atual, stripNullishFields(patch as Record<string, unknown>) as Partial<LeadData>);

const leadData = (): LeadData =>
  ({
    name: "Silvia Regina de Moura",
    selected_slot_iso: "2026-07-16T16:00:00-03:00",
    offered_slots: [
      { iso: "2026-07-17T13:00:00-03:00", date_label: "sexta-feira, 17/07", time_label: "13:00" },
    ],
  }) as LeadData;

describe("limpar selected_slot_iso sobrevive ao stripNullishFields", () => {
  it("undefined NÃO limpa (o bug): o slot recusado sobrevive no lead_data", () => {
    const out = persistir(leadData(), { selected_slot_iso: undefined });
    expect(out.selected_slot_iso).toBe("2026-07-16T16:00:00-03:00");
  });

  it('"" limpa de verdade e persiste', () => {
    const out = persistir(leadData(), { selected_slot_iso: "" });
    expect(out.selected_slot_iso).toBe("");
  });

  it('"" é falsy nos checks a jusante (tratado como "sem escolha")', () => {
    const out = persistir(leadData(), { selected_slot_iso: "" });
    expect(!out.selected_slot_iso).toBe(true);
    expect((out.selected_slot_iso ?? "").trim()).toBe("");
  });

  it("offered_slots: undefined NÃO limpa; [] limpa", () => {
    expect(persistir(leadData(), { offered_slots: undefined }).offered_slots).toHaveLength(1);
    expect(persistir(leadData(), { offered_slots: [] }).offered_slots).toHaveLength(0);
  });
});
