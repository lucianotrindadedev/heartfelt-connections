// Read-only: o que o endpoint /datas do Clinup devolve a partir de cada ancora.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
const OUT = path.resolve(process.cwd(), "scripts", "diag", "last-report-implanto-datas.txt");
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
const mod = await import("@/lib/tools/clinup.server");
const ACC = "6dabbad9-32f9-415f-8003-9eacac9634f3";
const BRT = "America/Sao_Paulo";
const wd = (d: string) => new Intl.DateTimeFormat("pt-BR", { timeZone: BRT, weekday: "long" }).format(new Date(`${d}T12:00:00-03:00`));

describe("datas", () => {
  it("varre ancoras", async () => {
    // listClinupAvailableDates usa o PRIMEIRO profissional configurado.
    for (const from of ["2026-09-14", "2026-09-19", "2026-09-22", "2026-09-26", "2026-10-01"]) {
      let datas: string[] = [];
      let err = "";
      try { datas = await mod.listClinupAvailableDates(ACC, from); } catch (e) { err = e instanceof Error ? e.message : String(e); }
      log(`\n/datas a partir de ${from} (${wd(from)}): ${err ? "ERRO " + err : `${datas.length} data(s)`}`);
      for (const d of datas) log(`     ${d}  ${wd(d)}${wd(d) === "sábado" ? "   <<< SÁBADO" : ""}`);
    }
    // E a busca completa ancorada no sabado que o humano usou
    const slots = await mod.listClinupSlotsDetailed(ACC, "2026-09-26", "2026-10-10");
    log(`\n### listClinupSlotsDetailed(26/09 -> 10/10): ${slots.length} vagas`);
    const porDia = new Map<string, number>();
    for (const s of slots) porDia.set(s.date, (porDia.get(s.date) ?? 0) + 1);
    for (const [d, n] of [...porDia.entries()].sort()) log(`     ${d} ${wd(d).padEnd(14)} ${n} vagas${wd(d) === "sábado" ? "   <<< SÁBADO" : ""}`);
    expect(true).toBe(true);
  }, 900_000);
});
