import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
const OUT = path.resolve(process.cwd(), "scripts", "diag", "last-report-periodo.txt");
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
const bt = await import("@/lib/booking-template");
const MSGS = ["Oi bom dia", "Preciso arrancar um dente siso", "Seis meses", "Preciso extrair um dente para hoje", "Eu moro em Inhoaíba"];
describe("periodo", () => {
  it("infere turno?", () => {
    for (const m of MSGS) {
      log(`${JSON.stringify(m)}`);
      log(`   requestedPeriodoFromText = ${JSON.stringify(bt.requestedPeriodoFromText(m))}`);
      log(`   requestedDateFromText    = ${JSON.stringify(bt.requestedDateFromText(m))}`);
    }
    expect(true).toBe(true);
  });
});
