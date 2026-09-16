// Read-only: confirma que o "Feliz aniversario, RODRIGO" esta na conversa coringa
// e o que a IA tinha como contexto no turno das 09:38.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
const OUT = path.resolve(process.cwd(), "scripts", "diag", "last-report-sorrisos-aniv.txt");
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
const bt = await import("@/lib/booking-template");
const sb = getSelfhost();
const CONV = "e7787ba7-0753-4e7c-a8dd-9ce6e932b3fc";
const BR = (s: string) => new Date(s).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" });

describe("aniv", () => {
  it("confere", async () => {
    const { data } = await sb.from("messages").select("role, content, meta, criado_em")
      .eq("conversation_id", CONV).gte("criado_em", "2026-09-15T18:00:00Z").lte("criado_em", "2026-09-16T12:40:00Z")
      .order("criado_em", { ascending: true });
    for (const m of (data ?? []) as { role: string; content: string; meta: Record<string, unknown>; criado_em: string }[]) {
      log(`${BR(m.criado_em)} ${m.role}/${m.meta?.origem} from=${m.meta?.channel_from ?? "-"} :: ${JSON.stringify(String(m.content).slice(0, 110))}`);
      if (m.role === "user") log(`     meta completo: ${JSON.stringify(m.meta)}`);
    }
    // Historico como o orquestrador monta (ultimos 30) antes do turno das 09:38
    const { data: h } = await sb.from("messages").select("role, content, meta, criado_em")
      .eq("conversation_id", CONV).lt("criado_em", "2026-09-16T12:38:50Z")
      .order("criado_em", { ascending: false }).limit(30);
    const hist = ((h ?? []) as { role: string; content: string; meta: Record<string, unknown> }[]).reverse()
      .filter((m) => m.meta?.is_echo !== true && m.meta?.fallback !== true && String(m.content ?? "").trim());
    const agentReplies = hist.filter((m) => m.meta?.origem === "agente").map((m) => m.content);
    log(`\n### ultimas falas do AGENTE que a IA via no turno das 09:38:`);
    for (const a of agentReplies.slice(-3)) log(`   ${JSON.stringify(String(a).slice(0, 140))}`);
    log(`\nlooksLikeGratitudeOrClosing("Muito obgd") = ${bt.looksLikeGratitudeOrClosing("Muito obgd")}`);
    expect(true).toBe(true);
  }, 600_000);
});
