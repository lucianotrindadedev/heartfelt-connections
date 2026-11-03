// Read-only: conversa do (11) 97132-3236 (Amazing CCZ) — valores sem escalar e oferta com 3 min de antecedência

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
const OUT = path.resolve(process.cwd(), "scripts", "diag", "last-report-amazing-971323236.txt");
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
const SKIP = new Set(["origem"]);

describe("amazing-971323236", () => {
  it("dump", async () => {
    const { data: convs } = await sb.from("conversations").select("*").or("phone.ilike.%71323236%,lead_phone.ilike.%71323236%");
    for (const c of (convs ?? []) as Record<string, unknown>[]) {
      const { data: ag } = await sb.from("agents").select("id, nome, account_id, settings").eq("id", c.agent_id as string).single();
      log(`CONV ${c.id} lead_name=${c.lead_name ?? c.nome ?? ""} phone=${c.phone} agent=${ag?.nome} account=${ag?.account_id} channel=${c.channel}`);
      log(`meta=${JSON.stringify(c.meta)}`);
      const st = (ag?.settings ?? {}) as Record<string, string>;
      log(`settings=${JSON.stringify(st).slice(0, 20000)}`);
      const { data: msgs } = await sb.from("messages").select("role, content, meta, criado_em").eq("conversation_id", c.id as string).order("criado_em", { ascending: true });
      for (const m of (msgs ?? []) as { role: string; content: string; meta: Record<string, unknown> | null; criado_em: string }[]) {
        const mm = m.meta ?? {};
        const echo = mm.is_echo === true ? " [ECO]" : "";
        log(`\n[${BR(m.criado_em)}] ${m.role}/${mm.origem ?? "?"}${echo}: ${String(m.content ?? "").replace(/\n/g, " | ")}`);
        const tel = Object.keys(mm).filter((k) => !SKIP.has(k)).map((k) => `${k}=${JSON.stringify(mm[k])}`).join("\n      ");
        if (tel) log(`      ${tel.slice(0, 6000)}`);
      }
    }
    expect(true).toBe(true);
  }, 300_000);
});
