// Read-only: mede a falha silenciosa por dia na Clinicorp, ANTES e DEPOIS do
// retry. Roda contra a agenda real da Odonto Carioca Campo Grande.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
const OUT = path.resolve(process.cwd(), "scripts", "diag", "last-report-flaky.txt");
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

describe("flaky", () => {
  it("repete a mesma consulta", async () => {
    const hoje = fmt(new Date());
    const ate = fmt(new Date(Date.now() + 3 * 86400000));
    const N = 12;
    const totais: number[] = [];
    const falhas: string[][] = [];
    for (let i = 0; i < N; i++) {
      const r = await listClinicorpSlots(ACCOUNT, hoje, ate);
      totais.push(r.slots.length);
      falhas.push(r.failedDates);
    }
    log(`janela ${hoje} -> ${ate}, ${N} execucoes identicas (JA com retry)`);
    log(`total de vagas por execucao: ${totais.join(", ")}`);
    log(`dias NAO consultados        : ${falhas.map((f) => (f.length ? f.join("+") : "-")).join(", ")}`);
    log(`\nexecucoes com algum dia nao consultado: ${falhas.filter((f) => f.length > 0).length}/${N}`);
    log(`execucoes com total ZERO              : ${totais.filter((n) => n === 0).length}/${N}`);
    log(`\nO que mudou: antes, um dia que falhava voltava VAZIO e indistinguivel`);
    log(`de "sem vaga". Agora ele aparece em failedDates e o scheduler manda o`);
    log(`modelo NAO afirmar que o dia esta sem vaga (classifyRequestedDay).`);
    expect(true).toBe(true);
  }, 900_000);
});
