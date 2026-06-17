// Smoke test do mecanismo de fallback de modelo (callLlmWithFallback /
// callLlmStructuredWithFallback). Mocka o fetch do OpenRouter: o modelo
// principal "falha" (503) e o fallback responde — validando que o sistema
// aciona o segundo modelo imediatamente, exatamente o comportamento pedido na UI.

import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { callLlm, callLlmWithFallback, callLlmStructuredWithFallback } from "./llm.server";

function okResponse(content: string) {
  return {
    ok: true,
    status: 200,
    text: async () => "",
    json: async () => ({
      id: "gen-test",
      choices: [{ message: { content, tool_calls: [] }, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    }),
  };
}

function errResponse(status: number, body = "provider returned error") {
  return { ok: false, status, text: async () => body, json: async () => ({}) };
}

// content vazio mas com reasoning (caso gemini-flash gastando output em "pensamento")
function emptyWithReasoning(reasoning: string) {
  return {
    ok: true,
    status: 200,
    text: async () => "",
    json: async () => ({
      id: "gen-test",
      choices: [
        { message: { content: "", reasoning, tool_calls: [] }, finish_reason: "stop" },
      ],
      usage: { prompt_tokens: 5, completion_tokens: 5 },
    }),
  };
}

function modelFromInit(init: { body?: string }): string {
  try {
    return JSON.parse(init.body ?? "{}").model ?? "";
  } catch {
    return "";
  }
}

const MSG = [{ role: "user" as const, content: "oi" }];

afterEach(() => vi.unstubAllGlobals());

describe("callLlmWithFallback (fallback de modelo)", () => {
  it("principal falha (503) → aciona o fallback imediatamente", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: { body?: string }) => {
        const model = modelFromInit(init);
        calls.push(model);
        return (model === "x/primary"
          ? errResponse(503)
          : okResponse("resposta do fallback")) as unknown as Response;
      }),
    );

    const r = await callLlmWithFallback("key", { model: "x/primary", messages: MSG }, ["x/fallback"]);

    expect(calls).toEqual(["x/primary", "x/fallback"]);
    expect(r.modelUsed).toBe("x/fallback");
    expect(r.fallbackUsed).toBe(true);
    expect(r.content).toBe("resposta do fallback");
  });

  it("principal funciona → usa o principal e NÃO aciona fallback", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: { body?: string }) => {
        calls.push(modelFromInit(init));
        return okResponse("ok principal") as unknown as Response;
      }),
    );

    const r = await callLlmWithFallback("key", { model: "x/primary", messages: MSG }, ["x/fallback"]);

    expect(calls).toEqual(["x/primary"]);
    expect(r.modelUsed).toBe("x/primary");
    expect(r.fallbackUsed).toBe(false);
  });

  it("erro irrecuperável (400) NÃO aciona fallback", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: { body?: string }) => {
        calls.push(modelFromInit(init));
        return errResponse(400, "bad request") as unknown as Response;
      }),
    );

    await expect(
      callLlmWithFallback("key", { model: "x/primary", messages: MSG }, ["x/fallback"]),
    ).rejects.toThrow();
    expect(calls).toEqual(["x/primary"]); // parou no principal, não tentou o fallback
  });

  it("encadeia múltiplos fallbacks até um funcionar", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: { body?: string }) => {
        const model = modelFromInit(init);
        calls.push(model);
        return (model === "x/c"
          ? okResponse("terceiro funcionou")
          : errResponse(503)) as unknown as Response;
      }),
    );

    const r = await callLlmWithFallback("key", { model: "x/a", messages: MSG }, ["x/b", "x/c"]);
    expect(calls).toEqual(["x/a", "x/b", "x/c"]);
    expect(r.modelUsed).toBe("x/c");
  });
});

describe("callLlmStructuredWithFallback (fallback em saída estruturada)", () => {
  it("principal falha → fallback responde e o JSON é parseado", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: { body?: string }) => {
        const model = modelFromInit(init);
        return (model === "x/primary"
          ? errResponse(503)
          : okResponse('{"reply":"do fallback"}')) as unknown as Response;
      }),
    );

    const r = await callLlmStructuredWithFallback<{ reply: string }>(
      "key",
      { model: "x/primary", messages: MSG },
      (raw) => raw as { reply: string },
      ["x/fallback"],
    );

    expect(r.modelUsed).toBe("x/fallback");
    expect(r.fallbackUsed).toBe(true);
    expect(r.result.reply).toBe("do fallback");
  });

  it("primário devolve content vazio (só reasoning) → aciona o fallback", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: { body?: string }) => {
        const model = modelFromInit(init);
        calls.push(model);
        return (model === "x/primary"
          ? emptyWithReasoning("só pensamento em prosa, sem JSON")
          : okResponse('{"reply":"salvo pelo fallback"}')) as unknown as Response;
      }),
    );

    const r = await callLlmStructuredWithFallback<{ reply: string }>(
      "key",
      { model: "x/primary", messages: MSG },
      (raw) => raw as { reply: string },
      ["x/fallback"],
    );

    expect(r.modelUsed).toBe("x/fallback");
    expect(r.result.reply).toBe("salvo pelo fallback");
    expect(calls).toContain("x/fallback");
  });
});

// Reproduz fielmente o turno que quebrou em produção: o scheduler pede a
// resposta estruturada; o gemini-2.5-flash devolve content vazio + reasoning
// ("Confirming Visit Logistics…"); antes isso virava "JSON inválido" e derrubava
// o turno. Agora o fallback assume e o turno é salvo.
describe("cenário real do scheduler (gemini reasoning → fallback)", () => {
  // Schema no mesmo formato do scheduler (reply/next_stage/lead_data_patch).
  const SchedulerSchema = z.object({
    reply: z.string().min(1),
    next_stage: z
      .enum(["SLOT_OFFER", "NAME_COLLECT", "BOOKING", "CONFIRMED", "ESCALATED"])
      .optional(),
    lead_data_patch: z.object({}).passthrough().nullish(),
  });

  it("gemini devolve só reasoning → fallback responde JSON válido e o turno é salvo", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: { body?: string }) => {
        const model = modelFromInit(init);
        calls.push(model);
        if (model === "google/gemini-2.5-flash") {
          return emptyWithReasoning(
            "**Confirming Visit Logistics** The user has confirmed their visit. The conversation is naturally winding down.",
          ) as unknown as Response;
        }
        return okResponse(
          '{"reply":"Perfeito! Sua visita está confirmada. Estamos te esperando 😊","next_stage":"CONFIRMED","lead_data_patch":null}',
        ) as unknown as Response;
      }),
    );

    const { result, modelUsed, fallbackUsed } = await callLlmStructuredWithFallback<
      z.infer<typeof SchedulerSchema>
    >(
      "key",
      { model: "google/gemini-2.5-flash", messages: MSG },
      (raw) => SchedulerSchema.parse(raw),
      ["openai/gpt-4.1-mini"],
    );

    expect(modelUsed).toBe("openai/gpt-4.1-mini");
    expect(fallbackUsed).toBe(true);
    expect(result.next_stage).toBe("CONFIRMED");
    expect(result.reply).toContain("confirmada");
    expect(calls).toContain("openai/gpt-4.1-mini");
  });
});

describe("callLlm — reasoning não vira content em JSON", () => {
  it("jsonMode: content vazio + reasoning → content fica null (não usa prosa)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => emptyWithReasoning("pensamento interno") as unknown as Response),
    );
    const r = await callLlm("key", { model: "x", messages: MSG, jsonMode: true });
    expect(r.content).toBeNull();
  });

  it("texto livre: content vazio + reasoning → usa o reasoning como content", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => emptyWithReasoning("resposta veio no reasoning") as unknown as Response),
    );
    const r = await callLlm("key", { model: "x", messages: MSG });
    expect(r.content).toBe("resposta veio no reasoning");
  });
});
