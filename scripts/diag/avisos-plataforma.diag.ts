// Read-only: catalogo dos avisos da PLATAFORMA gravados como fala do lead.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
const OUT = path.resolve(process.cwd(), "scripts", "diag", "last-report-avisos.txt");
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

describe("avisos", () => {
  it("cataloga", async () => {
    const SINCE = "2026-06-25T00:00:00Z";
    const counts = new Map<string, number>();
    for (let from = 0; ; from += 1000) {
      const { data } = await sb.from("messages").select("content")
        .gte("criado_em", SINCE).eq("role", "user").like("content", "%Atenção:%")
        .order("criado_em", { ascending: true }).range(from, from + 999);
      const rows = data ?? [];
      for (const r of rows) {
        const c = String(r.content ?? "").trim().slice(0, 160);
        counts.set(c, (counts.get(c) ?? 0) + 1);
      }
      if (rows.length < 1000) break;
    }
    log(`### mensagens role=user contendo "Atenção:" desde ${SINCE.slice(0, 10)}`);
    log(`textos distintos: ${counts.size}`);
    for (const [c, n] of [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30)) {
      log(`  ${String(n).padStart(5)}x  ${JSON.stringify(c)}`);
    }
    expect(true).toBe(true);
  }, 900_000);
});
