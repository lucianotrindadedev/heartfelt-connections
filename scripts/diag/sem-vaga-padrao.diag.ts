// Read-only: com que frequencia o agente afirma "nao temos vaga" para um dia.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
const OUT = path.resolve(process.cwd(), "scripts", "diag", "last-report-padrao.txt");
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
const { getSelfhost } = await import("@/integrations/selfhost/client.server");
const sb = getSelfhost();

describe("padrao", () => {
  it("mede", async () => {
    const SINCE = "2026-08-09T00:00:00Z";
    const PADRAO = /(hoje|amanh[ãa]|hj)[^.!?]{0,60}(n[ãa]o (temos|tenho|h[áa]) (vaga|hor[áa]rio)|sem vaga|sem hor[áa]rio|lotad)/i;
    const rows: { conversation_id: string; content: string; criado_em: string; meta: Record<string, unknown> | null }[] = [];
    for (let f = 0; ; f += 1000) {
      const { data } = await sb.from("messages").select("conversation_id, content, criado_em, meta")
        .gte("criado_em", SINCE).eq("role", "assistant").ilike("content", "%vaga%")
        .order("criado_em", { ascending: false }).range(f, f + 999);
      const page = (data ?? []) as typeof rows;
      rows.push(...page);
      if (page.length < 1000) break;
    }
    const doAgente = rows.filter((r) => (r.meta ?? {}).origem === "agente");
    const afirmam = doAgente.filter((r) => PADRAO.test(String(r.content ?? "")));
    log(`### mensagens do AGENTE contendo "vaga" desde ${SINCE.slice(0, 10)}: ${doAgente.length}`);
    log(`### que afirmam "hoje/amanhã não temos vaga": ${afirmam.length}`);
    log(`### em ${new Set(afirmam.map((r) => r.conversation_id)).size} conversas distintas\n`);
    for (const r of afirmam.slice(0, 12)) {
      const m = PADRAO.exec(String(r.content ?? ""));
      log(`  ${r.criado_em.slice(0, 16)} conv=${r.conversation_id.slice(0, 8)} :: ${JSON.stringify(m?.[0]?.slice(0, 90))}`);
    }
    expect(true).toBe(true);
  }, 900_000);
});
