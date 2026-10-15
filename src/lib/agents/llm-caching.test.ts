// Prompt caching (Anthropic via OpenRouter): como o systemCached vira content
// block e como a duração do cache é escolhida por conta.
import { describe, expect, it } from "vitest";
import { buildMessages } from "./llm.server";
import { cacheTtlFromSettings } from "./context";

const base = {
  model: "anthropic/claude-haiku-4.5",
  systemCached: "BLOCO ESTÁVEL",
  systemDynamic: "bloco volátil",
  messages: [{ role: "user" as const, content: "oi" }],
};

function systemBlocks(msgs: ReturnType<typeof buildMessages>) {
  const sys = msgs[0];
  expect(sys.role).toBe("system");
  return sys.content as Array<{ text: string; cache_control?: { type: string; ttl?: string } }>;
}

describe("buildMessages — cache_control", () => {
  it("sem enableCaching junta tudo numa string (sem cache_control)", () => {
    const msgs = buildMessages({ ...base });
    expect(typeof msgs[0].content).toBe("string");
    expect(msgs[0].content).toContain("BLOCO ESTÁVEL");
    expect(msgs[0].content).toContain("bloco volátil");
  });

  it("enableCaching marca só o bloco estável, TTL padrão (5 min) sem campo ttl", () => {
    const blocks = systemBlocks(buildMessages({ ...base, enableCaching: true }));
    expect(blocks).toHaveLength(2);
    expect(blocks[0].cache_control).toEqual({ type: "ephemeral" });
    expect(blocks[1].cache_control).toBeUndefined();
  });

  it('cacheTtl "1h" vai no cache_control do bloco estável', () => {
    const blocks = systemBlocks(buildMessages({ ...base, enableCaching: true, cacheTtl: "1h" }));
    expect(blocks[0].cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
    expect(blocks[1].cache_control).toBeUndefined();
  });

  it('cacheTtl "5m" explícito não adiciona ttl (é o padrão da Anthropic)', () => {
    const blocks = systemBlocks(buildMessages({ ...base, enableCaching: true, cacheTtl: "5m" }));
    expect(blocks[0].cache_control).toEqual({ type: "ephemeral" });
  });
});

describe("cacheTtlFromSettings", () => {
  it("só liga com cache_ttl = '1h' (tolerante a caixa/espaços)", () => {
    expect(cacheTtlFromSettings({ cache_ttl: "1h" })).toBe("1h");
    expect(cacheTtlFromSettings({ cache_ttl: " 1H " })).toBe("1h");
  });
  it("qualquer outro valor (ou ausência) mantém o padrão", () => {
    expect(cacheTtlFromSettings({})).toBeUndefined();
    expect(cacheTtlFromSettings(null)).toBeUndefined();
    expect(cacheTtlFromSettings({ cache_ttl: "5m" })).toBeUndefined();
    expect(cacheTtlFromSettings({ cache_ttl: "true" })).toBeUndefined();
  });
});
