// Read-only: roda looksLikeSentenceNotName NOVO x baseline do git contra todos
// os lead_data.name de produção e LISTA cada nome que mudou de veredito, para
// conferência humana (o diag não julga se é nome ou frase).
//   BASE=origin/main npx vitest run --config scripts/diag/vitest.diag.config.ts scripts/diag/nome-frase-corpus.diag.ts
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
const OUT = path.resolve(process.cwd(), "scripts", "diag", "last-report-nome-frase-corpus.txt");
const R: string[] = [];
const log = (l = "") => { R.push(l); fs.writeFileSync(OUT, `${R.join("\n")}\n`, "utf8"); };
function loadEnv() {
  const txt = fs.readFileSync(path.resolve(process.cwd(), ".env.production"), "utf8");
  for (const line of txt.split(/\r?\n/)) {
    if (!line || line.startsWith("#") || !line.includes("=")) continue;
    const i = line.indexOf("="); const k = line.slice(0, i).trim();
    if (!process.env[k]) process.env[k] = line.slice(i + 1).trim().replace(/^["']|["']$/g, "");
  }
}
loadEnv();
const BASE = process.env.BASE || "HEAD";
const fonte = execSync(`git show ${BASE}:src/lib/booking-template.ts`, { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
fs.writeFileSync(path.resolve(process.cwd(), "scripts", "diag", "_baseline-tmp.ts"), fonte.replace(/from "\.\/([\w-]+)"/g, 'from "@/lib/$1"'), "utf8");
const { getSelfhost } = await import("@/integrations/selfhost/client.server");
const { looksLikeSentenceNotName } = await import("@/lib/booking-template");
const { looksLikeSentenceNotName: antigo } = await import("./_baseline-tmp");
const sb = getSelfhost();

describe("nome x frase", () => {
  it(`compara ${BASE} x working tree`, async () => {
    const nomes = new Map<string, number>();
    for (let from = 0; ; from += 1000) {
      const { data, error } = await sb.from("conversations").select("meta").range(from, from + 999);
      if (error) throw error;
      for (const c of (data ?? []) as { meta: { lead_data?: { name?: string } } | null }[]) {
        const n = c.meta?.lead_data?.name?.trim();
        if (n) nomes.set(n, (nomes.get(n) ?? 0) + 1);
      }
      if (!data || data.length < 1000) break;
    }
    const mudou = [...nomes.keys()].filter((n) => antigo(n) !== looksLikeSentenceNotName(n));
    log(`nomes distintos=${nomes.size} mudaram=${mudou.length}\n`);
    for (const n of mudou.sort()) log(`${antigo(n) ? "frase→nome" : "nome→frase"}  x${nomes.get(n)}  ${JSON.stringify(n)}`);
    expect(true).toBe(true);
  }, 300_000);
});
