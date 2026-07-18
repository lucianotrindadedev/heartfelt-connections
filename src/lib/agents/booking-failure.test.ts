import { describe, it, expect } from "vitest";
import {
  classifyBookingError,
  parseBookingFailure,
  isValidationOnlyFailure,
  pruneOfferedSlot,
  buildConflictReply,
  buildReofferReply,
  claimsBookingConfirmed,
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

  it("ignora HOLDS de guard (intent_hold/slot_not_offered/date_mismatch)", () => {
    // Casos reais 15-16/07 (Gustavo 21 99969-7832, Klaiby 61 98176-3084): o guard
    // segurou o agendamento de propósito e a falta de error_kind conhecido fazia
    // cair na inferência por texto → "technical" → "probleminha técnico" + escalada.
    expect(
      parseBookingFailure(
        '{"ok":false,"error_kind":"intent_hold","error":"O paciente NÃO confirmou claramente marcar em sexta 17/07 às 13:00 (motivo: perguntou se pode confirmar amanhã)."}',
      ),
    ).toBeNull();
    expect(
      parseBookingFailure(
        '{"ok":false,"error_kind":"slot_not_offered","error":"O horário NÃO está na lista de horários realmente disponíveis desta agenda."}',
      ),
    ).toBeNull();
    expect(
      parseBookingFailure(
        '{"ok":false,"error_kind":"date_mismatch","error":"O horário escolhido é do dia 17/07, mas ao lead foi dito 20/07."}',
      ),
    ).toBeNull();
  });

  it("não inventa falha técnica para error_kind desconhecido", () => {
    expect(parseBookingFailure('{"ok":false,"error_kind":"algo_novo","error":"x"}')).toBeNull();
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

describe("claimsBookingConfirmed", () => {
  it("detecta afirmações de agendamento concluído (casos reais Costa Lima 18/07)", () => {
    // Confirmações falsas que passaram pro lead no teste real.
    expect(
      claimsBookingConfirmed("Perfeito! Sua consulta ficou agendada para segunda-feira, 21 de julho às 10:00."),
    ).toBe(true);
    expect(
      claimsBookingConfirmed("Perfeito, Luciano! Seu agendamento foi concluído com sucesso. Data: segunda-feira"),
    ).toBe(true);
    expect(claimsBookingConfirmed("Pronto, seu horário está confirmado!")).toBe(true);
    expect(claimsBookingConfirmed("Reservado com sucesso para amanhã às 9h.")).toBe(true);
    expect(claimsBookingConfirmed("Seu agendamento foi registrado 😊")).toBe(true);
  });

  it("NÃO dispara em ofertas, perguntas ou intenções (evita falso positivo)", () => {
    expect(claimsBookingConfirmed("Posso já deixar seu horário agendado pra você?")).toBe(false);
    expect(claimsBookingConfirmed("Quer que eu marque esse horário?")).toBe(false);
    expect(claimsBookingConfirmed("Vou confirmar sua reserva agora, tá?")).toBe(false);
    expect(claimsBookingConfirmed("Consigo te encaixar segunda às 10h ou terça às 14h. Qual prefere?")).toBe(false);
    expect(claimsBookingConfirmed("")).toBe(false);
    expect(claimsBookingConfirmed(null)).toBe(false);
  });
});

describe("buildReofferReply", () => {
  it("reoferta até 2 horários reais sem dizer 'indisponível'", () => {
    const reply = buildReofferReply([
      { iso: "a", date_label: "quarta-feira, 22/07", time_label: "09:00" },
      { iso: "b", date_label: "quinta-feira, 23/07", time_label: "10:30" },
      { iso: "c", date_label: "quinta-feira, 23/07", time_label: "11:15" },
    ]);
    expect(reply).toContain("09:00");
    expect(reply).toContain("10:30");
    expect(reply).not.toContain("11:15");
    expect(reply.toLowerCase()).not.toContain("indispon");
  });

  it("sem horários, promete confirmar a agenda (não inventa horário)", () => {
    const reply = buildReofferReply([]);
    expect(reply.toLowerCase()).toContain("agenda");
    expect(reply).not.toContain("às ");
  });
});
