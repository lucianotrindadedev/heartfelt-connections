// Read-only: as ofertas da Clinica Bomfim estão vindo perto?
//
// Mede a DISTÂNCIA entre o dia em que o agente ofertou e o primeiro horário
// ofertado. O caso da Milene (21 99004-9579, 21/09) foi ofertado com 7 dias de
// distância (28/09) tendo 22, 23 e 24/09 livres.
//
// Também mostra a cobertura de turno da lista: o prompt da conta exige
// contraturno (1 manhã + 1 tarde), e antes do PR #55 a lista podia vir com um
// turno só, tornando isso impossível.

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const OUT = path.resolve(process.cwd(), "scripts", "diag", "last-report-bomfim-distancia.txt");
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

const { getSelfhost } = await import("@/integrations/selfhost/client.server");
const sb = getSelfhost();
const ACC = "9d03ada1-0a96-483a-94e8-fce87d8bbf40"; // Clinica Bomfim
const DESDE = process.env.DESDE || "2026-09-14T00:00:00Z"; // 7 dias por padrão
const BR = (s: string) => new Date(s).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" });
const diaBrt = (iso: string) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(new Date(iso));
const difDias = (de: string, ate: string) =>
  Math.round(
    (new Date(`${ate}T12:00:00-03:00`).getTime() - new Date(`${de}T12:00:00-03:00`).getTime()) /
      86400000,
  );

describe("distância das ofertas da Bomfim", () => {
  it("mede", async () => {
    const { data: ags } = await sb.from("agents").select("id").eq("account_id", ACC);
    const agentIds = ((ags ?? []) as Record<string, unknown>[]).map((a) => a.id as string);
    const { data: convs } = await sb
      .from("conversations")
      .select("id, meta, criado_em, atualizado_em")
      .in("agent_id", agentIds)
      .gte("atualizado_em", DESDE)
      .order("atualizado_em", { ascending: true });

    const linhas: string[] = [];
    let comOferta = 0;
    let somaDist = 0;
    let piorDist = -1;
    let semManha = 0;
    for (const c of (convs ?? []) as Record<string, unknown>[]) {
      const ld = (((c.meta ?? {}) as Record<string, unknown>).lead_data ?? {}) as Record<
        string,
        unknown
      >;
      const slots = (ld.offered_slots ?? []) as Record<string, unknown>[];
      if (!slots.length) continue;
      comOferta++;

      const diaOferta = diaBrt(c.atualizado_em as string);
      const primeiro = slots
        .map((s) => String(s.iso ?? ""))
        .filter(Boolean)
        .sort()[0]!;
      const dist = difDias(diaOferta, primeiro.slice(0, 10));
      somaDist += dist;
      if (dist > piorDist) piorDist = dist;

      const horas = slots.map((s) => Number(String(s.time_label ?? "99").slice(0, 2)));
      const temManha = horas.some((h) => h < 12);
      const temTarde = horas.some((h) => h >= 12);
      if (!temManha) semManha++;

      linhas.push(
        `   ${BR(c.atualizado_em as string)} conv=${String(c.id).slice(0, 8)} ${String(
          ld.name ?? "?",
        )
          .slice(0, 26)
          .padEnd(26)} ` +
          `1º slot=${primeiro.slice(0, 10)} (+${dist}d) slots=${slots.length} ` +
          `manhã=${temManha ? "sim" : "NÃO"} tarde=${temTarde ? "sim" : "não"}`,
      );
    }

    log(`Clinica Bomfim — conversas com oferta desde ${BR(DESDE)}: ${comOferta}`);
    if (comOferta) {
      log(
        `   distância média até o 1º horário ofertado: ${(somaDist / comOferta).toFixed(1)} dias`,
      );
      log(`   pior caso: +${piorDist} dias`);
      log(
        `   listas SEM nenhuma vaga de manhã: ${semManha} de ${comOferta}  (contraturno impossível)`,
      );
    }
    log("");
    for (const l of linhas) log(l);
    expect(true).toBe(true);
  }, 600_000);
});
