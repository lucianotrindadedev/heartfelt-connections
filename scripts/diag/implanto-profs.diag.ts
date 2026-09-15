// Read-only: quais profissionais o Clinup tem habilitados e quem atende sábado.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
const OUT = path.resolve(process.cwd(), "scripts", "diag", "last-report-implanto-profs.txt");
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
const ACC = "6dabbad9-32f9-415f-8003-9eacac9634f3";
const BRT = "America/Sao_Paulo";
const wd = (d: string) => new Intl.DateTimeFormat("pt-BR", { timeZone: BRT, weekday: "long" }).format(new Date(`${d}T12:00:00-03:00`));

describe("profs", () => {
  it("dump", async () => {
    const { data } = await sb.from("clinup_config").select("*").eq("account_id", ACC).maybeSingle();
    const row = (data ?? {}) as Record<string, unknown>;
    const red = Object.fromEntries(Object.entries(row).map(([k, v]) => {
      if (/key|token|secret|senha|pass/i.test(k)) return [k, v ? "<oculto>" : null];
      return [k, v];
    }));
    log(`### clinup_config\n${JSON.stringify(red, null, 2).slice(0, 2500)}`);

    const profs = (row.professionals ?? []) as Record<string, unknown>[];
    log(`\n### profissionais configurados: ${Array.isArray(profs) ? profs.length : 0}`);

    const { loadClinupConfigForDiag } = {} as never;
    void loadClinupConfigForDiag;
    const mod = await import("@/lib/tools/clinup.server");
    const hoje = new Intl.DateTimeFormat("en-CA", { timeZone: BRT }).format(new Date());
    const fim = new Intl.DateTimeFormat("en-CA", { timeZone: BRT }).format(new Date(Date.now() + 35 * 86400000));
    const slots = await mod.listClinupSlotsDetailed(ACC, hoje, fim);
    const porProf = new Map<string, Map<string, number>>();
    for (const s of slots) {
      const m = porProf.get(s.profissionalId) ?? new Map<string, number>();
      m.set(s.date, (m.get(s.date) ?? 0) + 1);
      porProf.set(s.profissionalId, m);
    }
    log(`\n### vagas por profissional (${hoje} -> ${fim}, 35 dias) — total ${slots.length}`);
    for (const [pid, dias] of porProf) {
      const nome = slots.find((s) => s.profissionalId === pid)?.professionalName ?? "?";
      log(`\n  profissional ${pid} (${nome}):`);
      for (const [d, n] of [...dias.entries()].sort()) {
        log(`     ${d} ${wd(d).padEnd(14)} ${String(n).padStart(3)} vagas${wd(d) === "sábado" ? "  <<< SÁBADO" : ""}`);
      }
    }
    const temSabado = slots.some((s) => wd(s.date) === "sábado");
    log(`\n>>> a integração devolve ALGUM sábado em 35 dias? ${temSabado ? "SIM" : "NÃO"}`);
    expect(true).toBe(true);
  }, 900_000);
});
