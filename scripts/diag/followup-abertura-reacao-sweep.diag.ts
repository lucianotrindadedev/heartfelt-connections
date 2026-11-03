// Read-only: follow-ups ENVIADOS (90 dias, todas as contas) que removerAberturaDeReacao alteraria,
// separando os que saíram com a última fala da conversa sendo nossa (só nesses a trava age).
// Usa a própria função de produção. Não julga se cada corte está certo: lista para conferência humana
// e conta as aberturas cortadas.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
const OUT = path.resolve(process.cwd(), "scripts", "diag", "last-report-followup-abertura-reacao.txt");
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
const { removerAberturaDeReacao } = await import("@/lib/followup-guard");
const sb = getSelfhost();

describe("followup-abertura-reacao-sweep", () => {
  it("varre", async () => {
    const desde = new Date(Date.now() - 90 * 86_400_000).toISOString();
    let total = 0, mudou = 0;
    const porAbertura = new Map<string, number>();
    const exemplos: string[] = [];
    const candidatos: { conversation_id: string; sent_at: string }[] = [];
    for (let de = 0; ; de += 1000) {
      const { data, error } = await sb.from("followup_step_runs").select("message_sent, conversation_id, sent_at").eq("status", "sent").gte("sent_at", desde).range(de, de + 999);
      if (error) { log(`erro: ${error.message}`); break; }
      for (const r of (data ?? []) as { message_sent: string | null; conversation_id: string; sent_at: string }[]) {
        const t = r.message_sent ?? "";
        total++;
        const novo = removerAberturaDeReacao(t);
        if (novo === t) continue;
        mudou++;
        candidatos.push(r);
        const cortado = t.slice(0, t.length - novo.length).trim().toLowerCase();
        porAbertura.set(cortado, (porAbertura.get(cortado) ?? 0) + 1);
        if (exemplos.length < 80) exemplos.push(`- ANTES: ${t.replace(/\n/g, " | ").slice(0, 160)}\n  DEPOIS: ${novo.replace(/\n/g, " | ").slice(0, 160)}`);
      }
      if (!data || data.length < 1000) break;
    }
    let nossa = 0;
    for (let i = 0; i < candidatos.length; i += 10) {
      const lote = candidatos.slice(i, i + 10);
      const ult = await Promise.all(lote.map(async (c) => {
        const { data } = await sb.from("messages").select("role, meta").eq("conversation_id", c.conversation_id)
          .lt("criado_em", new Date(new Date(c.sent_at).getTime() - 1000).toISOString()).in("role", ["user", "assistant"])
          .order("criado_em", { ascending: false }).limit(1);
        return (data?.[0] as { role: string } | undefined)?.role;
      }));
      nossa += ult.filter((r) => r === "assistant").length;
    }
    log(`follow-ups enviados em 90 dias: ${total}; com abertura cortável: ${mudou}; destes, saíram com a última fala nossa (a trava age): ${nossa}`);
    for (const [k, n] of [...porAbertura.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30)) log(`  ${n}x  "${k}"`);
    log("\nExemplos (conferência humana):");
    for (const e of exemplos) log(e);
    expect(true).toBe(true);
  }, 600_000);
});
