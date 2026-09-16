// Read-only: quantas conversas "coringa" existem — conversa cujo phone e o
// numero do PROPRIO canal da clinica e que junta mensagens de muitos contatos.
// Assinatura: o phone da conversa aparece como channel_identifier de varias
// outras conversas do mesmo agente.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
const OUT = path.resolve(process.cwd(), "scripts", "diag", "last-report-coringa.txt");
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

describe("coringa", () => {
  it("mede", async () => {
    type C = { id: string; agent_id: string; phone: string; channel_identifier: string | null; atualizado_em: string };
    const convs: C[] = [];
    for (let f = 0; ; f += 1000) {
      const { data } = await sb.from("conversations").select("id, agent_id, phone, channel_identifier, atualizado_em")
        .order("id", { ascending: true }).range(f, f + 999);
      const p = (data ?? []) as C[];
      convs.push(...p);
      if (p.length < 1000) break;
    }
    const { data: agents } = await sb.from("agents").select("id, account_id");
    const { data: accounts } = await sb.from("accounts").select("id, nome");
    const accNome = new Map((accounts ?? []).map((a) => [a.id as string, a.nome as string]));
    const contaDoAgente = new Map((agents ?? []).map((a) => [a.id as string, accNome.get(a.account_id as string) ?? "?"]));

    // por agente: quantas conversas usam cada numero como channel_identifier
    const identCount = new Map<string, number>();
    for (const c of convs) if (c.channel_identifier) {
      const k = `${c.agent_id}|${c.channel_identifier}`;
      identCount.set(k, (identCount.get(k) ?? 0) + 1);
    }
    log(`conversas analisadas: ${convs.length}`);
    const suspeitas = convs.filter((c) => (identCount.get(`${c.agent_id}|${c.phone}`) ?? 0) >= 3 && /^\d{10,11}$/.test(c.phone));
    log(`\n### conversas cujo phone e channel_identifier de >=3 conversas do mesmo agente: ${suspeitas.length}\n`);
    for (const s of suspeitas) {
      const all: { role: string; meta: Record<string, unknown> | null }[] = [];
      for (let f = 0; ; f += 1000) {
        const { data } = await sb.from("messages").select("role, meta").eq("conversation_id", s.id).range(f, f + 999);
        const p = (data ?? []) as typeof all;
        all.push(...p);
        if (p.length < 1000) break;
      }
      const remet = new Set(all.filter((m) => m.role === "user").map((m) => String((m.meta ?? {}).channel_from ?? "?")));
      const agente = all.filter((m) => (m.meta ?? {}).origem === "agente").length;
      log(`${contaDoAgente.get(s.agent_id)} | phone=${s.phone} | ${all.length} msgs | ${remet.size} remetentes distintos | ${agente} respostas da IA | ident de ${identCount.get(`${s.agent_id}|${s.phone}`)} conversas | atualizada ${BR(s.atualizado_em)} | id=${s.id}`);
    }
    expect(true).toBe(true);
  }, 900_000);
});
