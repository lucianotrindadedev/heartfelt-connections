// Variável {{unidade}} no template de notificação de agendamento.
//
// Contexto: contas multi-unidade (central que agenda em várias unidades —
// multi-unidade Clinic Experts ou multi-agenda Google) precisam saber, na
// notificação que chega ao grupo, EM QUAL unidade o lead agendou.
// {{unidade}} tem a mesma origem de {{agenda}} (lead_data.selected_agenda),
// com um nome que faz sentido pra quem opera uma central.

import { describe, expect, it } from "vitest";

import { buildTemplateVars, renderBookingTemplate } from "./notify-booking.server";

const params = (over: Record<string, unknown> = {}) =>
  ({
    agentId: "agt",
    accountId: "acc",
    event: "created" as const,
    patientName: "Maria Silva",
    phone: "5521999998888",
    datetimeIso: "2026-08-11T14:30:00-03:00",
    appointmentLabel: "Avaliação",
    ...over,
  }) as Parameters<typeof buildTemplateVars>[0];

describe("{{unidade}} nas notificações", () => {
  it("usa a unidade quando informada", () => {
    const vars = buildTemplateVars(params({ unidade: "Recreio" }), "");
    expect(vars.unidade).toBe("Recreio");
    expect(renderBookingTemplate("Unidade: {{unidade}}", vars)).toBe("Unidade: Recreio");
  });

  it("cai em `agenda` quando `unidade` não vem (mesma origem)", () => {
    const vars = buildTemplateVars(params({ agenda: "Barra" }), "");
    expect(vars.unidade).toBe("Barra");
  });

  it("fica vazia em conta de unidade única (sem quebrar o template)", () => {
    const vars = buildTemplateVars(params(), "");
    expect(vars.unidade).toBe("");
    // A variável some do texto (vira ""), sem deixar "{{unidade}}" cru.
    expect(renderBookingTemplate("Unidade: {{unidade}}", vars).trim()).toBe("Unidade:");
  });

  it("convive com {{agenda}} no mesmo template", () => {
    const vars = buildTemplateVars(params({ agenda: "Magé", unidade: "Magé" }), "");
    expect(renderBookingTemplate("{{agenda}} / {{unidade}}", vars)).toBe("Magé / Magé");
  });

  it("template real de central multi-unidade renderiza completo", () => {
    const vars = buildTemplateVars(
      params({ unidade: "Recreio", interesse: "Botox" }),
      "Lead quer avaliação de Botox.",
    );
    const out = renderBookingTemplate(
      "*{{tipo_consulta}} {{evento}}* — 🏥 {{unidade}}\n{{nome}} — {{data}} às {{hora}}\n{{resumo}}",
      vars,
    );
    expect(out).toContain("🏥 Recreio");
    expect(out).toContain("AGENDADA");
    expect(out).toContain("Maria Silva");
  });
});
