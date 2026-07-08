import { describe, it, expect } from "vitest";
import {
  classifyBookingError,
  parseBookingFailure,
  isValidationOnlyFailure,
  pruneOfferedSlot,
  buildConflictReply,
  type OfferedSlotLike,
} from "./booking-failure";

describe("classifyBookingError", () => {
  it("trata textos de indisponibilidade como conflito", () => {
    expect(classifyBookingError("HORÁRIO INDISPONÍVEL")).toBe("conflict");
    expect(classifyBookingError("slot ocupado")).toBe("conflict");
    expect(classifyBookingError("esse horário já agendado")).toBe("conflict");
    expect(classifyBookingError("time unavailable")).toBe("conflict");
  });

  it("trata falhas de create/rede como técnicas", () => {
    expect(classifyBookingError("Clinicorp create patient failed: 400")).toBe("technical");
    expect(
      classifyBookingError("Clinicorp: agendamento não confirmado após 2 tentativas"),
    ).toBe("technical");
    expect(classifyBookingError("Não foi possível obter ID do paciente Clinicorp")).toBe(
      "technical",
    );
    expect(classifyBookingError("fetch failed")).toBe("technical");
  });
});

describe("parseBookingFailure", () => {
  it("retorna null quando não é falha", () => {
    expect(parseBookingFailure('{"ok":true,"appointment_id":"123"}')).toBeNull();
    expect(parseBookingFailure(undefined)).toBeNull();
    expect(parseBookingFailure("")).toBeNull();
  });

  it("prioriza error_kind explícito", () => {
    expect(
      parseBookingFailure('{"ok":false,"error":"qualquer","error_kind":"technical"}'),
    ).toEqual({ kind: "technical" });
    expect(
      parseBookingFailure('{"ok":false,"error":"x","error_kind":"conflict"}'),
    ).toEqual({ kind: "conflict" });
  });

  it("infere do texto quando não há error_kind", () => {
    expect(parseBookingFailure('{"ok":false,"error":"HORÁRIO INDISPONÍVEL"}')).toEqual({
      kind: "conflict",
    });
    expect(
      parseBookingFailure('{"ok":false,"error":"Clinicorp create patient failed: 500"}'),
    ).toEqual({ kind: "technical" });
  });

  it("aceita ok:false com espaço", () => {
    expect(parseBookingFailure('{"ok": false, "error": "boom"}')).toEqual({
      kind: "technical",
    });
  });

  it("ignora erros de validação (campo pendente/nome/ausente) — não é create falho", () => {
    expect(
      parseBookingFailure(
        '{"ok":false,"error":"Campos obrigatórios pendentes: cpf","missing":[{"key":"cpf"}]}',
      ),
    ).toBeNull();
    expect(
      parseBookingFailure('{"ok":false,"error":"NOME_INVALIDO","need_valid_name":true}'),
    ).toBeNull();
    expect(parseBookingFailure('{"ok":false,"error":"selected_slot_iso ausente"}')).toBeNull();
    expect(parseBookingFailure('{"ok":false,"error":"telefone ausente"}')).toBeNull();
  });

  it("classifica mesmo validação-like SE houver error_kind explícito", () => {
    // create real que por acaso menciona 'ausente' no corpo do erro Clinicorp
    expect(
      parseBookingFailure(
        '{"ok":false,"error":"Clinicorp create appointment failed: 400 — horario ausente","error_kind":"technical"}',
      ),
    ).toEqual({ kind: "technical" });
  });
});

describe("isValidationOnlyFailure", () => {
  it("true para falhas de validação (caso real 08/07, Maple Bear Osasco — campo obrigatório pendente)", () => {
    expect(
      isValidationOnlyFailure(
        '{"ok":false,"error":"Campos obrigatórios pendentes: child_birth_date","missing":[{"key":"child_birth_date"}]}',
      ),
    ).toBe(true);
    expect(isValidationOnlyFailure('{"ok":false,"error":"NOME_INVALIDO","need_valid_name":true}')).toBe(
      true,
    );
    expect(isValidationOnlyFailure('{"ok":false,"error":"telefone ausente"}')).toBe(true);
  });

  it("false quando é falha real de create (conflito/técnica) ou sucesso", () => {
    expect(isValidationOnlyFailure('{"ok":false,"error":"HORÁRIO INDISPONÍVEL"}')).toBe(false);
    expect(
      isValidationOnlyFailure('{"ok":false,"error":"Clinicorp create appointment failed: 500"}'),
    ).toBe(false);
    expect(isValidationOnlyFailure('{"ok":true,"appointment_id":"123"}')).toBe(false);
  });

  it("false para undefined/vazio", () => {
    expect(isValidationOnlyFailure(undefined)).toBe(false);
    expect(isValidationOnlyFailure(null)).toBe(false);
    expect(isValidationOnlyFailure("")).toBe(false);
  });
});

describe("pruneOfferedSlot", () => {
  const slots: OfferedSlotLike[] = [
    { iso: "2026-07-07T10:00:00-03:00", date_label: "07/07", time_label: "10:00" },
    { iso: "2026-07-07T13:45:00-03:00", date_label: "07/07", time_label: "13:45" },
  ];

  it("remove o slot que falhou", () => {
    const out = pruneOfferedSlot(slots, "2026-07-07T10:00:00-03:00");
    expect(out).toHaveLength(1);
    expect(out[0]!.time_label).toBe("13:45");
  });

  it("nunca re-oferta o slot que falhou (caso real das 10:00)", () => {
    const out = pruneOfferedSlot(slots, "2026-07-07T10:00:00-03:00");
    expect(out.some((s) => s.time_label === "10:00")).toBe(false);
  });

  it("devolve cópia quando failedIso é indefinido", () => {
    const out = pruneOfferedSlot(slots, undefined);
    expect(out).toHaveLength(2);
    expect(out).not.toBe(slots);
  });

  it("lida com lista vazia/indefinida", () => {
    expect(pruneOfferedSlot(undefined, "x")).toEqual([]);
    expect(pruneOfferedSlot([], "x")).toEqual([]);
  });
});

describe("buildConflictReply", () => {
  it("oferece até 2 horários remanescentes", () => {
    const reply = buildConflictReply([
      { iso: "a", date_label: "07/07", time_label: "13:45" },
      { iso: "b", date_label: "07/07", time_label: "15:15" },
      { iso: "c", date_label: "07/07", time_label: "16:00" },
    ]);
    expect(reply).toContain("13:45");
    expect(reply).toContain("15:15");
    expect(reply).not.toContain("16:00");
  });

  it("sem horários remanescentes, promete trazer opções (não re-oferta nada)", () => {
    const reply = buildConflictReply([]);
    expect(reply).toContain("outras opções");
    expect(reply).not.toContain("às ");
  });
});
