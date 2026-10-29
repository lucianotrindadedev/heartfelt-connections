// Remarcação reserva o NOVO antes de cancelar o ANTIGO. Caso real (Sorriso
// Saude, 29/10): remarcar cancelava na hora; o novo nunca foi criado e o
// paciente ficou sem horário nenhum.
import { describe, expect, it } from "vitest";

import { stripLlmForbiddenFields } from "./lead-patch-guard";
import { execManterAgendamento, patchInicioRemarcacao, remarcacaoACancelar } from "./scheduler.server";
import type { LeadData } from "./stage";

const agendado: LeadData = {
  name: "Paciente Teste",
  appointment_id: 987654321,
  booked_slot_iso: "2026-10-30T09:00:00-03:00",
  selected_slot_iso: "2026-10-30T09:00:00-03:00",
  booked_tag_applied: true,
  selected_agenda: "Unidade A",
};

describe("início da remarcação", () => {
  it("guarda o agendamento atual em remarcar_de_* e reabre a oferta, sem cancelar", () => {
    const p = patchInicioRemarcacao(agendado);
    expect(p.remarcar_de_id).toBe("987654321");
    expect(p.remarcar_de_slot).toBe("2026-10-30T09:00:00-03:00");
    expect(p.remarcar_de_agenda).toBe("Unidade A");
    expect(p.appointment_cancelled).toBe(true); // o orquestrador tira o id do lead_data
    expect(p.reoffer_after_cancel).toBe(true);
    expect(p.selected_slot_iso).toBe("");
    expect(p.offered_slots).toEqual([]);
  });

  it("remarcação já pendente (sem appointment_id): só reabre a oferta, não sobrescreve o antigo", () => {
    const p = patchInicioRemarcacao({ name: "X", remarcar_de_id: "111", remarcar_de_slot: "2026-10-30T09:00:00-03:00" });
    expect(p.remarcar_de_id).toBeUndefined();
    expect(p.appointment_cancelled).toBeUndefined();
    expect(p.selected_slot_iso).toBe("");
  });
});

describe("cancelamento do antigo só depois do novo", () => {
  it("criação com sucesso e remarcação pendente → cancela o antigo", () => {
    expect(remarcacaoACancelar({ remarcar_de_id: "111" }, { appointment_id: 222 })).toBe("111");
  });

  it("criação falhou (sem appointment_id) → não cancela nada", () => {
    expect(remarcacaoACancelar({ remarcar_de_id: "111" }, undefined)).toBeNull();
    expect(remarcacaoACancelar({ remarcar_de_id: "111" }, {})).toBeNull();
  });

  it("sem remarcação pendente, ou o 'novo' é o próprio antigo → não cancela", () => {
    expect(remarcacaoACancelar({}, { appointment_id: 222 })).toBeNull();
    expect(remarcacaoACancelar({ remarcar_de_id: "" }, { appointment_id: 222 })).toBeNull();
    expect(remarcacaoACancelar({ remarcar_de_id: "111" }, { appointment_id: 111 })).toBeNull();
  });
});

describe("manter_agendamento (lead desistiu de trocar)", () => {
  it("restaura o agendamento original e limpa a remarcação", () => {
    const out = execManterAgendamento({
      leadData: {
        name: "X",
        remarcar_de_id: "987654321",
        remarcar_de_slot: "2026-10-30T09:00:00-03:00",
        remarcar_de_agenda: "Unidade A",
      },
    });
    expect(JSON.parse(out.result).ok).toBe(true);
    expect(out.patch?.appointment_id).toBe(987654321);
    expect(out.patch?.booked_slot_iso).toBe("2026-10-30T09:00:00-03:00");
    expect(out.patch?.selected_agenda).toBe("Unidade A");
    expect(out.patch?.remarcar_de_id).toBe("");
  });

  it("id não numérico (Google Calendar / Clinic Experts) volta como texto", () => {
    const out = execManterAgendamento({ leadData: { remarcar_de_id: "evt_abc123" } });
    expect(out.patch?.appointment_id).toBe("evt_abc123");
  });

  it("sem remarcação pendente → erro, nada muda", () => {
    const out = execManterAgendamento({ leadData: {} });
    expect(JSON.parse(out.result).ok).toBe(false);
    expect(out.patch).toBeUndefined();
  });
});

describe("o modelo não forja a remarcação", () => {
  it("remarcar_de_* saem do lead_data_patch do LLM", () => {
    const limpo = stripLlmForbiddenFields({ remarcar_de_id: "999", remarcar_de_slot: "x", name: "Y" } as Partial<LeadData>);
    expect(limpo).toEqual({ name: "Y" });
  });
});

