import { describe, expect, it } from "vitest";
import {
  agentNeedsStaleConversations,
  isAllowedNow,
  planFollowupStep,
  type PlanStep,
} from "./followup-plan";

const ALL_DAYS = ["dom", "seg", "ter", "qua", "qui", "sex", "sab"];

function step(over: Partial<PlanStep> & { id: string; ordem: number }): PlanStep {
  return {
    delay_value: 60,
    delay_unit: "minutes",
    window_start_hour: 8,
    window_end_hour: 20,
    allowed_days: ALL_DAYS,
    helena_template_name: null,
    ...over,
  };
}

// Mesma config da Sorriso Saúde: 60 min e depois 5 h, 8h–20h todo dia.
const STEPS = [
  step({ id: "s1", ordem: 1 }),
  step({ id: "s2", ordem: 2, delay_value: 5, delay_unit: "hours" }),
];

// 17/09/2026 14:00 em São Paulo (17:00 UTC).
const NOW = new Date("2026-09-17T17:00:00Z");
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000);

describe("planFollowupStep", () => {
  it("lead que sumiu há 90 min depois da 1ª resposta da IA recebe o step 1", () => {
    const d = planFollowupStep({
      steps: STEPS,
      sentInCycle: [],
      lastMsgAt: minutesAgo(90),
      cycleStartAt: minutesAgo(91),
      now: NOW,
    });
    expect(d).toMatchObject({ kind: "send_text", step: { id: "s1" } });
  });

  it("espera o delay do step 1", () => {
    const d = planFollowupStep({
      steps: STEPS,
      sentInCycle: [],
      lastMsgAt: minutesAgo(30),
      cycleStartAt: minutesAgo(31),
      now: NOW,
    });
    expect(d.kind).toBe("wait");
  });

  it("step 2 conta o delay a partir do envio do step 1", () => {
    const base = {
      steps: STEPS,
      lastMsgAt: minutesAgo(400),
      cycleStartAt: minutesAgo(401),
      now: NOW,
    };
    expect(
      planFollowupStep({ ...base, sentInCycle: [{ step_id: "s1", sent_at: minutesAgo(120).toISOString() }] }),
    ).toMatchObject({ kind: "wait", step: { id: "s2" } });
    expect(
      planFollowupStep({ ...base, sentInCycle: [{ step_id: "s1", sent_at: minutesAgo(301).toISOString() }] }),
    ).toMatchObject({ kind: "send_text", step: { id: "s2" } });
  });

  it("sequência inteira enviada no ciclo → done", () => {
    const d = planFollowupStep({
      steps: STEPS,
      sentInCycle: [
        { step_id: "s1", sent_at: minutesAgo(400).toISOString() },
        { step_id: "s2", sent_at: minutesAgo(60).toISOString() },
      ],
      lastMsgAt: minutesAgo(500),
      cycleStartAt: minutesAgo(501),
      now: NOW,
    });
    expect(d.kind).toBe("done");
  });

  it("fora do horário permitido não envia", () => {
    // 23:00 em São Paulo
    const late = new Date("2026-09-18T02:00:00Z");
    const d = planFollowupStep({
      steps: STEPS,
      sentInCycle: [],
      lastMsgAt: new Date(late.getTime() - 90 * 60_000),
      cycleStartAt: new Date(late.getTime() - 91 * 60_000),
      now: late,
    });
    expect(d.kind).toBe("closed_hours");
  });

  it("conversa antiga fora das 24h e sem template é descartada (não pode gastar cota)", () => {
    // Caso real: conversas de 30/06 esgotavam os 10 envios de todo tick.
    const d = planFollowupStep({
      steps: STEPS,
      sentInCycle: [],
      lastMsgAt: new Date("2026-06-30T15:00:00Z"),
      cycleStartAt: new Date("2026-06-30T14:59:00Z"),
      now: NOW,
    });
    expect(d.kind).toBe("skip_no_template");
  });

  it("lead que nunca respondeu (ciclo desde epoch) conta como fora das 24h", () => {
    const d = planFollowupStep({
      steps: STEPS,
      sentInCycle: [],
      lastMsgAt: minutesAgo(90),
      cycleStartAt: new Date(0),
      now: NOW,
    });
    expect(d.kind).toBe("skip_no_template");
  });

  it("fora das 24h com template configurado envia o template", () => {
    const withTpl = [step({ id: "t1", ordem: 1, helena_template_name: " retomada " })];
    const d = planFollowupStep({
      steps: withTpl,
      sentInCycle: [],
      lastMsgAt: minutesAgo(3000),
      cycleStartAt: minutesAgo(3001),
      now: NOW,
    });
    expect(d).toMatchObject({ kind: "send_template", templateName: "retomada" });
  });
});

describe("isAllowedNow", () => {
  it("usa o horário de São Paulo", () => {
    // 10:59 UTC = 07:59 SP → fechado; 11:01 UTC = 08:01 SP → aberto
    expect(isAllowedNow(8, 20, ALL_DAYS, new Date("2026-09-17T10:59:00Z"))).toBe(false);
    expect(isAllowedNow(8, 20, ALL_DAYS, new Date("2026-09-17T11:01:00Z"))).toBe(true);
  });

  it("meia-noite em SP conta como hora 0", () => {
    expect(isAllowedNow(0, 6, ALL_DAYS, new Date("2026-09-18T03:30:00Z"))).toBe(true);
  });

  it("respeita os dias permitidos", () => {
    // 17/09/2026 é quinta-feira
    expect(isAllowedNow(null, null, ["seg"], NOW)).toBe(false);
    expect(isAllowedNow(null, null, ["qui"], NOW)).toBe(true);
  });
});

describe("agentNeedsStaleConversations", () => {
  it("só precisa varrer conversas paradas quando algum step tem template", () => {
    expect(agentNeedsStaleConversations(STEPS)).toBe(false);
    expect(
      agentNeedsStaleConversations([...STEPS, step({ id: "t", ordem: 3, helena_template_name: "x" })]),
    ).toBe(true);
    expect(agentNeedsStaleConversations([step({ id: "b", ordem: 1, helena_template_name: "  " })])).toBe(false);
  });
});
