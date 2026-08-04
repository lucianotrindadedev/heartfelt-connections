// Clinic Experts multi-unidade (migração 0053): uma central de atendimento
// agenda em VÁRIAS contas Clinic Experts (uma por localidade). O agente recebe
// o parâmetro `agenda` (enum dos labels — o MESMO contrato do multi-agenda
// Google) e trava a unidade na conversa via lead_data.selected_agenda.
//
// O que estes testes protegem:
//  1. O enum de unidades só é injetado com 2+ unidades, e SÓ em
//     listar_horarios/criar_agendamento — 0/1 unidade se comporta como hoje.
//  2. resolveCeUnidade espelha o contrato do resolveGcalAgenda: erro claro
//     listando os labels válidos (o LLM se corrige), match case-insensitive.
//  3. Precedência: com GCal multi-agenda ativo, o enum é o do GCal (os
//     branches de execução checam GCal antes de CE).

import { describe, expect, it } from "vitest";

import type { AgentContext } from "./context";
import { buildSchedulerTools, isMultiUnidadeCe, resolveCeUnidade } from "./scheduler.server";

const UNIDADES = [
  { label: "Recreio", descricao: "leads do Recreio e região", professionalsCount: 2 },
  { label: "Barra", descricao: "leads da Barra da Tijuca", professionalsCount: 1 },
];

const ctx = (over: Partial<AgentContext> = {}): AgentContext =>
  ({
    accountId: "acc",
    agentId: "agt",
    conversationId: "conv",
    stage: "SLOT_OFFER",
    leadData: {},
    conversationPhone: "5521999999999",
    effectivePhone: "5521999999999",
    channel: "whatsapp",
    helenaContact: null,
    agentSettings: {},
    basePrompt: "",
    model: "anthropic/claude-haiku-4.5",
    qualifierModel: "anthropic/claude-haiku-4.5",
    qualifierFallbackModels: [],
    toolModel: "anthropic/claude-haiku-4.5",
    toolFallbackModels: [],
    fallbackModels: [],
    ragGateModel: "anthropic/claude-haiku-4.5",
    maxTokens: 1024,
    temperature: 0.5,
    modelTemperatures: {},
    orKey: "k",
    integrations: {
      clinicorp: false,
      clinup: false,
      googleCalendar: false,
      clinicExperts: true,
      escalation: false,
      googleSheets: false,
    },
    googleSheets: [],
    googleAgendas: [],
    clinicExpertsProfessionals: [],
    clinicExpertsUnidades: [],
    clinupProfessionals: [],
    history: [],
    ...over,
  }) as AgentContext;

const agendaParamOf = (c: AgentContext, toolName: string) => {
  const tool = buildSchedulerTools(c).find((t) => t.function.name === toolName);
  const params = tool?.function.parameters as
    | { properties?: Record<string, { enum?: string[] }>; required?: string[] }
    | undefined;
  return {
    prop: params?.properties?.agenda,
    required: params?.required?.includes("agenda") ?? false,
  };
};

describe("isMultiUnidadeCe", () => {
  it("false com 0 ou 1 unidade (conta atual intacta)", () => {
    expect(isMultiUnidadeCe(ctx())).toBe(false);
    expect(isMultiUnidadeCe(ctx({ clinicExpertsUnidades: [UNIDADES[0]!] }))).toBe(false);
  });

  it("true com 2+ unidades", () => {
    expect(isMultiUnidadeCe(ctx({ clinicExpertsUnidades: UNIDADES }))).toBe(true);
  });

  it("false quando GCal está ativo (precedência do multi-agenda)", () => {
    const c = ctx({ clinicExpertsUnidades: UNIDADES });
    c.integrations.googleCalendar = true;
    expect(isMultiUnidadeCe(c)).toBe(false);
  });

  it("false sem a integração Clinic Experts", () => {
    const c = ctx({ clinicExpertsUnidades: UNIDADES });
    c.integrations.clinicExperts = false;
    expect(isMultiUnidadeCe(c)).toBe(false);
  });
});

describe("buildSchedulerTools — enum de unidades", () => {
  it("2+ unidades: injeta `agenda` (required) SÓ em listar_horarios e criar_agendamento", () => {
    const c = ctx({ clinicExpertsUnidades: UNIDADES });
    const listar = agendaParamOf(c, "listar_horarios");
    const criar = agendaParamOf(c, "criar_agendamento");
    expect(listar.prop?.enum).toEqual(["Recreio", "Barra"]);
    expect(listar.required).toBe(true);
    expect(criar.prop?.enum).toEqual(["Recreio", "Barra"]);
    expect(criar.required).toBe(true);
    // Cancelar/remarcar usam selected_agenda do lead_data — sem parâmetro.
    expect(agendaParamOf(c, "cancelar_agendamento").prop).toBeUndefined();
    expect(agendaParamOf(c, "remarcar_agendamento").prop).toBeUndefined();
  });

  it("0/1 unidade: NENHUMA tool ganha o parâmetro (comportamento atual)", () => {
    expect(agendaParamOf(ctx(), "listar_horarios").prop).toBeUndefined();
    expect(
      agendaParamOf(ctx({ clinicExpertsUnidades: [UNIDADES[0]!] }), "listar_horarios").prop,
    ).toBeUndefined();
  });

  it("precedência: GCal multi-agenda ativo → enum é o das agendas Google", () => {
    const c = ctx({
      clinicExpertsUnidades: UNIDADES,
      googleAgendas: [
        { label: "Consultas", calendarId: "c1" },
        { label: "Festas", calendarId: "c2" },
      ] as AgentContext["googleAgendas"],
    });
    c.integrations.googleCalendar = true;
    const listar = agendaParamOf(c, "listar_horarios");
    expect(listar.prop?.enum).toEqual(["Consultas", "Festas"]);
  });
});

describe("resolveCeUnidade", () => {
  it("unidade única: retorna {} (resolução implícita no tool file)", () => {
    expect(resolveCeUnidade(ctx({ clinicExpertsUnidades: [UNIDADES[0]!] }), undefined)).toEqual(
      {},
    );
    expect(resolveCeUnidade(ctx(), "qualquer")).toEqual({});
  });

  it("multi sem label: erro lista os labels válidos e manda perguntar a localidade", () => {
    const r = resolveCeUnidade(ctx({ clinicExpertsUnidades: UNIDADES }), undefined);
    expect(r.error).toContain("Recreio");
    expect(r.error).toContain("Barra");
    expect(r.error).toMatch(/PERGUNTE a localidade/i);
  });

  it("multi com label inválido: erro lista os labels válidos", () => {
    const r = resolveCeUnidade(ctx({ clinicExpertsUnidades: UNIDADES }), "Centro");
    expect(r.error).toContain('"Centro"');
    expect(r.error).toContain("Recreio");
  });

  it("match case-insensitive + trim, devolvendo o label canônico e o count", () => {
    const r = resolveCeUnidade(ctx({ clinicExpertsUnidades: UNIDADES }), "  recreio ");
    expect(r.error).toBeUndefined();
    expect(r.unitLabel).toBe("Recreio");
    expect(r.professionalsCount).toBe(2);
  });
});
