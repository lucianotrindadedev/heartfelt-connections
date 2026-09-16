// Read-only: valida as travas novas contra producao.
//  1) turno real do Rodrigo (Odonto Sorrisos, 16/09 09:38): a trava de remetente
//     estranho e a de cortesia disparariam? a citacao seria resolvida?
//  2) falso positivo: em TODAS as conversas ativas dos ultimos 7 dias, quantas a
//     trava de remetente estranho calaria — e sao coringas de verdade?
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
const OUT = path.resolve(process.cwd(), "scripts", "diag", "last-report-coringa-validacao.txt");
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
const { normalizeBrazilPhone } = await import("@/lib/conversation-channel.server");
const { isPlatformNotice } = await import("@/lib/platform-notice");
const g = await import("@/lib/conversation-guards");
const bt = await import("@/lib/booking-template");
const sb = getSelfhost();
const MAX_HISTORY = 50; // mesmo valor do orquestrador
type Row = { role: string; content: string | null; meta: Record<string, unknown> | null; criado_em: string };

function janela(rows: Row[]) {
  const hist: { role: "user" | "assistant"; content: string }[] = [];
  const remet: { from: string | null | undefined }[] = [];
  for (const m of rows) {
    const mm = m.meta ?? {};
    if (mm.fallback === true || mm.is_echo === true || !(m.content ?? "").trim()) continue;
    if (mm.platform_notice === true || isPlatformNotice(m.content)) continue;
    if (m.role === "user") { hist.push({ role: "user", content: m.content ?? "" }); remet.push({ from: mm.channel_from as string | undefined }); }
    else if (m.role === "assistant") hist.push({ role: "assistant", content: m.content ?? "" });
  }
  return { hist, remet };
}

describe("validacao", () => {
  it("turno real + falso positivo", async () => {
    // 1) turno real
    const CONV = "e7787ba7-0753-4e7c-a8dd-9ce6e932b3fc";
    const { data } = await sb.from("messages").select("role, content, meta, criado_em")
      .eq("conversation_id", CONV).lte("criado_em", "2026-09-16T12:38:24Z")
      .order("criado_em", { ascending: false }).limit(MAX_HISTORY);
    const { hist, remet } = janela(((data ?? []) as Row[]).reverse());
    const v = g.detectForeignSender(remet, normalizeBrazilPhone);
    log(`### turno real (Rodrigo, 16/09 09:38)`);
    log(`detectForeignSender -> foreign=${v.foreign} current=${v.current} previous=${JSON.stringify(v.previous)}`);
    log(`isCourtesyOnlyBurst(${JSON.stringify(bt.lastUserBurst(hist))}) -> ${g.isCourtesyOnlyBurst(bt.lastUserBurst(hist))}`);
    const { data: ref } = await sb.from("messages").select("content").eq("meta->>helena_msg_id", "b952048d-1d20-4810-a4c8-9482614046ee").limit(1).maybeSingle();
    log(`citacao refId=b952048d... resolvida no banco -> ${JSON.stringify((ref?.content ?? "").slice(0, 60))}`);
    log(`mensagem gravada passaria a ser -> ${JSON.stringify(g.withQuotePrefix(String(ref?.content ?? ""), "Muito obgd").slice(0, 90))}`);

    // 2) falso positivo em conversas ativas nos ultimos 7 dias
    const desde = new Date(Date.now() - 7 * 86400000).toISOString();
    const convs: { id: string; agent_id: string; phone: string }[] = [];
    for (let f = 0; ; f += 1000) {
      const { data: p } = await sb.from("conversations").select("id, agent_id, phone").gte("atualizado_em", desde).order("id").range(f, f + 999);
      const page = (p ?? []) as typeof convs; convs.push(...page); if (page.length < 1000) break;
    }
    const { data: agents } = await sb.from("agents").select("id, account_id");
    const { data: accounts } = await sb.from("accounts").select("id, nome");
    const accNome = new Map((accounts ?? []).map((a) => [a.id as string, a.nome as string]));
    const conta = new Map((agents ?? []).map((a) => [a.id as string, accNome.get(a.account_id as string) ?? "?"]));
    let flag = 0;
    const flagged: string[] = [];
    for (const c of convs) {
      const { data: ms } = await sb.from("messages").select("role, content, meta, criado_em")
        .eq("conversation_id", c.id).order("criado_em", { ascending: false }).limit(MAX_HISTORY);
      const { remet: r } = janela(((ms ?? []) as Row[]).reverse());
      const vv = g.detectForeignSender(r, normalizeBrazilPhone);
      if (vv.foreign) {
        flag++;
        flagged.push(`${conta.get(c.agent_id)} | phone=${c.phone} | atual=${vv.current} | antes=${vv.previous.length} (${vv.previous.slice(0, 3).join(",")}) | id=${c.id}`);
      }
    }
    log(`\n### falso positivo: conversas ativas nos ultimos 7 dias = ${convs.length}`);
    log(`a trava de remetente estranho calaria: ${flag}`);
    for (const f of flagged) log(`   ${f}`);
    expect(true).toBe(true);
  }, 900_000);
});
