// Read-only: conversa do Instagram @wallaceblacklima na Clinica Bomfim.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
const OUT = path.resolve(process.cwd(), "scripts", "diag", "last-report-wallace.txt");
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
const CONV = "885c504a-6788-4692-89a6-682bada476fd";
const AGENT = "7abeb085-b000-41ef-a12b-9604e30b4a6c";
const BR = (s: string) => new Date(s).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" });

describe("wallace", () => {
  it("transcricao", async () => {
    const { data: c } = await sb.from("conversations").select("*").eq("id", CONV).single();
    log(`### meta da conversa\n${JSON.stringify(c?.meta, null, 2)}`);

    const { data: ag } = await sb.from("agents").select("configuracoes").eq("id", AGENT).maybeSingle();
    const cfg = (ag?.configuracoes ?? {}) as Record<string, unknown>;
    const keys = Object.keys(cfg).filter((k) => /booking|campo|field|phone|telefone|canal|channel/i.test(k));
    log(`\n### config do agente (chaves de campos/telefone): ${JSON.stringify(keys)}`);
    for (const k of keys) log(`  ${k} = ${JSON.stringify(cfg[k])}`);

    const { data: msgs } = await sb.from("messages").select("*")
      .eq("conversation_id", CONV).order("criado_em", { ascending: true }).order("id", { ascending: true });
    log(`\n\n### ${msgs?.length ?? 0} mensagens`);
    for (const [i, m] of (msgs ?? []).entries()) {
      const mm = (m.meta ?? {}) as Record<string, unknown>;
      log(`\n[${String(i).padStart(3, "0")}] ${BR(m.criado_em as string)} role=${m.role} origem=${mm.origem ?? "?"} echo=${mm.is_echo ?? false}`);
      log(`     ${JSON.stringify(String(m.content ?? ""))}`);
      const rel = Object.fromEntries(Object.entries(mm).filter(([k]) => k !== "origem"));
      if (Object.keys(rel).length) log(`     meta: ${JSON.stringify(rel)}`);
    }
    expect(true).toBe(true);
  }, 300_000);
});
