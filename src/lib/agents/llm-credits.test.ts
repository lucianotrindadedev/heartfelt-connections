// Falta de SALDO na OpenRouter (402) é caso à parte: não é instabilidade, não
// adianta tentar outro modelo e o lead não pode receber desculpa técnica por
// isso. Aqui garantimos as duas metades do contrato que o orquestrador usa para
// silenciar a IA e alertar o grupo (ver src/lib/credits.server.ts):
//   1. o erro é RECONHECIDO como falta de saldo;
//   2. a cadeia de fallback NÃO é percorrida (senão o corte demora e o mesmo
//      402 se repete em cada modelo).

import { afterEach, describe, expect, it, vi } from "vitest";

import { LlmError, callLlmWithFallback, isInsufficientCreditsError } from "./llm.server";

function errResponse(status: number, body: string) {
  return { ok: false, status, text: async () => body, json: async () => ({}) };
}

const MSG = [{ role: "user" as const, content: "oi" }];

afterEach(() => vi.unstubAllGlobals());

describe("isInsufficientCreditsError", () => {
  it("reconhece o 402 da OpenRouter", () => {
    expect(
      isInsufficientCreditsError(
        new LlmError(402, "OpenRouter 402: ...", '{"error":{"code":402}}'),
      ),
    ).toBe(true);
  });

  it("reconhece a mensagem de saldo mesmo fora do 402", () => {
    // A OpenRouter devolve esse texto com status variado dependendo do provider.
    expect(
      isInsufficientCreditsError(
        new LlmError(
          400,
          "OpenRouter 400: ...",
          '{"error":{"message":"This request requires more credits, or fewer max_tokens."}}',
        ),
      ),
    ).toBe(true);
    expect(isInsufficientCreditsError(new Error("Insufficient credits for this request"))).toBe(
      true,
    );
  });

  it("NÃO confunde com rate limit, timeout ou erro de provider", () => {
    expect(isInsufficientCreditsError(new LlmError(429, "rate limited"))).toBe(false);
    expect(isInsufficientCreditsError(new LlmError(503, "provider returned error"))).toBe(false);
    expect(isInsufficientCreditsError(new Error("fetch failed"))).toBe(false);
    expect(isInsufficientCreditsError(null)).toBe(false);
  });
});

describe("callLlmWithFallback com saldo zerado", () => {
  it("não percorre a cadeia de fallback — falha na primeira tentativa", async () => {
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls++;
        return errResponse(
          402,
          '{"error":{"code":402,"message":"Insufficient credits. Add more credits to continue."}}',
        );
      }),
    );

    await expect(
      callLlmWithFallback("key", { model: "anthropic/claude-haiku-4.5", messages: MSG }, [
        "openai/gpt-4o-mini",
        "google/gemini-2.5-flash",
      ]),
    ).rejects.toSatisfy((e: unknown) => isInsufficientCreditsError(e));

    expect(calls).toBe(1);
  });
});
