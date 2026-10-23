// Reparo de formato com o MESMO modelo. Sem fallback (modelo único da
// plataforma), uma resposta em texto puro virava "tive uma instabilidade
// técnica". Caso real (Alfa Implantes, 23/10): o Haiku respondeu
// "Prazer, Luciano! 😊 O que te incomoda mais hoje…" fora do JSON.
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { callLlmStructuredWithFallback, isStructuredContentIssue, LlmError } from "./llm.server";

function okResponse(content: string, tokens = 10) {
  return {
    ok: true,
    status: 200,
    text: async () => "",
    json: async () => ({
      id: "gen-test",
      choices: [{ message: { content, tool_calls: [] }, finish_reason: "stop" }],
      usage: { prompt_tokens: tokens, completion_tokens: 5, cost: 0.001 },
    }),
  };
}

type Body = { model?: string; messages?: { role: string; content: unknown }[] };
const bodyOf = (init: { body?: string }): Body => JSON.parse(init.body ?? "{}");

const Schema = z.object({ reply: z.string(), next_stage: z.string() });
const parse = (raw: unknown) => Schema.parse(raw);
const MSG = [{ role: "user" as const, content: "Luciano" }];
const HAIKU = "anthropic/claude-haiku-4.5";
const TEXTO_PURO = "Prazer, Luciano! 😊\n\nO que te incomoda mais hoje: dor, falta de dente ou estética do sorriso?";

afterEach(() => vi.unstubAllGlobals());

describe("reparo de formato (mesmo modelo, sem fallback)", () => {
  it("texto puro → pede o JSON ao mesmo modelo e recupera o turno", async () => {
    const bodies: Body[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: { body?: string }) => {
        bodies.push(bodyOf(init));
        return bodies.length === 1
          ? okResponse(TEXTO_PURO)
          : okResponse(JSON.stringify({ reply: TEXTO_PURO, next_stage: "QUALIFICATION" }));
      }),
    );

    const r = await callLlmStructuredWithFallback("k", { model: HAIKU, messages: MSG }, parse, []);

    expect(r.result.reply).toBe(TEXTO_PURO);
    expect(r.fallbackUsed).toBe(false);
    expect(bodies).toHaveLength(2);
    expect(bodies.every((b) => b.model === HAIKU)).toBe(true);
    // o reparo mostra ao modelo a resposta dele e pede o JSON
    const reparo = bodies[1]!.messages!;
    expect(reparo.at(-2)).toMatchObject({ role: "assistant", content: TEXTO_PURO });
    expect(String(reparo.at(-1)!.content)).toMatch(/JSON exigido/);
    // telemetria soma as duas chamadas
    expect(r.response.tokensIn).toBe(20);
    expect(r.response.costUsd).toBeCloseTo(0.002);
  });

  it("JSON sem campo do schema também é reparado", async () => {
    let n = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        n++;
        return n === 1
          ? okResponse(JSON.stringify({ reply: "oi" }))
          : okResponse(JSON.stringify({ reply: "oi", next_stage: "RECEPTION" }));
      }),
    );
    const r = await callLlmStructuredWithFallback("k", { model: HAIKU, messages: MSG }, parse, []);
    expect(r.result.next_stage).toBe("RECEPTION");
    expect(n).toBe(2);
  });

  it("se o reparo também falhar, propaga o erro original (vira a mensagem de instabilidade)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => okResponse(TEXTO_PURO)));
    await expect(
      callLlmStructuredWithFallback("k", { model: HAIKU, messages: MSG }, parse, []),
    ).rejects.toThrow(/JSON inválido/);
  });

  it("JSON válido de primeira não gasta chamada extra", async () => {
    let n = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        n++;
        return okResponse(JSON.stringify({ reply: "oi", next_stage: "RECEPTION" }));
      }),
    );
    await callLlmStructuredWithFallback("k", { model: HAIKU, messages: MSG }, parse, []);
    expect(n).toBe(1);
  });
});

describe("isStructuredContentIssue", () => {
  it("conteúdo inválido sim; falha de rede/HTTP não", () => {
    expect(isStructuredContentIssue(new LlmError(200, "LLM retornou JSON inválido"))).toBe(true);
    expect(isStructuredContentIssue({ name: "ZodError", issues: [] })).toBe(true);
    expect(isStructuredContentIssue(new LlmError(503, "provider error"))).toBe(false);
    expect(isStructuredContentIssue(new Error("timeout"))).toBe(false);
  });
});
