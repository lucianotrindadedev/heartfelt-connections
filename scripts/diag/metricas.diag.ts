// Read-only: roda o agregador de métricas contra uma conta real e imprime o
// resultado, pra validar que os números fecham antes de subir o painel.
//   DIAG_ACCOUNT=<id> npx vitest run --config scripts/diag/vitest.diag.config.ts scripts/diag/metricas.diag.ts
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
const OUT = path.resolve(process.cwd(), "scripts", "diag", "last-report-metricas.txt");
const R: string[] = [];
const log = (l = "") => { R.push(l); fs.writeFileSync(OUT, `${R.join("\n")}\n`, "utf8"); };
function loadEnv() {
  const txt = fs.readFileSync(path.resolve(process.cwd(), ".env.production"), "utf8");
  for (const line of txt.split(/\r?\n/)) {
    if (!line || line.startsWith("#") || !line.includes("=")) continue;
    const i = line.indexOf("=");
    const k = line.slice(0, i).trim();
    if (!process.env[k]) process.env[k] = line.slice(i + 1).trim().replace(/^["']|["']$/g, "");
  }
}
loadEnv();
const { getSelfhost } = await import("@/integrations/selfhost/client.server");
const { loadAgentMetrics } = await import("@/lib/metrics/load.server");
const { OBJECTION_LABELS } = await import("@/lib/metrics/lead-signals");
const sb = getSelfhost();

describe("metricas", () => {
  it("agrega", async () => {
    let accountId = (process.env.DIAG_ACCOUNT ?? "").trim();
    if (!accountId) {
      const { data } = await sb.from("accounts").select("id, nome").ilike("nome", "%MF Beauty%");
      log(`contas MF Beauty: ${JSON.stringify(data)}`);
      accountId = (data ?? []).find((a) => /central/i.test(String(a.nome)))?.id as string
        ?? (data ?? [])[0]?.id as string;
    }
    if (!accountId) { log("sem conta"); expect(true).toBe(true); return; }

    const t0 = Date.now();
    const m = await loadAgentMetrics(accountId, 30);
    log(`\n### conta=${accountId} agente=${m.agentName} — ${Date.now() - t0}ms, truncado=conversas:${m.truncated.conversas} mensagens:${m.truncated.mensagens}`);
    log(`\nKPIs: ${JSON.stringify(m.kpis, null, 1)}`);
    log(`\nTempo de resposta: ${JSON.stringify(m.tempoResposta, null, 1)}`);
    log(`\nFunil: ${m.funil.map((f) => `${f.label}=${f.count}`).join("  ")}`);
    log(`\nCanais: ${m.canais.map((c) => `${c.label}=${c.count}`).join("  ")}`);
    log(`\nInteresses: ${m.interesses.map((i) => `${i.label}(${i.count})`).join(", ") || "—"}`);
    log(`\nObjeções (${m.objecoesLeadsAnalisados} conversas analisadas):`);
    for (const o of m.objecoes) log(`   ${String(o.count).padStart(4)}  ${OBJECTION_LABELS[o.key]}`);
    if (!m.objecoes.length) log("   —");
    log(`\nEscaladas: ${m.escaladas.map((e) => `${e.motivo}(${e.count})`).join(", ") || "—"}`);
    log(`\nSaúde do agendamento: ${m.saudeAgendamento.map((s) => `${s.label}(${s.count})`).join(", ") || "—"}`);
    log(`\nÚltimos agendamentos (${m.agendamentos.length}):`);
    for (const a of m.agendamentos.slice(0, 10)) {
      log(`   ${a.name} | consulta=${a.slotIso ?? "—"} | ${a.interest ?? "—"} | ${a.agenda ?? "—"} | marcado=${a.bookedAt}`);
    }
    log(`\nSérie diária: ${m.daily.length} dias, ${m.daily.reduce((s, d) => s + d.conversas, 0)} conversas iniciadas`);
    expect(true).toBe(true);
  }, 300_000);
});
