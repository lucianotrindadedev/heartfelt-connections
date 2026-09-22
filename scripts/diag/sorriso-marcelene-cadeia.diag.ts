// Read-only: a cadeia completa do caso Marcelene.
//
// (a) A clínica ATENDE à tarde? Vagas livres não distinguem "turno não existe"
//     de "turno lotado" — só os agendamentos reais dizem.
// (b) "Pela manhã tenho compromisso" é lido como PREFERÊNCIA por manhã?
//     Se sim, a auto-seleção escolhe um slot de manhã — o oposto do que a lead
//     disse — e o estágio avança para NAME_COLLECT.

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const OUT = path.resolve(process.cwd(), "scripts", "diag", "last-report-marcelene-cadeia.txt");
const R: string[] = [];
const log = (l = "") => {
  R.push(l);
  fs.writeFileSync(OUT, `${R.join("\n")}\n`, "utf8");
};

function loadEnv() {
  const txt = fs.readFileSync(path.resolve(process.cwd(), ".env.production"), "utf8");
  for (const line of txt.split(/\r?\n/)) {
    if (!line || line.startsWith("#") || !line.includes("=")) continue;
    const i = line.indexOf("=");
    const k = line.slice(0, i).trim();
    if (!process.env[k]) process.env[k] = line.slice(i + 1).trim().replace(/^["']|["']$/g, "");
  }
}
loadEnv();

const { listClinicorpUpcomingAppointments } = await import("@/lib/tools/clinicorp.server");
const {
  tryAutoSelectOfferedSlot,
  looksLikeSchedulingPreference,
  requestedPeriodoFromText,
  isSlotAcceptanceMessage,
} = await import("@/lib/booking-template");

const ACC = "aed440e1-50e7-421d-85aa-72ef8bd2f31e"; // Sorriso Saude

const OFERTA_1130 =
  "Tenho dois horários pela manhã para sua Consulta de Diagnóstico com Dentista Avaliador: quarta-feira, 23/09 às 08:30 ou quarta-feira, 23/09 às 09:00. Qual fica melhor para você?";
const SLOTS = [
  { iso: "2026-09-23T08:30:00-03:00", date_label: "quarta-feira, 23/09", time_label: "08:30" },
  { iso: "2026-09-23T09:00:00-03:00", date_label: "quarta-feira, 23/09", time_label: "09:00" },
];

describe("cadeia do caso Marcelene", () => {
  it("(a) a clínica atende à tarde?", async () => {
    const apps = await listClinicorpUpcomingAppointments(ACC, "2026-09-15", "2026-09-30");
    log(`agendamentos 15/09 -> 30/09: ${apps.length}`);
    const porHora = new Map<string, number>();
    for (const a of apps) {
      const hh = a.start.slice(11, 13);
      porHora.set(hh, (porHora.get(hh) ?? 0) + 1);
    }
    log(`\ndistribuição por hora do dia (agendamentos REAIS):`);
    for (const [h, n] of [...porHora.entries()].sort()) log(`   ${h}h: ${n}`);
    const tarde = apps.filter((a) => Number(a.start.slice(11, 13)) >= 12);
    log(`\nagendamentos à TARDE (>=12h): ${tarde.length} de ${apps.length}`);
    for (const a of tarde.slice(0, 10)) log(`   ${a.start} ${a.patientName.slice(0, 30)}`);
    expect(true).toBe(true);
  }, 600_000);

  it('(b) "Pela manhã tenho compromisso" vira escolha de horário de manhã?', () => {
    const fala = "Pela manhã tenho compromisso";
    log(`\n── a fala "${fala}" ──`);
    log(`   requestedPeriodoFromText   = ${requestedPeriodoFromText(fala)}`);
    log(`   looksLikeSchedulingPreference = ${looksLikeSchedulingPreference(fala)}`);
    log(`   isSlotAcceptanceMessage    = ${isSlotAcceptanceMessage(fala)}`);

    const patch = tryAutoSelectOfferedSlot(
      "SLOT_OFFER",
      { offered_slots: SLOTS } as never,
      [
        { role: "assistant", content: OFERTA_1130 },
        { role: "user", content: fala },
      ],
    );
    log(`   tryAutoSelectOfferedSlot   = ${JSON.stringify(patch)}`);
    log(
      patch.selected_slot_iso
        ? `   >> ESCOLHEU ${patch.selected_slot_iso} — um horário de MANHÃ, que é justamente quando a lead NÃO pode`
        : `   >> não escolheu nada`,
    );
    expect(true).toBe(true);
  });
});
