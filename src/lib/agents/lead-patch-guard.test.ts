import { describe, it, expect } from "vitest";
import { stripLlmForbiddenFields, LLM_FORBIDDEN_LEAD_FIELDS } from "./lead-patch-guard";

describe("stripLlmForbiddenFields", () => {
  it("remove appointment_id forjado pelo LLM (caso 21 97558-2703)", () => {
    const out = stripLlmForbiddenFields({
      name: "Neymar Jr",
      appointment_id: "remarcado_09_07",
      selected_slot_iso: "2026-07-09T09:00:00-03:00",
    });
    expect(out).toEqual({
      name: "Neymar Jr",
    });
  });

  it("remove selected_slot_iso/dentist_person_id forjados pelo LLM (caso Clínica Bomfim 09/07)", () => {
    const out = stripLlmForbiddenFields({
      name: "Julio Cesar Lima",
      selected_slot_iso: "2026-07-09T15:00:00-03:00",
      dentist_person_id: 4906629197725697,
    });
    expect(out).toEqual({ name: "Julio Cesar Lima" });
  });

  it("remove todos os campos controlados pelo sistema", () => {
    const patch: Record<string, unknown> = {
      name: "Ana",
      custom_fields: { cpf: "123" },
    };
    for (const k of LLM_FORBIDDEN_LEAD_FIELDS) patch[k] = "forjado";
    const out = stripLlmForbiddenFields(patch);
    for (const k of LLM_FORBIDDEN_LEAD_FIELDS) expect(k in out).toBe(false);
    // campos legítimos do LLM permanecem
    expect(out.name).toBe("Ana");
    expect(out.custom_fields).toEqual({ cpf: "123" });
  });

  it("não altera patch sem campos proibidos", () => {
    const patch = { name: "Ana", interest: "IMPLANTE", notes: "quer avaliação" };
    expect(stripLlmForbiddenFields(patch)).toEqual(patch);
  });

  it("não muta o objeto original", () => {
    const patch = { name: "Ana", appointment_id: "fake" };
    const out = stripLlmForbiddenFields(patch);
    expect(patch.appointment_id).toBe("fake"); // original intacto
    expect("appointment_id" in out).toBe(false);
  });
});
