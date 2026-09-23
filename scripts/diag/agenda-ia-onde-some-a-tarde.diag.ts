// Read-only: em que etapa a TARDE da "AGENDA IA" (Sorriso Saúde) desaparece?
//
// O usuário informou que a agenda abre 08:30–17:30 em terça, quarta e quinta;
// só segunda e sexta fecham à tarde. A busca do agente vinha devolvendo só
// manhã — então ou a grade já chega sem tarde, ou um dos nossos filtros a come.
//
// listClinicorpSlots loga "[clinicorp] fechamento: removidos X/Y" e
// "[clinicorp] cross-check: removidos X/Y". Este diag só chama a função e
// deixa esses logs aparecerem, dia a dia. Nenhuma chamada crua, nenhuma
// escrita — exatamente o mesmo caminho que o agente usa.

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const OUT = path.resolve(process.cwd(), "scripts", "diag", "last-report-agenda-ia.txt");
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
    if (!process.env[k])
      process.env[k] = line
        .slice(i + 1)
        .trim()
        .replace(/^["']|["']$/g, "");
  }
}
loadEnv();

const { listClinicorpSlots } = await import("@/lib/tools/clinicorp.server");

const ACC = "aed440e1-50e7-421d-85aa-72ef8bd2f31e"; // Sorriso Saude
const DIAS = Number(process.env.DIAS || 10);
const SEMANA = ["domingo", "segunda", "terça", "quarta", "quinta", "sexta", "sábado"];
const diaSemana = (ymd: string) => SEMANA[new Date(`${ymd}T12:00:00-03:00`).getDay()] ?? "?";

describe("onde some a tarde da AGENDA IA", () => {
  it("dia a dia", async () => {
    const hoje = new Date();
    log(`AGENDA IA / Sorriso Saúde — ${DIAS} dias a partir de hoje\n`);
    log(`Esperado pelo usuário: ter/qua/qui 08:30–17:30 | seg/sex sem tarde\n`);

    for (let i = 0; i < DIAS; i++) {
      const dia = new Date(hoje.getTime() + i * 86400_000).toISOString().slice(0, 10);

      // Captura os logs que a própria listClinicorpSlots emite neste dia.
      const capturado: string[] = [];
      const origLog = console.log;
      const origWarn = console.warn;
      console.log = (...a: unknown[]) => {
        const s = a.map(String).join(" ");
        if (s.includes("[clinicorp]")) capturado.push(s);
      };
      console.warn = console.log;

      let res;
      try {
        res = await listClinicorpSlots(ACC, dia, dia);
      } finally {
        console.log = origLog;
        console.warn = origWarn;
      }

      const horas = res.slots.map((s) => s.fromTime).sort();
      const tarde = horas.filter((h) => Number(h.slice(0, 2)) >= 12);
      const esperaTarde = !["segunda", "sexta", "domingo", "sábado"].includes(diaSemana(dia));

      log(
        `${dia} (${diaSemana(dia).padEnd(7)}) ${res.slots.length} vagas | última=${horas.at(-1) ?? "-"} | TARDE=${tarde.length}` +
          (esperaTarde && tarde.length === 0 ? "   <== deveria ter tarde" : ""),
      );
      if (horas.length) log(`   ${horas.join(", ")}`);
      if (res.failedDates.length) log(`   dias que a consulta FALHOU: ${JSON.stringify(res.failedDates)}`);
      if (res.busyCheckFailed) log(`   ⚠️ a checagem de ocupados falhou — vagas podem estar infladas`);
      for (const c of capturado) log(`   log: ${c}`);
    }
    expect(true).toBe(true);
  }, 600_000);
});
