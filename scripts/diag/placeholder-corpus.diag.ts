// Read-only: aplica limparMarcadoresDeModelo (a função de produção) em TODAS as
// respostas da IA com colchete dos últimos 90 dias e mostra antes → depois,
// para conferência humana. As que não mudam não podem ter marcador de verdade;
// as que mudam não podem ter perdido conteúdo legítimo.
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
const { limparMarcadoresDeModelo } = await import("@/lib/placeholder-guard");
it("aplica", async () => {
  const sb = getSelfhost();
  const desde = new Date(Date.now() - 90 * 86400_000).toISOString();
  const msgs: Record<string, unknown>[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb.from("messages").select("id, conversation_id, content, meta, criado_em")
      .eq("role", "assistant").like("content", "%[%]%").gte("criado_em", desde).order("id").range(from, from + 999);
    if (error) throw error;
    for (const m of (data ?? []) as Record<string, unknown>[]) {
      const o = ((m.meta ?? {}) as Record<string, unknown>).origem;
      if (o === "agente" || o === "followup") msgs.push(m);
    }
    if (!data || data.length < 1000) break;
  }
  const L = [`respostas da IA com colchete (90d) = ${msgs.length}\n`];
  let mudaram = 0;
  for (const m of msgs.sort((a, b) => String(a.criado_em).localeCompare(String(b.criado_em)))) {
    const { data: c } = await sb.from("conversations").select("meta").eq("id", m.conversation_id as string).single();
    const nome = ((c?.meta as Record<string, unknown>)?.lead_data as Record<string, string> | undefined)?.name ?? null;
    const antes = String(m.content);
    const r = limparMarcadoresDeModelo(antes, nome);
    const mudou = r.texto !== antes.trim();
    if (mudou) mudaram++;
    L.push(`${mudou ? "MUDOU" : "igual"}  ${String(m.criado_em).slice(0, 16)}  nome=${JSON.stringify(nome)}  marcadores=${JSON.stringify(r.marcadores)}`);
    L.push(`   ANTES:  ${antes.replace(/\n/g, " ⏎ ").slice(0, 260)}`);
    if (mudou) L.push(`   DEPOIS: ${r.texto.replace(/\n/g, " ⏎ ").slice(0, 260)}`);
    L.push("");
  }
  L.splice(1, 0, `mudaram = ${mudaram}\n`);
  fs.writeFileSync(path.resolve(process.cwd(), "scripts", "diag", "last-report-placeholder-corpus.txt"), L.join("\n"), "utf8");
}, 600_000);
