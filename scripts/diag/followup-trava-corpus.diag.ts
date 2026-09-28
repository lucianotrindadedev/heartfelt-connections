// Read-only: roda avaliarTextoDoFollowup (a trava de produção) em todos os
// follow-ups ENVIADOS dos últimos 90 dias e LISTA os que ela barraria, com o
// motivo, para conferência humana. Nenhum deles deveria ser uma mensagem boa.
import fs from "node:fs";
import path from "node:path";
import { it } from "vitest";
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
const { avaliarTextoDoFollowup } = await import("@/lib/followup-guard");
it("varre", async () => {
  const sb = getSelfhost();
  const desde = new Date(Date.now() - 90 * 86400_000).toISOString();
  const runs: Record<string, unknown>[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb.from("followup_step_runs").select("id, agent_id, conversation_id, sent_at, message_sent")
      .eq("status", "sent").gte("sent_at", desde).order("id").range(from, from + 999);
    if (error) throw error;
    runs.push(...(data ?? []));
    if (!data || data.length < 1000) break;
  }
  const { data: ags } = await sb.from("agents").select("id, account_id");
  const { data: accs } = await sb.from("accounts").select("id, nome");
  const accNome = new Map((accs ?? []).map((a: Record<string, unknown>) => [a.id, a.nome]));
  const agAcc = new Map((ags ?? []).map((a: Record<string, unknown>) => [a.id, accNome.get(a.account_id) ?? a.account_id]));
  const textos = runs.filter((r) => !String(r.message_sent ?? "").startsWith("[template]"));
  const barrados = textos
    .map((r) => ({ r, v: avaliarTextoDoFollowup(String(r.message_sent ?? "")) }))
    .filter((x) => x.v.action === "skip")
    .sort((a, b) => String(a.r.sent_at).localeCompare(String(b.r.sent_at)));
  const L = [`follow-ups de texto enviados (90d) = ${textos.length}   barrados pela trava = ${barrados.length}\n`];
  for (const { r, v } of barrados)
    L.push(`${String(r.sent_at).slice(0, 16)}  ${agAcc.get(r.agent_id)}  [${v.action === "skip" ? v.reason : ""}]\n   ${String(r.message_sent).replace(/\n/g, " ⏎ ").slice(0, 220)}\n`);
  fs.writeFileSync(path.resolve(process.cwd(), "scripts", "diag", "last-report-followup-trava.txt"), L.join("\n"), "utf8");
}, 300_000);
