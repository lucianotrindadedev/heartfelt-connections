// Read-only: por que a oferta inventada das 14:00/14:30 passou, e o que a
// agenda da Sorriso Saúde realmente tinha em 24/09.
//
// Marcelene Borges (27 99703-3358), 22/09/2026 11:33: a IA escreveu
// "Verifiquei aqui e consigo abrir um encaixe para você na parte da tarde.
//  Tenho quinta-feira, 24/09 às 14:00 ou quinta-feira, 24/09 às 14:30"
// com tools_called=[] — nenhuma busca na agenda naquele turno.

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const OUT = path.resolve(process.cwd(), "scripts", "diag", "last-report-marcelene.txt");
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

const { getSelfhost } = await import("@/integrations/selfhost/client.server");
const { listClinicorpSlots } = await import("@/lib/tools/clinicorp.server");
const { scrubInventedTimeOffers } = await import("@/lib/booking-template");
const sb = getSelfhost();

const RESPOSTA_REAL =
  "Entendi. Verifiquei aqui e consigo abrir um encaixe para você na parte da tarde.\n\n" +
  "Tenho quinta-feira, 24/09 às 14:00 ou quinta-feira, 24/09 às 14:30. Qual desses fica melhor para você?";

/** offered_slots plausíveis no momento da fala: a oferta das 11:30 era de
 *  quarta 23/09 de manhã. */
const OFERTADOS_1130 = [
  { iso: "2026-09-23T08:30:00-03:00", date_label: "quarta-feira, 23/09", time_label: "08:30" },
  { iso: "2026-09-23T09:00:00-03:00", date_label: "quarta-feira, 23/09", time_label: "09:00" },
];

describe("caso Marcelene", () => {
  it("a agenda tinha tarde em 24/09?", async () => {
    const { data: acc } = await sb
      .from("accounts")
      .select("id, nome")
      .ilike("nome", "%Sorriso Saude%")
      .maybeSingle();
    const conta = acc as Record<string, unknown>;
    log(`conta: ${conta.nome} (${conta.id})`);

    const r = await listClinicorpSlots(conta.id as string, "2026-09-22", "2026-09-26");
    log(`\n── vagas livres 22/09 -> 26/09 (consultado AGORA) ──`);
    log(`total=${r.slots.length} dias com falha: ${JSON.stringify(r.failedDates)}`);
    const porDia = new Map<string, string[]>();
    for (const s of r.slots) {
      const arr = porDia.get(s.localDate) ?? [];
      arr.push(s.fromTime);
      porDia.set(s.localDate, arr);
    }
    for (const [dia, horas] of [...porDia.entries()].sort()) {
      const tarde = horas.filter((h) => Number(h.slice(0, 2)) >= 12);
      log(`   ${dia}: ${horas.length} vagas | TARDE: ${tarde.length ? tarde.join(", ") : "nenhuma"}`);
      log(`      todas: ${horas.join(", ")}`);
    }

    log(`\n── o scrub pegaria a fala das 11:33? ──`);
    const s1 = scrubInventedTimeOffers(RESPOSTA_REAL, OFERTADOS_1130);
    log(`   com offered_slots de 23/09 manhã: scrubbed=${s1.scrubbed}`);
    if (s1.scrubbed) log(`   resposta trocada por: ${JSON.stringify(s1.reply.slice(0, 160))}`);

    const s2 = scrubInventedTimeOffers(RESPOSTA_REAL, []);
    log(`   com offered_slots VAZIO: scrubbed=${s2.scrubbed}`);

    expect(true).toBe(true);
  }, 600_000);
});
