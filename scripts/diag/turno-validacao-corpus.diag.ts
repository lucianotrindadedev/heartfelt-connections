// Read-only: roda a leitura de turno NOVA contra todas as falas de lead dos
// últimos 120 dias e lista cada divergência em relação à versão de referência.
//
// O baseline é EXTRAÍDO do git (não reimplementado à mão). A primeira versão
// deste diag reescreveu a função antiga na unha e acusou 18 mudanças que eram
// só o strip de citação faltando no baseline — meia hora perseguindo um
// fantasma. `git show` não erra a cópia.
//
//   BASE=origin/main npx vitest run --config scripts/diag/vitest.diag.config.ts \
//     scripts/diag/turno-validacao-corpus.diag.ts
//
// O que precisa ser verdade antes de mergear:
//   • "turno → null" só onde o lead de fato NÃO podia naquele turno;
//   • "turno A → turno B" só onde o novo é o turno que ele realmente pediu;
//   • NENHUM pedido claro ("prefiro de manhã") pode ter virado null.

import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const OUT = path.resolve(process.cwd(), "scripts", "diag", "last-report-turno-validacao.txt");
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

/** Copia booking-template de um ref do git para um módulo temporário. */
function baselineDoGit(ref: string): string {
  const destino = path.resolve(process.cwd(), "scripts", "diag", "_baseline-tmp.ts");
  const fonte = execSync(`git show ${ref}:src/lib/booking-template.ts`, {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  // Os imports relativos ("./quote-prefix") não resolvem de scripts/diag —
  // reaponta para o alias, que resolve de qualquer lugar.
  fs.writeFileSync(destino, fonte.replace(/from "\.\/([\w-]+)"/g, 'from "@/lib/$1"'), "utf8");
  return destino;
}

const BASE = process.env.BASE || "HEAD";
baselineDoGit(BASE);

const { getSelfhost } = await import("@/integrations/selfhost/client.server");
const { requestedPeriodoFromText } = await import("@/lib/booking-template");
const { requestedPeriodoFromText: antigoPeriodo } = await import("./_baseline-tmp");
const sb = getSelfhost();

describe("validação da leitura de turno", () => {
  it(`compara ${BASE} x working tree`, async () => {
    const desde = new Date(Date.now() - 120 * 86400_000).toISOString();
    const msgs = new Map<string, string>();
    for (const t of ["manhã", "manha", "tarde", "noite", "almoço", "almoco"]) {
      const { data } = await sb
        .from("messages")
        .select("id, content")
        .eq("role", "user")
        .ilike("content", `%${t}%`)
        .gte("criado_em", desde)
        .limit(1000);
      for (const m of (data ?? []) as Record<string, unknown>[]) {
        msgs.set(m.id as string, String(m.content ?? ""));
      }
    }

    let iguais = 0;
    const viraramNull: string[] = [];
    const mudaram: string[] = [];
    const viraramTurno: string[] = [];
    for (const texto of msgs.values()) {
      const a = antigoPeriodo(texto);
      const n = requestedPeriodoFromText(texto);
      if (a === n) {
        iguais++;
        continue;
      }
      const amostra = texto.replace(/\s+/g, " ").slice(0, 135);
      if (a && !n) viraramNull.push(`[${a} → null] ${amostra}`);
      else if (!a && n) viraramTurno.push(`[null → ${n}] ${amostra}`);
      else mudaram.push(`[${a} → ${n}] ${amostra}`);
    }

    log(`baseline: ${BASE}`);
    log(`falas analisadas: ${msgs.size}`);
    log(`   sem mudança:   ${iguais}`);
    log(`   turno → null:  ${viraramNull.length}`);
    log(`   turno A → B:   ${mudaram.length}`);
    log(`   null → turno:  ${viraramTurno.length}`);

    log(`\n── TODAS as que deixaram de ser pedido de turno ──`);
    for (const l of viraramNull.sort()) log(`   ${l}`);
    if (mudaram.length) {
      log(`\n── mudaram de turno ──`);
      for (const l of mudaram.sort()) log(`   ${l}`);
    }
    if (viraramTurno.length) {
      log(`\n── passaram a ser turno ──`);
      for (const l of viraramTurno.sort()) log(`   ${l}`);
    }
    expect(true).toBe(true);
  }, 600_000);
});
