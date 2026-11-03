// Read-only: follow-ups ENVIADOS nos últimos 90 dias que citam horário (o prompt do follow-up proíbe oferecer horário)
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
const OUT = path.resolve(process.cwd(), "scripts", "diag", "last-report-followup-cita-horario.txt");
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
const { avaliarTextoDoFollowup } = await import("@/lib/followup-guard");
const sb = getSelfhost();

describe("followup-cita-horario-sweep", () => {
  it("varre", async () => {
    const desde = new Date(Date.now() - 90 * 86_400_000).toISOString();
    const rows: { message_sent: string | null; status: string; sent_at?: string }[] = [];
    for (let de = 0; ; de += 1000) {
      const { data, error } = await sb.from("followup_step_runs").select("*").eq("status", "sent").gte("sent_at", desde).range(de, de + 999);
      if (error) { log(`erro: ${error.message}`); break; }
      rows.push(...((data ?? []) as typeof rows));
      if (!data || data.length < 1000) break;
    }
    let comHorario = 0, jaBarrado = 0;
    for (const r of rows) {
      const t = r.message_sent ?? "";
      if (!/(?<!\d)(?:[01]?\d|2[0-3])(?::[0-5]\d|h(?:[0-5]\d)?)(?!\d)/i.test(t)) continue;
      comHorario++;
      if (avaliarTextoDoFollowup(t).action === "skip") jaBarrado++;
      log(`- ${t.replace(/\n/g, " | ").slice(0, 260)}`);
    }
    log(`\nenviados: ${rows.length}; citam horário: ${comHorario}; já barrados pela trava atual: ${jaBarrado}`);
    expect(true).toBe(true);
  }, 300_000);
});
