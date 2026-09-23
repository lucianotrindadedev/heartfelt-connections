// Read-only: roda scrubInventedTimeOffers NOVO x baseline do git contra as
// respostas da IA dos últimos 60 dias e LISTA cada uma que muda de veredito,
// para conferência humana. Roda sem agenda (offered vazio) — o pior caso: toda
// lista de horários detectada vira "inventada". O que importa conferir é se o
// que passou a ser detectado é mesmo OFERTA (e não expediente, endereço etc.).
//   BASE=origin/main npx vitest run --config scripts/diag/vitest.diag.config.ts scripts/diag/guard-lista-corpus.diag.ts
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
const OUT = path.resolve(process.cwd(), "scripts", "diag", "last-report-guard-lista.txt");
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
const { scrubInventedTimeOffers } = await import("@/lib/booking-template");
const { scrubInventedTimeOffers: antigo } = await import("./_baseline-tmp");
const sb = getSelfhost();

describe("guard lista", () => {
  it(`compara ${BASE} x working tree`, async () => {
    const desde = new Date(Date.now() - 60 * 86400_000).toISOString();
    const textos = new Map<string, string>();
    for (let from = 0; ; from += 1000) {
      const { data, error } = await sb.from("messages").select("id, content, meta")
        .eq("role", "assistant").like("content", "%:%").gte("criado_em", desde).range(from, from + 999);
      if (error) throw error;
      for (const m of (data ?? []) as { id: string; content: string; meta: Record<string, unknown> | null }[]) {
        if (m.meta?.origem !== "agente") continue;
        if (/\n/.test(m.content ?? "")) textos.set(m.id, m.content);
      }
      if (!data || data.length < 1000) break;
    }
    let novos = 0, perdidos = 0;
    const casos: string[] = [];
    for (const [id, t] of textos) {
      const a = antigo(t).scrubbed, n = scrubInventedTimeOffers(t).scrubbed;
      if (a === n) continue;
      if (n) novos++; else perdidos++;
      casos.push(`${n ? "PASSOU A DETECTAR" : "DEIXOU DE DETECTAR"}  ${id}\n   ${t.replace(/\n/g, " ⏎ ").slice(0, 400)}`);
    }
    log(`respostas multi-linha com ':' (60d, origem agente) = ${textos.size}`);
    log(`passou a detectar = ${novos}   deixou de detectar = ${perdidos}\n`);
    for (const c of casos) log(c + "\n");
    expect(true).toBe(true);
  }, 600_000);
});
