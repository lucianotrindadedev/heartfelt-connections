// Testes da integração de saída com o Leads360. Mocka o fetch e valida endpoint,
// headers (token) e corpo de cada evento. Best-effort: sem token não chama nada.

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  resolveLeads360Config,
  sendLeads360Lead,
  sendLeads360Interest,
  sendLeads360Scheduled,
  sendLeads360Transfer,
} from "./leads360.server";

function okFetch() {
  return vi.fn(async () => ({
    ok: true,
    status: 200,
    text: async () => '{"success":true}',
  })) as unknown as typeof fetch;
}

function lastCall(fetchMock: unknown): { url: string; init: { headers: Record<string, string>; body: string } } {
  const calls = (fetchMock as { mock: { calls: [string, { headers: Record<string, string>; body: string }][] } }).mock.calls;
  const [url, init] = calls[calls.length - 1];
  return { url, init };
}

afterEach(() => vi.unstubAllGlobals());

describe("resolveLeads360Config", () => {
  it("desligado sem token", () => {
    expect(resolveLeads360Config({}).enabled).toBe(false);
  });
  it("ligado com token + base URL padrão", () => {
    const cfg = resolveLeads360Config({ leads360_token: "tok_123" });
    expect(cfg.enabled).toBe(true);
    expect(cfg.token).toBe("tok_123");
    expect(cfg.baseUrl).toContain("/functions/v1");
  });
  it("base URL custom remove barra final", () => {
    const cfg = resolveLeads360Config({ leads360_token: "t", leads360_base_url: "https://x.com/api/" });
    expect(cfg.baseUrl).toBe("https://x.com/api");
  });
});

describe("envio de eventos", () => {
  it("NÃO chama fetch quando desligado (sem token)", async () => {
    const f = okFetch();
    vi.stubGlobal("fetch", f);
    await sendLeads360Lead(resolveLeads360Config({}), { name: "X", phone: "11999999999" });
    expect((f as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBe(0);
  });

  it("/leads envia name, phone, utm e token no header", async () => {
    const f = okFetch();
    vi.stubGlobal("fetch", f);
    const cfg = resolveLeads360Config({ leads360_token: "tok_abc" });
    await sendLeads360Lead(cfg, {
      name: "João",
      phone: "11999999999",
      utm: { source: "facebook", campaign: "12024", content: "anuncio" },
    });
    const { url, init } = lastCall(f);
    expect(url).toMatch(/\/leads$/);
    expect(init.headers.Authorization).toBe("Bearer tok_abc");
    expect(init.headers["X-Webhook-Token"]).toBe("tok_abc");
    const body = JSON.parse(init.body);
    expect(body.name).toBe("João");
    expect(body.phone).toBe("11999999999");
    expect(body.utm.source).toBe("facebook");
    expect(body.utm.campaign).toBe("12024");
  });

  it("/interesses envia o interesse", async () => {
    const f = okFetch();
    vi.stubGlobal("fetch", f);
    await sendLeads360Interest(resolveLeads360Config({ leads360_token: "t" }), {
      name: "Maria",
      phone: "11888888888",
      interest: "YEAR 2",
    });
    const { url, init } = lastCall(f);
    expect(url).toMatch(/\/interesses$/);
    expect(JSON.parse(init.body).interest).toBe("YEAR 2");
  });

  it("/agendado coloca a data/hora em notes", async () => {
    const f = okFetch();
    vi.stubGlobal("fetch", f);
    await sendLeads360Scheduled(resolveLeads360Config({ leads360_token: "t" }), {
      name: "Ana",
      phone: "11777777777",
      datetimeIso: "2026-06-16T15:00:00-03:00",
    });
    const { url, init } = lastCall(f);
    expect(url).toMatch(/\/agendado$/);
    const body = JSON.parse(init.body);
    expect(body.notes).toContain("16/06");
    expect(body.notes).toContain("15:00");
  });

  it("/transferencia usa destination 'Atendimento Humano' por padrão", async () => {
    const f = okFetch();
    vi.stubGlobal("fetch", f);
    await sendLeads360Transfer(resolveLeads360Config({ leads360_token: "t" }), {
      name: "Carlos",
      phone: "11666666666",
    });
    const { url, init } = lastCall(f);
    expect(url).toMatch(/\/transferencia$/);
    const body = JSON.parse(init.body);
    expect(body.destination).toBe("Atendimento Humano");
    expect(body.transferred_at).toBeTruthy();
  });

  it("falha de rede não propaga (best-effort)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("network down"); }) as unknown as typeof fetch);
    await expect(
      sendLeads360Lead(resolveLeads360Config({ leads360_token: "t" }), { name: "X", phone: "1" }),
    ).resolves.toBeUndefined();
  });
});
