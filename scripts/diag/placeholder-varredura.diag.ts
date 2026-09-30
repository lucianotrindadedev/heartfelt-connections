// Read-only: respostas da IA (agente e follow-up) ENVIADAS com marcador de
// modelo entre colchetes ("[Nome]", "[dia]", "[horário]"...) — texto do prompt
// que o modelo copiou sem preencher. Lista para conferência humana.
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
// Colchete com palavra(s) de 2+ letras, sem dígitos/URL: "[Nome]", "[Nome Sobrenome]", "[dia]".
const MARCADOR = /\[(?!Em resposta)(\p{L}[\p{L} /_-]{1,40})\]/u;
it("varre", async () => {
  const sb = getSelfhost();
  const desde = new Date(Date.now() - 90 * 86400_000).toISOString();
  const hits: Record<string, unknown>[] = [];
  let total = 0;
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb.from("messages").select("id, conversation_id, content, meta, criado_em")
      .eq("role", "assistant").like("content", "%[%]%").gte("criado_em", desde).order("id").range(from, from + 999);
    if (error) throw error;
    for (const m of (data ?? []) as Record<string, unknown>[]) {
      const meta = (m.meta ?? {}) as Record<string, unknown>;
      if (meta.origem !== "agente" && meta.origem !== "followup") continue;
      total++;
      if (MARCADOR.test(String(m.content))) hits.push(m);
    }
    if (!data || data.length < 1000) break;
  }
  const convs = [...new Set(hits.map((h) => h.conversation_id as string))];
  const { data: cs } = await sb.from("conversations").select("id, agent_id").in("id", convs.slice(0, 1000));
  const { data: ags } = await sb.from("agents").select("id, account_id");
  const { data: accs } = await sb.from("accounts").select("id, nome");
  const accNome = new Map((accs ?? []).map((a: Record<string, unknown>) => [a.id, a.nome]));
  const agAcc = new Map((ags ?? []).map((a: Record<string, unknown>) => [a.id, accNome.get(a.account_id)]));
  const convAcc = new Map((cs ?? []).map((c: Record<string, unknown>) => [c.id, agAcc.get(c.agent_id)]));
  const marcadores = new Map<string, number>();
  const porConta = new Map<string, number>();
  for (const h of hits) {
    for (const m of String(h.content).matchAll(new RegExp(MARCADOR.source, "gu"))) marcadores.set(m[0], (marcadores.get(m[0]) ?? 0) + 1);
    const c = String(convAcc.get(h.conversation_id as string));
    porConta.set(c, (porConta.get(c) ?? 0) + 1);
  }
  const L = [`respostas da IA com colchete (90d) = ${total}   com marcador de modelo = ${hits.length} em ${convs.length} conversas`,
    `marcadores: ${JSON.stringify(Object.fromEntries([...marcadores].sort((a, b) => b[1] - a[1])))}`,
    `por conta: ${JSON.stringify(Object.fromEntries(porConta))}\n`];
  for (const h of hits.sort((a, b) => String(a.criado_em).localeCompare(String(b.criado_em))))
    L.push(`${String(h.criado_em).slice(0, 16)} ${convAcc.get(h.conversation_id as string)} ${(h.meta as Record<string, unknown>).origem} conv=${h.conversation_id}\n   ${String(h.content).replace(/\n/g, " ⏎ ").slice(0, 240)}\n`);
  fs.writeFileSync(path.resolve(process.cwd(), "scripts", "diag", "last-report-placeholder.txt"), L.join("\n"), "utf8");
}, 600_000);
