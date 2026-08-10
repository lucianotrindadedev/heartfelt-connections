// Atendimento programado — janelas em que o agente fica CALADO.
//
// Semântica (decidida com o usuário): a janela marcada é o horário da EQUIPE
// HUMANA; nela a IA não responde. Fora dela — noite, fim de semana, dias
// desativados e o ALMOÇO — a IA responde.

import { describe, expect, it } from "vitest";

import { isAgentMutedNow, parseScheduleMode } from "./agent-schedule";

// Seg–Sex 08:00–18:00 com almoço 12:00–13:00; sáb/dom desativados.
// (formato exato emitido pelo BusinessHoursEditor)
const COMERCIAL = JSON.stringify({
  dom: { active: false, start: "08:00", lunch_start: "12:00", lunch_end: "13:00", end: "18:00" },
  seg: { active: true, start: "08:00", lunch_start: "12:00", lunch_end: "13:00", end: "18:00" },
  ter: { active: true, start: "08:00", lunch_start: "12:00", lunch_end: "13:00", end: "18:00" },
  qua: { active: true, start: "08:00", lunch_start: "12:00", lunch_end: "13:00", end: "18:00" },
  qui: { active: true, start: "08:00", lunch_start: "12:00", lunch_end: "13:00", end: "18:00" },
  sex: { active: true, start: "08:00", lunch_start: "12:00", lunch_end: "13:00", end: "18:00" },
  sab: { active: false, start: "08:00", lunch_start: "", lunch_end: "", end: "13:00" },
});

const scheduled = (json = COMERCIAL) => ({
  schedule_mode: "scheduled",
  schedule_silence_json: json,
});

/** Instante em BRT (offset -03:00) — independe do fuso do runner. */
const brt = (isoLocal: string) => new Date(`${isoLocal}-03:00`);

// 2026-08-10 = segunda-feira; 2026-08-15 = sábado; 2026-08-16 = domingo.
describe("isAgentMutedNow — dia útil", () => {
  it("dentro da janela da equipe → CALADO", () => {
    expect(isAgentMutedNow(scheduled(), brt("2026-08-10T09:00:00"))).toBe(true);
    expect(isAgentMutedNow(scheduled(), brt("2026-08-10T11:59:00"))).toBe(true);
    expect(isAgentMutedNow(scheduled(), brt("2026-08-10T17:59:00"))).toBe(true);
  });

  it("no ALMOÇO → responde (equipe fora, IA cobre)", () => {
    expect(isAgentMutedNow(scheduled(), brt("2026-08-10T12:00:00"))).toBe(false);
    expect(isAgentMutedNow(scheduled(), brt("2026-08-10T12:30:00"))).toBe(false);
    expect(isAgentMutedNow(scheduled(), brt("2026-08-10T12:59:00"))).toBe(false);
  });

  it("antes de abrir e depois de fechar → responde", () => {
    expect(isAgentMutedNow(scheduled(), brt("2026-08-10T07:59:00"))).toBe(false);
    expect(isAgentMutedNow(scheduled(), brt("2026-08-10T18:00:00"))).toBe(false); // [ini,fim)
    expect(isAgentMutedNow(scheduled(), brt("2026-08-10T22:00:00"))).toBe(false);
  });

  it("bordas: 08:00 em ponto silencia; 13:00 em ponto volta a silenciar", () => {
    expect(isAgentMutedNow(scheduled(), brt("2026-08-10T08:00:00"))).toBe(true);
    expect(isAgentMutedNow(scheduled(), brt("2026-08-10T13:00:00"))).toBe(true);
  });
});

describe("isAgentMutedNow — dias desativados", () => {
  it("sábado e domingo → responde o dia inteiro", () => {
    expect(isAgentMutedNow(scheduled(), brt("2026-08-15T10:00:00"))).toBe(false);
    expect(isAgentMutedNow(scheduled(), brt("2026-08-16T10:00:00"))).toBe(false);
  });
});

describe("isAgentMutedNow — fail-open (na dúvida, responde)", () => {
  it("modo 24h ignora a tabela", () => {
    expect(
      isAgentMutedNow({ schedule_mode: "24h", schedule_silence_json: COMERCIAL }, brt("2026-08-10T09:00:00")),
    ).toBe(false);
  });

  it("sem settings / sem json / json inválido", () => {
    expect(isAgentMutedNow(null, brt("2026-08-10T09:00:00"))).toBe(false);
    expect(isAgentMutedNow({}, brt("2026-08-10T09:00:00"))).toBe(false);
    expect(isAgentMutedNow({ schedule_mode: "scheduled" }, brt("2026-08-10T09:00:00"))).toBe(false);
    expect(
      isAgentMutedNow({ schedule_mode: "scheduled", schedule_silence_json: "{{{" }, brt("2026-08-10T09:00:00")),
    ).toBe(false);
  });

  it("janela invertida/vazia não silencia", () => {
    const ruim = JSON.stringify({
      seg: { active: true, start: "18:00", lunch_start: "", lunch_end: "", end: "08:00" },
    });
    expect(isAgentMutedNow(scheduled(ruim), brt("2026-08-10T09:00:00"))).toBe(false);
  });
});

describe("parseScheduleMode", () => {
  it("default 24h; só 'scheduled' liga", () => {
    expect(parseScheduleMode(undefined)).toBe("24h");
    expect(parseScheduleMode("")).toBe("24h");
    expect(parseScheduleMode("qualquer")).toBe("24h");
    expect(parseScheduleMode("scheduled")).toBe("scheduled");
    expect(parseScheduleMode("  SCHEDULED ")).toBe("scheduled");
  });
});
