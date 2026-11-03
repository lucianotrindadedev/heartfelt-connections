// Read-only: passos de follow-up do agente da Amazing CCZ e como os follow-ups enviados começam
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
const OUT = path.resolve(process.cwd(), "scripts", "diag", "last-report-amazing-followup-aberturas.txt");
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
const AGENT = "4149b68f-e6b0-430f-9606-e2f18984f5b3";
const BR = (s: string) => new Date(s).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" });

describe("amazing-followup-aberturas", () => {
  it("dump", async () => {
    const { data: steps } = await sb.from("followup_steps").select("*").eq("agent_id", AGENT).order("ordem");
    const ordemDo = new Map<string, number>();
    for (const s of (steps ?? []) as Record<string, unknown>[]) {
      ordemDo.set(s.id as string, s.ordem as number);
      log(`PASSO ${s.ordem} enabled=${s.enabled} ${s.delay_value}${s.delay_unit} mode=${s.mode} criado=${BR(s.criado_em as string)} atualizado=${BR(s.atualizado_em as string)}\n  instrucao=${JSON.stringify(s.contextual_instruction)}`);
    }
    const { data: runs } = await sb.from("followup_step_runs").select("step_id, message_sent, status, sent_at").eq("agent_id", AGENT).order("sent_at", { ascending: true });
    const cont = new Map<string, number>();
    let enviados = 0;
    for (const r of (runs ?? []) as { step_id: string; message_sent: string | null; status: string; sent_at: string }[]) {
      if (r.status !== "sent") continue;
      enviados++;
      const ab = (r.message_sent ?? "").trim().split(/[!,.?\n]/)[0]!.slice(0, 30);
      const k = `passo ${ordemDo.get(r.step_id) ?? "?"} | ${ab}`;
      cont.set(k, (cont.get(k) ?? 0) + 1);
    }
    log(`\nfollow-ups enviados pela Amazing: ${enviados}`);
    for (const [k, n] of [...cont.entries()].sort((a, b) => b[1] - a[1]).slice(0, 40)) log(`  ${n}x  ${k}`);
    expect(true).toBe(true);
  }, 300_000);
});
