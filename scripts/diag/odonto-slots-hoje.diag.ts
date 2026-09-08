import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
const OUT = path.resolve(process.cwd(), "scripts", "diag", "last-report-slots.txt");
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
const { listClinicorpSlots } = await import("@/lib/tools/clinicorp.server");
const ACCOUNT = "379341ec-6385-48c0-af27-a174ceb26f82";
const BRT = "America/Sao_Paulo";
const fmt = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: BRT }).format(d);

describe("slots", () => {
  it("matriz de janelas", async () => {
    const now = new Date();
    const dia = (n: number) => fmt(new Date(now.getTime() + n * 86400000));
    log(`agora (BRT): ${now.toLocaleString("pt-BR", { timeZone: BRT })}`);
    log(`hoje=${dia(0)}\n`);
    const janelas: [string, string][] = [
      [dia(0), dia(0)],
      [dia(0), dia(0)],
      [dia(0), dia(1)],
      [dia(0), dia(2)],
      [dia(0), dia(3)],
      [dia(0), dia(4)],
    ];
    for (const [f, t] of janelas) {
      const s = (await listClinicorpSlots(ACCOUNT, f, t)).slots as { localDate: string; fromTime: string }[];
      const hoje = s.filter((x) => x.localDate === dia(0));
      const dias = [...new Set(s.map((x) => x.localDate))].sort().join(", ");
      log(`${f} -> ${t}  | total=${String(s.length).padStart(3)} | HOJE=${String(hoje.length).padStart(2)} | dias devolvidos: ${dias || "(nenhum)"}`);
      if (hoje.length) log(`      hoje: ${hoje.map((x) => x.fromTime).join(" ")}`);
    }
    expect(true).toBe(true);
  }, 900_000);
});
