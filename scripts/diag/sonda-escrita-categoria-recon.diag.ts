// Read-only: reconhecimento ANTES da sonda de escrita (sonda-escrita-categoria.diag.ts).
// Acha um horário livre distante e vê se já existe cadastro de teste, para a
// sonda deixar o mínimo de rastro na base da clínica.

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const OUT = path.resolve(process.cwd(), "scripts", "diag", "last-report-sonda-recon.txt");
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

const { listClinicorpSlots, findClinicorpPatient } = await import("@/lib/tools/clinicorp.server");
const ACC = "ba2a7d4d-7ff9-4eca-9378-8bc8ebb8412b"; // Odonto Sorrisos
const TEL_TESTE = process.env.TEL_TESTE || "87999999999";

describe("sonda: reconhecimento", () => {
  it("levanta", async () => {
    // Janela distante: 28 a 35 dias à frente, longe da operação do dia.
    const de = new Date(Date.now() + 28 * 86400_000).toISOString().slice(0, 10);
    const ate = new Date(Date.now() + 35 * 86400_000).toISOString().slice(0, 10);
    log(`janela ${de} -> ${ate}`);

    const r = await listClinicorpSlots(ACC, de, ate);
    log(`slots livres: ${r.slots.length}  dias com falha: ${r.failedDates.length}`);
    // O ÚLTIMO slot da janela: o mais distante possível da agenda real de hoje.
    const alvo = r.slots[r.slots.length - 1];
    log(`\nslot alvo (mais distante): ${JSON.stringify(alvo)}`);

    const jaExiste = await findClinicorpPatient(ACC, TEL_TESTE, "TESTE INTEGRACAO");
    log(`\npaciente de teste (${TEL_TESTE}): ${jaExiste ? JSON.stringify(jaExiste) : "NAO existe (a sonda vai criar um)"}`);

    expect(true).toBe(true);
  }, 300_000);
});
