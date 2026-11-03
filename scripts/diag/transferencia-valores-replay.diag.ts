// Read-only: respostas do agente (60 dias) que a nova prometeTransferenciaHumana
// passa a reconhecer como transferência para a equipe. Cada uma, em produção,
// deixa de ser trocada pela trava anti-enrolação e FORÇA a escalada (ghost
// escalation). Baseline = origin/main via git show (_baseline-stage-signals.ts).
// O diag não julga se a escalada era devida: lista os casos para conferência humana.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
const OUT = path.resolve(process.cwd(), "scripts", "diag", "last-report-transferencia-valores-replay.txt");
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
const novo = await import("@/lib/agents/stage-signals");
const antigo = await import("./_baseline-stage-signals");
const sb = getSelfhost();
const BR = (s: string) => new Date(s).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" });

describe("transferencia-valores-replay", () => {
  it("varre", async () => {
    const desde = new Date(Date.now() - 60 * 86_400_000).toISOString();
    let total = 0, ganhou = 0, perdeu = 0;
    for (let de = 0; ; de += 1000) {
      const { data, error } = await sb.from("messages").select("conversation_id, content, meta, criado_em")
        .eq("role", "assistant").gte("criado_em", desde).order("criado_em", { ascending: true }).range(de, de + 999);
      if (error) { log(`erro: ${error.message}`); break; }
      for (const m of (data ?? []) as { conversation_id: string; content: string; meta: Record<string, unknown> | null; criado_em: string }[]) {
        const mm = m.meta ?? {};
        if (mm.is_echo === true || !mm.agent) continue; // só fala do agente
        total++;
        const texto = String(mm.reply_llm_original ?? m.content ?? "");
        const a = antigo.prometeTransferenciaHumana(texto);
        const n = novo.prometeTransferenciaHumana(texto);
        if (a === n) continue;
        if (n) ganhou++; else perdeu++;
        log(`\n[${BR(m.criado_em)}] ${n ? "PASSA A RECONHECER" : "DEIXA DE RECONHECER"} conv=${m.conversation_id} stage=${mm.stage_from}→${mm.stage_to} trava=${mm.stall_reply_blocked ? "sim" : "não"}`);
        log(`  ${texto.replace(/\n/g, " | ").slice(0, 300)}`);
      }
      if (!data || data.length < 1000) break;
    }
    log(`\nrespostas do agente em 60 dias: ${total}; passam a reconhecer: ${ganhou}; deixam de reconhecer: ${perdeu}`);
    expect(true).toBe(true);
  }, 600_000);
});
