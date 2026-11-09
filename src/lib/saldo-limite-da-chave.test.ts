// Monitor de saldo: com limite configurado na chave, o que importa é o MENOR
// entre o saldo da conta e o restante do limite (Clínica Bomfim, 05/11: a
// chave parou em US$ 50 com a conta cheia de saldo, sem aviso prévio).
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchOpenRouterBalance } from "./credits.server";

function api(credits: unknown, key: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) =>
      new Response(JSON.stringify(url.includes("/credits") ? credits : key), { status: 200 }),
    ),
  );
}
afterEach(() => vi.unstubAllGlobals());

describe("fetchOpenRouterBalance", () => {
  it("limite da chave menor que o saldo da conta → vale o limite da chave", async () => {
    api({ data: { total_credits: 500, total_usage: 100 } }, { data: { limit: 50, limit_remaining: 3.2 } });
    expect(await fetchOpenRouterBalance("k")).toEqual({ saldoUsd: 3.2, fonte: "key" });
  });
  it("chave sem limite → vale o saldo da conta", async () => {
    api({ data: { total_credits: 500, total_usage: 100 } }, { data: { limit: null, limit_remaining: null } });
    expect(await fetchOpenRouterBalance("k")).toEqual({ saldoUsd: 400, fonte: "credits" });
  });
  it("saldo da conta menor que o limite da chave → vale o saldo", async () => {
    api({ data: { total_credits: 110, total_usage: 100 } }, { data: { limit: 50, limit_remaining: 40 } });
    expect(await fetchOpenRouterBalance("k")).toEqual({ saldoUsd: 10, fonte: "credits" });
  });
});
