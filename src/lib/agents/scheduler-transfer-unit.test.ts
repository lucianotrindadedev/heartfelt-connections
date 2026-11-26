// A loja indicada pela IA na etapa de agenda (scheduler, modo dividido) não pode
// sumir na validação do JSON. Caso real: Game Point, 27/10–25/11/2026 — 77
// escaladas foram para o suporte geral em vez da loja porque o schema do modo
// dividido não tinha transfer_unit e o zod descartava a chave em silêncio.
import { describe, expect, it } from "vitest";

import type { AgentContext } from "./context";
import { parseAgentJson } from "./scheduler.server";

const ctx = (agentMode?: string) => ({ agentSettings: agentMode ? { agent_mode: agentMode } : {} }) as unknown as AgentContext;
const turno = {
  reply: "Vou te colocar com a equipe da unidade TopShopping pra te orientarem sobre 2027, combinado? 😊",
  next_stage: "ESCALATED",
  lead_data_patch: { transfer_unit: "TopShopping", escalation_reason: "Data de evento fora do período aberto (2027)" },
};

describe("scheduler mantém a loja da transferência", () => {
  it("modo dividido (qualifier + scheduler)", () => {
    const r = parseAgentJson(ctx(), turno);
    expect(r.lead_data_patch?.transfer_unit).toBe("TopShopping");
    expect(r.lead_data_patch?.escalation_reason).toContain("2027");
  });

  it("modo unificado continua igual", () => {
    expect(parseAgentJson(ctx("unified"), turno).lead_data_patch?.transfer_unit).toBe("TopShopping");
  });

  it("os demais campos do patch continuam aceitos", () => {
    const r = parseAgentJson(ctx(), {
      reply: "ok",
      lead_data_patch: { selected_agenda: "WestShopping", custom_fields: { unidade: "WestShopping", adultos: 65 }, retomar_em: "2026-12-01" },
    });
    expect(r.lead_data_patch?.selected_agenda).toBe("WestShopping");
    expect(r.lead_data_patch?.custom_fields).toEqual({ unidade: "WestShopping", adultos: "65" });
    expect(r.lead_data_patch?.retomar_em).toBe("2026-12-01");
  });
});
