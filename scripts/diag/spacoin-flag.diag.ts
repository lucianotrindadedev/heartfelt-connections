// Read-only: a conversa da SpacoIn que a trava calaria e coringa ou legitima?
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
const OUT = path.resolve(process.cwd(), "scripts", "diag", "last-report-spacoin-flag.txt");
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
const CONV = "07bb662b-c789-46ab-a2a7-feae80ed26c3";
const BR = (s: string) => new Date(s).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" });
describe("spacoin", () => {
  it("olha", async () => {
    const { data: c } = await sb.from("conversations").select("phone, lead_phone, channel_identifier, criado_em, meta").eq("id", CONV).single();
    const ld = ((c?.meta as Record<string, unknown>)?.lead_data ?? {}) as Record<string, unknown>;
    log(`phone=${c?.phone} lead=${c?.lead_phone} ident=${c?.channel_identifier} criada=${BR(c?.criado_em as string)} stage=${(c?.meta as Record<string, unknown>)?.stage} nome=${ld.name}`);
    const all: { role: string; content: string; meta: Record<string, unknown> | null; criado_em: string }[] = [];
    for (let f = 0; ; f += 1000) {
      const { data } = await sb.from("messages").select("role, content, meta, criado_em").eq("conversation_id", CONV).order("criado_em").range(f, f + 999);
      const p = (data ?? []) as typeof all; all.push(...p); if (p.length < 1000) break;
    }
    const cont = new Map<string, number>();
    for (const m of all) if (m.role === "user") { const k = String(m.meta?.channel_from ?? "?"); cont.set(k, (cont.get(k) ?? 0) + 1); }
    log(`${all.length} mensagens, remetentes: ${JSON.stringify([...cont.entries()])}`);
    for (const m of all.slice(-25)) log(`${BR(m.criado_em)} ${m.role}/${m.meta?.origem} from=${m.meta?.channel_from ?? "-"} :: ${JSON.stringify(String(m.content).slice(0, 120))}`);
    expect(true).toBe(true);
  }, 600_000);
});
