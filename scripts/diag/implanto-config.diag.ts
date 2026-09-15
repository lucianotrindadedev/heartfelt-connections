import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
const OUT = path.resolve(process.cwd(), "scripts", "diag", "last-report-implanto-cfg.txt");
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
const bt = await import("@/lib/booking-template");
const sb = getSelfhost();
const AGENT = "8ecd27e5-7544-48e1-844c-962e87a55376";
const ACC = "6dabbad9-32f9-415f-8003-9eacac9634f3";
const BRT = "America/Sao_Paulo";

describe("cfg", () => {
  it("dump", async () => {
    const { data: ag } = await sb.from("agents").select("settings").eq("id", AGENT).maybeSingle();
    const cfg = (ag?.settings ?? {}) as Record<string, string>;
    log(`### settings do agente`);
    for (const k of Object.keys(cfg).sort()) {
      const v = String(cfg[k] ?? "");
      log(`  ${k} = ${v.length > 700 ? v.slice(0, 700) + "…" : v}`);
    }
    log(`\n### dias ativos derivados do business_hours_json`);
    const bh = cfg.business_hours_json;
    if (bh) {
      const j = JSON.parse(bh) as Record<string, { active?: boolean; start?: string; end?: string }>;
      for (const [d, v] of Object.entries(j)) log(`  ${d}: active=${v.active} ${v.start ?? ""}-${v.end ?? ""}`);
    }
    log(`\n### integracoes`);
    for (const t of ["clinicorp_config", "clinup_config", "google_calendar_tokens", "clinic_experts_config"]) {
      const { data } = await sb.from(t).select("ativo").eq("account_id", ACC).maybeSingle();
      log(`  ${t}: ativo=${JSON.stringify((data as { ativo?: boolean } | null)?.ativo ?? null)}`);
    }
    log(`\n### calendario de referencia (hoje = ${new Intl.DateTimeFormat("en-CA", { timeZone: BRT }).format(new Date())})`);
    for (const d of ["2026-09-19", "2026-09-21", "2026-09-22", "2026-09-26"]) {
      const wd = new Intl.DateTimeFormat("pt-BR", { timeZone: BRT, weekday: "long" }).format(new Date(`${d}T12:00:00-03:00`));
      log(`  ${d} = ${wd}`);
    }
    log(`\n### o que o parser entende das frases do lead`);
    for (const m of ["Tem q ser no sábado", "Sábado às 10:30", "Sábado da p mim", "Náo posso dia de semana", "10 30", "Nem um"]) {
      log(`  ${JSON.stringify(m)}`);
      log(`     requestedDateFromText = ${JSON.stringify(bt.requestedDateFromText(m))}`);
      log(`     requestedPeriodoFromText = ${JSON.stringify(bt.requestedPeriodoFromText(m))}`);
      log(`     looksLikeDecline = ${bt.looksLikeDecline(m)}`);
    }
    expect(true).toBe(true);
  }, 600_000);
});
