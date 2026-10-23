// Modelo de conversa único da plataforma (decisão de 23/10/2026): Haiku 4.5 em
// todas as contas, sem fallback, só a temperatura ajustável no painel.
import { describe, expect, it } from "vitest";
import {
  DEFAULT_ACCOUNT_LLM_CONFIG,
  STANDARD_AGENT_MODEL,
  STANDARD_AGENT_TEMPERATURE,
} from "./llm-defaults";

describe("modelo padrão único", () => {
  it("é o Claude Haiku 4.5", () => {
    expect(STANDARD_AGENT_MODEL).toBe("anthropic/claude-haiku-4.5");
  });

  it("conta nova nasce com o padrão, sem fallback e com a temperatura recomendada", () => {
    expect(DEFAULT_ACCOUNT_LLM_CONFIG.default_model).toBe(STANDARD_AGENT_MODEL);
    expect(DEFAULT_ACCOUNT_LLM_CONFIG.fallback_models).toEqual([]);
    expect(DEFAULT_ACCOUNT_LLM_CONFIG.model_temperatures).toEqual({
      [STANDARD_AGENT_MODEL]: STANDARD_AGENT_TEMPERATURE,
    });
    expect(STANDARD_AGENT_TEMPERATURE).toBe(0.3);
  });
});
