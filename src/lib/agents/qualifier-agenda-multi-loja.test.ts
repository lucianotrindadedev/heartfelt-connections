// Central com uma agenda Google por loja (Game Point): a consulta de horários do
// qualifier não tinha o parâmetro `agenda`. Numa conta multi-agenda a busca sem
// agenda devolve erro ("informe o parâmetro agenda"), então o qualifier nunca
// conseguia mostrar horário — só o scheduler, que já tinha o parâmetro.

import { describe, expect, it } from "vitest";

import type { AgentContext } from "./context";
import { buildQualifierTools } from "./qualifier.server";
import { buildSchedulerTools } from "./scheduler.server";

const LOJAS = [
  { label: "Madureira Shopping", calendarId: "c1", descricao: "Zona Norte" },
  { label: "Via Parque", calendarId: "c2", descricao: "Barra da Tijuca" },
] as AgentContext["googleAgendas"];

const ctx = (over: Partial<AgentContext> = {}): AgentContext =>
  ({
    accountId: "acc",
    agentId: "agt",
    conversationId: "conv",
    stage: "QUALIFICATION",
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
    temperature: 0.3,
    modelTemperatures: {},
    orKey: "k",
    integrations: {
      clinicorp: false,
      clinup: false,
      googleCalendar: true,
      clinicExperts: false,
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

function agendaParam(tools: ReturnType<typeof buildQualifierTools>) {
  const listar = tools.find((t) => t.function.name === "listar_horarios");
  const params = listar?.function.parameters as
    | { properties?: Record<string, { enum?: string[] }>; required?: string[] }
    | undefined;
  return { enum: params?.properties?.agenda?.enum, required: params?.required?.includes("agenda") };
}

describe("qualifier: consulta de horários numa central com agenda por loja", () => {
  it("2+ agendas: listar_horarios do qualifier pede a loja, com o mesmo enum do scheduler", () => {
    const c = ctx({ googleAgendas: LOJAS });
    const q = agendaParam(buildQualifierTools(c));
    expect(q.enum).toEqual(["Madureira Shopping", "Via Parque"]);
    expect(q.required).toBe(true);
    expect(agendaParam(buildSchedulerTools(c)).enum).toEqual(q.enum);
  });

  it("agenda única: a consulta continua sem parâmetro", () => {
    const q = agendaParam(buildQualifierTools(ctx({ googleAgendas: [LOJAS[0]!] })));
    expect(q.enum).toBeUndefined();
  });

  it("o qualifier nunca ganha criar_agendamento", () => {
    const names = buildQualifierTools(ctx({ googleAgendas: LOJAS })).map((t) => t.function.name);
    expect(names).not.toContain("criar_agendamento");
  });
});
