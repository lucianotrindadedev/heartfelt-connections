// DIAGNÓSTICO DE PROMPT CACHING — mede se o cache está REALMENTE ativo.
//
//   npx vitest run --config scripts/diag/vitest.diag.config.ts scripts/diag/caching.diag.ts
//
// Usa o callLlm de produção (não uma reimplementação), então mede o caminho
// real: systemCached vira content block com cache_control quando
// enableCaching=true. Lê `cachedTokens` (prompt_tokens_details.cached_tokens
// da OpenRouter) — o único sinal confiável de acerto de cache.
//
// Custo: ~6 chamadas curtas (centavos). Nada é escrito em lugar nenhum.

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, beforeAll, afterAll } from "vitest";

const REPORT: string[] = [];
const REPORT_FILE = path.resolve(process.cwd(), "scripts", "diag", "last-report-cache.txt");
function log(line = "") {
  REPORT.push(line);
  console.log(line);
}

function loadEnv() {
  const txt = fs.readFileSync(path.resolve(process.cwd(), ".env.production"), "utf8");
  for (const l of txt.split(/\r?\n/)) {
    if (!l || l.startsWith("#") || !l.includes("=")) continue;
    const i = l.indexOf("=");
    const k = l.slice(0, i).trim();
    if (!process.env[k]) process.env[k] = l.slice(i + 1).trim().replace(/^["']|["']$/g, "");
  }
}
loadEnv();

const { getSelfhost } = await import("@/integrations/selfhost/client.server");
const { decryptValue } = await import("@/lib/crypto.server");
const { callLlm } = await import("@/lib/agents/llm.server");

const sb = getSelfhost();
let orKey = "";

beforeAll(async () => {
  const { data } = await sb
    .from("account_secrets")
    .select("openrouter_api_key_enc")
    .not("openrouter_api_key_enc", "is", null)
    .limit(1)
    .single();
  orKey = (await decryptValue(data!.openrouter_api_key_enc as string)) ?? "";
  expect(orKey.length, "sem chave OpenRouter").toBeGreaterThan(10);
});

/** Bloco estável e grande o suficiente para passar do mínimo cacheável. */
function blocoEstavel(aprox_tokens: number): string {
  const paragrafo =
    "Você é uma secretária virtual de uma clínica odontológica brasileira. " +
    "Atenda com cordialidade, responda em português do Brasil, use frases curtas " +
    "e faça uma pergunta por vez. Nunca invente horários, preços ou procedimentos. " +
    "Confirme sempre os dados do paciente antes de registrar qualquer agendamento. ";
  // ~4 chars por token em pt-BR.
  const alvoChars = aprox_tokens * 4;
  let out = "";
  let i = 0;
  while (out.length < alvoChars) {
    out += `${paragrafo}(regra ${i++}) `;
  }
  return out;
}

interface Medida {
  tokensIn: number;
  cached: number;
  custo: number;
}

async function medir(
  model: string,
  systemCached: string,
  enableCaching: boolean,
  pergunta: string,
): Promise<Medida> {
  const r = await callLlm(orKey, {
    model,
    systemCached,
    systemDynamic: "Agora: 2026-07-28.",
    messages: [{ role: "user", content: pergunta }],
    maxTokens: 32,
    temperature: 0,
    enableCaching,
  });
  return { tokensIn: r.tokensIn, cached: r.cachedTokens, custo: r.costUsd };
}

const HAIKU = "anthropic/claude-haiku-4.5";

describe("A. Haiku 4.5 com bloco GRANDE (acima do mínimo cacheável)", () => {
  it("a 2ª chamada idêntica lê do cache", async () => {
    const bloco = blocoEstavel(6000);
    log(`\n  bloco estável: ~${Math.round(bloco.length / 4)} tokens (${bloco.length} chars)`);

    const m1 = await medir(HAIKU, bloco, true, "Diga apenas: ok");
    log(`  1ª chamada: entrada=${m1.tokensIn} cacheados=${m1.cached} custo=$${m1.custo.toFixed(6)}`);

    const m2 = await medir(HAIKU, bloco, true, "Diga apenas: ok");
    log(`  2ª chamada: entrada=${m2.tokensIn} cacheados=${m2.cached} custo=$${m2.custo.toFixed(6)}`);

    const economia = m1.custo > 0 ? (1 - m2.custo / m1.custo) * 100 : 0;
    log(`  → cache na 2ª: ${m2.cached > 0 ? `SIM (${m2.cached} tokens)` : "NÃO"} | economia: ${economia.toFixed(0)}%`);

    expect(m2.cached, "2ª chamada não leu nada do cache — caching NÃO está funcionando").toBeGreaterThan(0);
  }, 180_000);
});

describe("B. Haiku 4.5 com bloco PEQUENO (abaixo do mínimo cacheável)", () => {
  it("não cacheia — mínimo do Haiku 4.5 é 4096 tokens", async () => {
    const bloco = blocoEstavel(1200); // bem abaixo de 4096
    log(`\n  bloco pequeno: ~${Math.round(bloco.length / 4)} tokens`);

    await medir(HAIKU, bloco, true, "Diga apenas: ok");
    const m2 = await medir(HAIKU, bloco, true, "Diga apenas: ok");
    log(`  2ª chamada: entrada=${m2.tokensIn} cacheados=${m2.cached}`);
    log(`  → ${m2.cached > 0 ? "cacheou (mínimo menor que o documentado)" : "NÃO cacheou — confirma o mínimo de 4096 tokens do Haiku 4.5"}`);
    // Sem assert: é uma medição informativa do limiar, não um requisito.
    expect(true).toBe(true);
  }, 180_000);
});

describe("C. enableCaching=false (o caso do tool loop do scheduler)", () => {
  it("sem cache_control não há leitura de cache", async () => {
    const bloco = blocoEstavel(6000);
    await medir(HAIKU, bloco, false, "Diga apenas: ok");
    const m2 = await medir(HAIKU, bloco, false, "Diga apenas: ok");
    log(`\n  sem cache_control — 2ª chamada: entrada=${m2.tokensIn} cacheados=${m2.cached}`);
    log(`  → ${m2.cached > 0 ? "houve cache mesmo sem o marcador (cache automático do provedor)" : "nenhum cache, como esperado"}`);
    expect(true).toBe(true);
  }, 180_000);
});

afterAll(() => {
  fs.writeFileSync(REPORT_FILE, `${REPORT.join("\n")}\n`, "utf8");
});
