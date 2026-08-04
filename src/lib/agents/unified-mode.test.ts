// Modo unificado (Fase 2): um agente conduz recepção → qualificação →
// agendamento, com todas as tools sempre disponíveis. Ligado por conta via
// `agents.settings.agent_mode = "unified"`.
//
// O que estes testes protegem:
//  1. O modo NÃO liga sozinho — o padrão continua sendo o fluxo dividido, que
//     roda em 17 contas em produção.
//  2. Ligado, o agente ganha a tool de etiquetagem (que era exclusiva do
//     qualifier) sem perder nenhuma tool de agenda.
//  3. A tool de etiquetagem NÃO aparece em contas com classificador de turma —
//     lá o interesse é determinístico e o LLM sobrescreveria o valor canônico.

import { describe, expect, it } from "vitest";

import type { AgentContext } from "./context";
import { buildSchedulerTools, isUnifiedMode } from "./scheduler.server";

const ctx = (settings: Record<string, string> = {}): AgentContext =>
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
    agentSettings: settings,
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
  }) as AgentContext;

const toolNames = (c: AgentContext) => buildSchedulerTools(c).map((t) => t.function.name);

describe("isUnifiedMode", () => {
  it("desligado por padrao (sem a setting)", () => {
    expect(isUnifiedMode(ctx())).toBe(false);
  });

  it("desligado com agent_mode='staged'", () => {
    expect(isUnifiedMode(ctx({ agent_mode: "staged" }))).toBe(false);
  });

  it("ligado com agent_mode='unified'", () => {
    expect(isUnifiedMode(ctx({ agent_mode: "unified" }))).toBe(true);
  });

  it("tolera caixa e espacos", () => {
    expect(isUnifiedMode(ctx({ agent_mode: "  UNIFIED " }))).toBe(true);
  });

  it("valor desconhecido NAO liga o modo", () => {
    expect(isUnifiedMode(ctx({ agent_mode: "unifed" }))).toBe(false);
    expect(isUnifiedMode(ctx({ agent_mode: "true" }))).toBe(false);
  });
});

describe("tools por modo", () => {
  it("modo dividido NAO expoe aplicar_tag_interesse ao scheduler", () => {
    expect(toolNames(ctx())).not.toContain("aplicar_tag_interesse");
  });

  it("modo unificado expoe aplicar_tag_interesse", () => {
    expect(toolNames(ctx({ agent_mode: "unified" }))).toContain("aplicar_tag_interesse");
  });

  it("modo unificado mantem TODAS as tools de agenda", () => {
    const names = toolNames(ctx({ agent_mode: "unified" }));
    for (const t of [
      "buscar_paciente",
      "listar_horarios",
      "criar_agendamento",
      "cancelar_agendamento",
      "remarcar_agendamento",
      "enviar_midia",
    ]) {
      expect(names).toContain(t);
    }
  });

  it("com classificador de turma, a tool de tag fica de fora mesmo em unified", () => {
    const names = toolNames(ctx({ agent_mode: "unified", turma_auto: "true" }));
    expect(names).not.toContain("aplicar_tag_interesse");
    expect(names).toContain("listar_horarios");
  });
});
