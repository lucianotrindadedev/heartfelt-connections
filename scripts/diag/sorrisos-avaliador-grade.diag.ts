// Read-only: configuração Clinicorp da Odonto Sorrisos + grade CRUA da agenda
// online ("DENTISTA AVALIADOR") e agendamentos reais, antes de qualquer filtro.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
const OUT = path.resolve(process.cwd(), "scripts", "diag", "last-report-sorrisos-avaliador.txt");
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
const { decryptValue } = await import("@/lib/crypto.server");
const { listClinicorpProfessionals } = await import("@/lib/tools/clinicorp.server");
const sb = getSelfhost();
const ACC = "ba2a7d4d-7ff9-4eca-9378-8bc8ebb8412b";
const DIAS = ["2026-09-24", "2026-09-25", "2026-09-26", "2026-09-28", "2026-09-29"];

describe("grade", () => {
  it("crua", async () => {
    const { data: cfg } = await sb.from("clinicorp_config").select("*").eq("account_id", ACC).single();
    const semSegredo = Object.fromEntries(Object.entries(cfg!).filter(([k]) => !/token|enc|secret/i.test(k)));
    log(`config=${JSON.stringify(semSegredo)}`);
    const profs = await listClinicorpProfessionals(ACC);
    log(`\nprofissionais (${profs.length}):`);
    for (const p of profs) log(`   ${p.id}  ${p.name}`);
    const token = await decryptValue(cfg!.api_token_enc as string);
    const H = { Authorization: `Basic ${token}`, accept: "application/json" };
    for (const d of DIAS) {
      const u = new URL("https://api.clinicorp.com/rest/v1/appointment/get_avaliable_times_calendar");
      u.searchParams.set("subscriber_id", cfg!.subscriber_id); u.searchParams.set("date", d); u.searchParams.set("code_link", String(cfg!.agenda_id));
      const r = await fetch(u, { headers: H });
      const txt = await r.text();
      let rows: Record<string, unknown>[] = [];
      try { const j = JSON.parse(txt); rows = Array.isArray(j) ? j : (j.data ?? j.times ?? j.available ?? []); if (!Array.isArray(rows)) rows = []; } catch {}
      log(`\n${d} status=${r.status} linhas=${rows.length}`);
      if (rows.length === 0) log(`   raw: ${txt.slice(0, 800)}`);
      log(`   ${rows.map((x) => `${x.From}-${x.To}(${x.ProfessionalId ?? ""})`).join(" ")}`);
    }
    const u = new URL("https://api.clinicorp.com/rest/v1/appointment/list");
    u.searchParams.set("subscriber_id", cfg!.subscriber_id); u.searchParams.set("business_id", String(cfg!.business_id));
    u.searchParams.set("from", DIAS[0]!); u.searchParams.set("to", DIAS[DIAS.length - 1]!);
    const r = await fetch(u, { headers: H });
    const ap = (await r.json()) as Record<string, unknown>[];
    log(`\nagendamentos reais ${DIAS[0]}..${DIAS.at(-1)}: ${Array.isArray(ap) ? ap.length : "?"}`);
    for (const a of (Array.isArray(ap) ? ap : []).filter((a) => !a.Deleted).sort((x, y) => String(x.date ?? "").localeCompare(String(y.date ?? "")) || String(x.fromTime).localeCompare(String(y.fromTime))))
      log(`   ${String(a.date).slice(0, 10)} ${a.fromTime}-${a.toTime} dentista=${a.Dentist_PersonId ?? a.dentist_person_id ?? "?"} cat=${a.CategoryDescription ?? ""}`);
    expect(true).toBe(true);
  }, 300_000);
});
