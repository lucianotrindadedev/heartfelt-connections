// Read-only: varre booking_error nas mensagens (quem falha, com que erro, desde quando).
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
const OUT = path.resolve(process.cwd(), "scripts", "diag", "last-report-booking-errors.txt");
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
const BR = (s: string) => new Date(s).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" });

describe("sweep", () => {
  it("varre", async () => {
    const desde = new Date(Date.now() - 90 * 86400_000).toISOString();
    const { data, error } = await sb.from("messages")
      .select("conversation_id, meta, criado_em")
      .not("meta->>booking_error", "is", null)
      .gte("criado_em", desde)
      .order("criado_em", { ascending: true });
    log(`erro=${JSON.stringify(error)} mensagens com booking_error (90d)=${data?.length ?? 0}\n`);
    const rows = (data ?? []) as { conversation_id: string; meta: Record<string, unknown>; criado_em: string }[];

    // resolve conta de cada conversa
    const convIds = [...new Set(rows.map((r) => r.conversation_id))];
    const convAgent = new Map<string, string>();
    for (let i = 0; i < convIds.length; i += 200) {
      const { data: cs } = await sb.from("conversations").select("id, agent_id").in("id", convIds.slice(i, i + 200));
      for (const c of (cs ?? []) as { id: string; agent_id: string }[]) convAgent.set(c.id, c.agent_id);
    }
    const agentIds = [...new Set([...convAgent.values()])];
    const agentAcc = new Map<string, string>();
    const { data: ags } = await sb.from("agents").select("id, account_id").in("id", agentIds);
    for (const a of (ags ?? []) as { id: string; account_id: string }[]) agentAcc.set(a.id, a.account_id);
    const { data: accs } = await sb.from("accounts").select("id, nome").in("id", [...new Set([...agentAcc.values()])]);
    const accName = new Map<string, string>();
    for (const a of (accs ?? []) as { id: string; nome: string }[]) accName.set(a.id, a.nome);
    const contaDe = (convId: string) => accName.get(agentAcc.get(convAgent.get(convId) ?? "") ?? "") ?? "?";

    const porErro = new Map<string, { n: number; contas: Set<string>; convs: Set<string>; first: string; last: string }>();
    for (const r of rows) {
      const err = String(r.meta.booking_error ?? "").replace(/\+"/g, '"').slice(0, 160);
      const chave = err.replace(/\d{4,}/g, "N");
      const e = porErro.get(chave) ?? { n: 0, contas: new Set<string>(), convs: new Set<string>(), first: r.criado_em, last: r.criado_em };
      e.n++; e.contas.add(contaDe(r.conversation_id)); e.convs.add(r.conversation_id); e.last = r.criado_em;
      porErro.set(chave, e);
    }
    log("=== erros agrupados ===");
    for (const [k, v] of [...porErro.entries()].sort((a, b) => b[1].n - a[1].n)) {
      log(`\n[${v.n}x em ${v.convs.size} conversas] ${BR(v.first)} -> ${BR(v.last)}`);
      log(`  contas: ${[...v.contas].join(", ")}`);
      log(`  erro: ${k}`);
    }

    log("\n\n=== Odonto Sorrisos, linha do tempo ===");
    for (const r of rows.filter((r) => contaDe(r.conversation_id) === "Odonto Sorrisos")) {
      log(`  ${BR(r.criado_em)} conv=${r.conversation_id.slice(0, 8)} kind=${r.meta.booking_failure_kind} ${String(r.meta.booking_error).replace(/\+"/g, '"').slice(0, 120)}`);
    }
    expect(true).toBe(true);
  }, 600_000);
});
