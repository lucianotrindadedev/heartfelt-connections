// Warm-up: fonte Clinup (GET /consultas/pesquisa) e horário de envio.
import { describe, expect, it } from "vitest";
import {
  CLINUP_WARMUP_SITUACOES,
  clinupLocalStartIso,
  parseClinupPesquisa,
} from "../tools/clinup.server";
import { effectiveWarmupSendAt } from "./send-window";

/** Data a partir de um horário de Brasília, ex.: sp("2026-10-19T14:00"). */
const sp = (s: string) => new Date(`${s}:00-03:00`);

describe("clinupLocalStartIso — o 'Z' da API é horário de Brasília", () => {
  it("monta a partir do dia + hora locais, ignorando o Z", () => {
    expect(clinupLocalStartIso("2026-10-17T00:00:00Z", "09:00:00")).toBe("2026-10-17T09:00:00-03:00");
    // dataInicio "2026-10-17T09:00:00Z" lida como UTC daria 06:00 em Brasília
    expect(new Date(clinupLocalStartIso("2026-10-17T00:00:00Z", "09:00:00")!).toISOString()).toBe(
      "2026-10-17T12:00:00.000Z",
    );
  });
  it("aceita hora com um dígito e sem segundos", () => {
    expect(clinupLocalStartIso("2026-10-19", "8:30")).toBe("2026-10-19T08:30:00-03:00");
  });
  it("dado inválido → null", () => {
    expect(clinupLocalStartIso("", "09:00")).toBeNull();
    expect(clinupLocalStartIso("2026-10-19", "")).toBeNull();
  });
});

describe("parseClinupPesquisa", () => {
  // Formato medido em 17/10/2026 (Implanto Master VN, profissional 1057).
  const consulta = {
    dataInicio: "2026-10-17T08:00:00Z",
    data: "2026-10-17T00:00:00Z",
    hora: "08:00:00",
    dataTexto: "17/10/2026",
    horaTexto: "08:00",
    profissionalId: 1057,
    profissionalNome: "Eduardo Gomes",
    pacienteId: 385374,
    pacienteNome: "Paciente Teste",
    situacao: 3,
    id: 3971282,
  };

  it("lê array cru e envelope {consultas}", () => {
    for (const json of [[consulta], { consultas: [consulta] }]) {
      const [a] = parseClinupPesquisa(json);
      expect(a).toEqual({
        id: "3971282",
        startIso: "2026-10-17T08:00:00-03:00",
        patientId: "385374",
        patientName: "Paciente Teste",
        professionalId: "1057",
        situacao: 3,
      });
    }
  });

  it("descarta consulta sem id, sem paciente ou sem horário", () => {
    expect(parseClinupPesquisa([{ ...consulta, id: undefined }])).toHaveLength(0);
    expect(parseClinupPesquisa([{ ...consulta, pacienteId: undefined }])).toHaveLength(0);
    expect(parseClinupPesquisa([{ ...consulta, hora: "", horaTexto: "" }])).toHaveLength(0);
  });

  it("envelope vazio ({} — o que a API devolve sem filtro válido) → nada", () => {
    expect(parseClinupPesquisa({})).toEqual([]);
    expect(parseClinupPesquisa(null)).toEqual([]);
  });

  it("situações que recebem lembrete são as do n8n: 3, 4 e 5", () => {
    expect([...CLINUP_WARMUP_SITUACOES].sort()).toEqual([3, 4, 5]);
    for (const fora of [1, 6, 7, 8]) expect(CLINUP_WARMUP_SITUACOES.has(fora)).toBe(false);
  });
});

describe("effectiveWarmupSendAt — só envia das 06:00 às 20:00 (Brasília)", () => {
  it("dentro do horário: mantém o momento exato", () => {
    const appt = sp("2026-10-20T14:00");
    expect(effectiveWarmupSendAt(sp("2026-10-19T14:00"), appt)).toEqual(sp("2026-10-19T14:00"));
    expect(effectiveWarmupSendAt(sp("2026-10-20T06:00"), appt)).toEqual(sp("2026-10-20T06:00"));
    expect(effectiveWarmupSendAt(sp("2026-10-20T19:59"), sp("2026-10-20T21:00"))).toEqual(sp("2026-10-20T19:59"));
  });

  it("de madrugada: adia para as 06:00 do mesmo dia", () => {
    // "2h antes" de uma consulta às 08:00 cairia às 06:00 — ok; às 07:00 cairia 05:00 → 06:00
    expect(effectiveWarmupSendAt(sp("2026-10-20T05:00"), sp("2026-10-20T07:00"))).toEqual(sp("2026-10-20T06:00"));
    expect(effectiveWarmupSendAt(sp("2026-10-20T00:30"), sp("2026-10-21T00:30"))).toEqual(sp("2026-10-20T06:00"));
  });

  it("à noite (20:00 em diante): adia para as 06:00 do dia seguinte", () => {
    // "24h antes" de uma consulta às 22:00 → sai às 06:00 do dia da consulta
    expect(effectiveWarmupSendAt(sp("2026-10-19T22:00"), sp("2026-10-20T22:00"))).toEqual(sp("2026-10-20T06:00"));
    expect(effectiveWarmupSendAt(sp("2026-10-19T20:00"), sp("2026-10-21T10:00"))).toEqual(sp("2026-10-20T06:00"));
  });

  it("se a abertura seguinte já é na hora da consulta ou depois, não envia", () => {
    expect(effectiveWarmupSendAt(sp("2026-10-20T04:00"), sp("2026-10-20T06:00"))).toBeNull();
    expect(effectiveWarmupSendAt(sp("2026-10-19T21:00"), sp("2026-10-19T23:00"))).toBeNull();
  });
});
