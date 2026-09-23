// Oferta fixa "1ª vaga da manhã + 1ª vaga da tarde" (settings.oferta_primeiro_manha_tarde).
// Caso real (Odonto Sorrisos, 87 99136-6644, 23/09/2026): com 6 vagas em mãos o
// modelo ofertou "08:00 da manhã / 18:00 à noite", os extremos do dia.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { primeiroDaManhaEDaTarde } from "@/lib/booking-template";

const listClinicorpSlots = vi.fn();
vi.mock("@/lib/tools/clinicorp.server", async (orig) => ({
  ...(await orig<typeof import("@/lib/tools/clinicorp.server")>()),
  listClinicorpSlots: (...a: unknown[]) => listClinicorpSlots(...a),
}));

const { execListarHorarios } = await import("@/lib/agents/scheduler.server");

// Expediente da Odonto Sorrisos: Seg–Sex 08–19 com almoço 12–13, Sáb 08–13.
const EXPEDIENTE = JSON.stringify({
  dom: { active: false, start: "08:00", lunch_start: "12:00", lunch_end: "13:00", end: "18:00" },
  seg: { active: true, start: "08:00", lunch_start: "12:00", lunch_end: "13:00", end: "19:00" },
  ter: { active: true, start: "08:00", lunch_start: "12:00", lunch_end: "13:00", end: "19:00" },
  qua: { active: true, start: "08:00", lunch_start: "12:00", lunch_end: "13:00", end: "19:00" },
  qui: { active: true, start: "08:00", lunch_start: "12:00", lunch_end: "13:00", end: "19:00" },
  sex: { active: true, start: "08:00", lunch_start: "12:00", lunch_end: "13:00", end: "19:00" },
  sab: { active: true, start: "08:00", lunch_start: "", lunch_end: "", end: "13:00" },
});

/** Slots de 15 min do Dentista Avaliador nos horários dados. */
function grade(date: string, horas: string[]) {
  return horas.map((h) => {
    const [hh, mm] = h.split(":").map(Number) as [number, number];
    const fim = hh * 60 + mm + 15;
    const to = `${String(Math.floor(fim / 60)).padStart(2, "0")}:${String(fim % 60).padStart(2, "0")}`;
    return {
      localDate: date,
      fromTime: h,
      toTime: to,
      start: `${date}T${h}:00-03:00`,
      end: `${date}T${to}:00-03:00`,
      dentistPersonId: 5439082296508417,
    };
  });
}

function ctx(settings: Record<string, string>, history: { role: "user" | "assistant"; content: string }[] = []) {
  return {
    accountId: "acc",
    agentId: "ag",
    conversationId: "conv-teste",
    stage: "QUALIFICATION",
    leadData: {},
    channel: "whatsapp",
    agentSettings: { business_hours_json: EXPEDIENTE, ...settings },
    history,
    integrations: { clinicorp: true, clinup: false, googleCalendar: false, clinicExperts: false, escalation: false },
    googleAgendas: [],
    clinicExpertsProfessionals: [],
  } as never;
}

async function listar(c: never, dataAlvo?: string) {
  const out = JSON.parse((await execListarHorarios(c, undefined, undefined, dataAlvo)).result) as {
    slots: { date_label: string; time_label: string }[];
    instrucao_oferta?: string;
  };
  return out;
}

const SEGUNDA = grade("2099-09-28", [
  "08:00", "08:15", "08:30", "12:00", "12:15", "12:45", "13:00", "13:15", "17:30", "17:45",
]);

describe("primeiroDaManhaEDaTarde", () => {
  const min = (s: { fromTime: string }) => {
    const [h, m] = s.fromTime.split(":").map(Number) as [number, number];
    return h * 60 + m;
  };
  it("pula o almoço: a tarde começa no fim do almoço, não às 12:00", () => {
    const par = primeiroDaManhaEDaTarde(SEGUNDA, min, () => ({ inicio: 720, fim: 780 }));
    expect(par?.map((s) => s.fromTime)).toEqual(["08:00", "13:00"]);
  });
  it("sem almoço cadastrado, a divisa é 12:00", () => {
    const par = primeiroDaManhaEDaTarde(SEGUNDA, min, () => null);
    expect(par?.map((s) => s.fromTime)).toEqual(["08:00", "12:00"]);
  });
  it("turnos em dias diferentes: o mais próximo de cada um", () => {
    const slots = [...grade("2099-09-24", ["15:00", "16:00"]), ...grade("2099-09-25", ["08:00", "13:00"])];
    const par = primeiroDaManhaEDaTarde(slots, min, () => ({ inicio: 720, fim: 780 }));
    expect(par?.map((s) => `${s.localDate} ${s.fromTime}`)).toEqual(["2099-09-24 15:00", "2099-09-25 08:00"]);
  });
  it("falta um turno → null (segue a lista normal)", () => {
    expect(primeiroDaManhaEDaTarde(grade("2099-09-26", ["08:00", "09:00"]), min, () => null)).toBeNull();
  });
});

describe("execListarHorarios (Clinicorp) com oferta_primeiro_manha_tarde", () => {
  beforeEach(() => {
    listClinicorpSlots.mockReset();
    listClinicorpSlots.mockResolvedValue({ slots: SEGUNDA, failedDates: [], busyCheckFailed: false });
  });

  it("devolve só a 1ª da manhã e a 1ª da tarde, com a instrução de ofertar as duas", async () => {
    const out = await listar(ctx({ oferta_primeiro_manha_tarde: "true" }), "2099-09-28");
    expect(out.slots.map((s) => s.time_label)).toEqual(["08:00", "13:00"]);
    expect(out.instrucao_oferta).toMatch(/EXATAMENTE/);
  });

  it("sem a configuração, nada muda (lista de 6 com variedade de turno)", async () => {
    const out = await listar(ctx({}), "2099-09-28");
    expect(out.slots.length).toBe(6);
    expect(out.instrucao_oferta).toBeUndefined();
  });

  it("lead pediu turno: vale o pedido, não o par fixo", async () => {
    const out = await listar(
      ctx({ oferta_primeiro_manha_tarde: "true" }, [{ role: "user", content: "prefiro à tarde" }]),
      "2099-09-28",
    );
    expect(out.instrucao_oferta).toBeUndefined();
    expect(out.slots.every((s) => Number(s.time_label.slice(0, 2)) >= 12)).toBe(true);
  });

  it("lead pediu hora exata: vale o pedido, não o par fixo", async () => {
    const out = await listar(
      ctx({ oferta_primeiro_manha_tarde: "true" }, [{ role: "user", content: "consegue 17h?" }]),
      "2099-09-28",
    );
    expect(out.instrucao_oferta).toBeUndefined();
    expect(out.slots.map((s) => s.time_label)).toContain("17:30");
  });
});
