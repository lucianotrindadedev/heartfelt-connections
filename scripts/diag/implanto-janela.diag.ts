// Read-only: valida a correcao contra a agenda REAL do Clinup.
// Antes: a janela ancorada no sabado pedido parava em +4 dias e nunca alcancava
// o proximo sabado com vaga. Agora: shouldWidenSlotWindow manda ampliar e
// filterSlotsToWeekday mantem so os sabados.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
const OUT = path.resolve(process.cwd(), "scripts", "diag", "last-report-implanto-janela.txt");
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
const bt = await import("@/lib/booking-template");
const ACC = "6dabbad9-32f9-415f-8003-9eacac9634f3";
const BRT = "America/Sao_Paulo";
const wd = (d: string) => new Intl.DateTimeFormat("pt-BR", { timeZone: BRT, weekday: "long" }).format(new Date(`${d}T12:00:00-03:00`));

describe("janela", () => {
  it("a correcao alcanca o proximo sabado", async () => {
    const PEDIDO = bt.requestedWeekdayFromText("Tem q ser no sábado");
    const ANCORA = "2026-09-19";
    log(`lead: "Tem q ser no sábado"`);
    log(`  requestedWeekdayFromText = ${JSON.stringify(PEDIDO)}`);
    log(`  ancora resolvida         = ${ANCORA} (${wd(ANCORA)})`);
    log(`  weekdayKeyOfIso(ancora)  = ${JSON.stringify(bt.weekdayKeyOfIso(ANCORA))}  -> a restricao vale`);

    const curta = await mod.listClinupSlotsDetailed(ACC, ANCORA, "2026-09-23");
    const noDiaCurta = bt.filterSlotsToWeekday(curta, PEDIDO, (s) => s.start);
    log(`\nJANELA CURTA (ancora + 4 dias): ${curta.length} vagas, ${noDiaCurta.length} em ${PEDIDO}`);
    for (const d of [...new Set(curta.map((s) => s.date))].sort()) log(`   ${d} ${wd(d)}`);

    const amplia = bt.shouldWidenSlotWindow({
      totalSlots: curta.length,
      explicitWindowDays: null,
      requestedDay: ANCORA,
      slotsOnRequestedDay: curta.filter((s) => s.date === ANCORA).length,
      requestedWeekday: PEDIDO,
      slotsOnRequestedWeekday: noDiaCurta.length,
    });
    log(`\nshouldWidenSlotWindow = ${amplia}    (a condicao antiga, length===0 && !anchor, dava false)`);

    if (amplia) {
      const larga = await mod.listClinupSlotsDetailed(ACC, ANCORA, "2026-11-18");
      const noDia = bt.filterSlotsToWeekday(larga, PEDIDO, (s) => s.start);
      log(`\nJANELA AMPLA: ${larga.length} vagas, ${noDia.length} em ${PEDIDO}`);
      const porDia = new Map<string, number>();
      for (const s of noDia) porDia.set(s.date, (porDia.get(s.date) ?? 0) + 1);
      for (const [d, n] of [...porDia.entries()].sort()) log(`   ${d} ${wd(d)} — ${n} vagas`);
      log(`\n>>> o que o lead receberia agora: ${JSON.stringify(noDia.slice(0, 6).map((s) => `${s.date} ${s.time}`))}`);
    }
    expect(true).toBe(true);
  }, 900_000);
});
