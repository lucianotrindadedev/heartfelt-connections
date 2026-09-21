// Read-only: roda o reconhecimento NOVO contra TODAS as falas de lead dos
// últimos 120 dias e lista cada divergência em relação ao antigo.
//
// O que eu preciso ver antes de mergear:
//   • toda divergência "antes=dia → agora=null" tem que ser um falso positivo
//     de verdade (ordinal ou faixa);
//   • NENHUM pedido legítimo de dia pode ter virado null.

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const OUT = path.resolve(process.cwd(), "scripts", "diag", "last-report-dia-validacao.txt");
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
const { requestedWeekdayFromText } = await import("@/lib/booking-template");
const sb = getSelfhost();

/** O reconhecimento ANTIGO, reproduzido aqui para comparar. */
const ANTIGO = /\b(domingo|segunda|terca|quarta|quinta|sexta|sabado)(?:-?feira)?\b/;
const MAPA: Record<string, string> = {
  domingo: "dom",
  segunda: "seg",
  terca: "ter",
  quarta: "qua",
  quinta: "qui",
  sexta: "sex",
  sabado: "sab",
};
const semAcento = (s: string) =>
  s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
const antigo = (texto: string) => {
  const m = ANTIGO.exec(semAcento(texto));
  return m ? (MAPA[m[1]!] ?? null) : null;
};

describe("validação do reconhecimento novo", () => {
  it("compara antigo x novo em todas as falas reais", async () => {
    const desde = new Date(Date.now() - 120 * 86400_000).toISOString();
    const termos = ["segunda", "terça", "terca", "quarta", "quinta", "sexta", "sábado", "sabado", "domingo"];
    const msgs = new Map<string, string>();
    for (const t of termos) {
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
    const mudaramDeDia: string[] = [];
    const viraramDia: string[] = [];
    for (const texto of msgs.values()) {
      const a = antigo(texto);
      const n = requestedWeekdayFromText(texto);
      if (a === n) {
        iguais++;
        continue;
      }
      const amostra = texto.replace(/\s+/g, " ").slice(0, 130);
      if (a && !n) viraramNull.push(`[${a} → null] ${amostra}`);
      else if (!a && n) viraramDia.push(`[null → ${n}] ${amostra}`);
      else mudaramDeDia.push(`[${a} → ${n}] ${amostra}`);
    }

    log(`falas analisadas: ${msgs.size}`);
    log(`   sem mudança:        ${iguais}`);
    log(`   dia → null:         ${viraramNull.length}   (falsos positivos eliminados)`);
    log(`   dia A → dia B:      ${mudaramDeDia.length}`);
    log(`   null → dia:         ${viraramDia.length}`);

    log(`\n── TODAS as que deixaram de ser dia da semana ──`);
    for (const l of viraramNull.sort()) log(`   ${l}`);
    if (mudaramDeDia.length) {
      log(`\n── mudaram de dia (faixa pulada → dia real adiante) ──`);
      for (const l of mudaramDeDia.sort()) log(`   ${l}`);
    }
    if (viraramDia.length) {
      log(`\n── passaram a ser dia (não deveria acontecer) ──`);
      for (const l of viraramDia.sort()) log(`   ${l}`);
    }
    expect(true).toBe(true);
  }, 600_000);
});
