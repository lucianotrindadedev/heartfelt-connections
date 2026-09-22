// Read-only: quantas falas de lead dizem "NESSE turno eu não posso" e são
// lidas como pedido DAQUELE turno?
//
// Caso real (Sorriso Saúde, Marcelene 27 99703-3358, 22/09/2026):
// "Pela manhã tenho compromisso" -> requestedPeriodoFromText = "manha".

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const OUT = path.resolve(process.cwd(), "scripts", "diag", "last-report-turno-negado.txt");
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
const { requestedPeriodoFromText } = await import("@/lib/booking-template");
const sb = getSelfhost();

const semAcento = (s: string) =>
  s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

/** Marcas de IMPEDIMENTO a até ~40 caracteres da palavra do turno. */
const IMPEDIMENTO =
  /(nao\s+(posso|dá|da|consigo|tenho|rola|vai|dou|trabalho)|n\s*ão\s+posso|impossivel|trabalho|tenho\s+(compromisso|consulta|aula|trabalho|servico|que\s+trabalhar)|estou\s+(ocupad|trabalhand)|to\s+(ocupad|trabalhand)|ocupad|complicado|dificil|so\s+(a|à)\s+tarde|so\s+de\s+tarde)/;

const TURNO = /\b(manha|tarde|noite)\b/g;

describe("turno negado lido como pedido", () => {
  it("varre", async () => {
    const desde = new Date(Date.now() - 120 * 86400_000).toISOString();
    const termos = ["manhã", "manha", "tarde", "noite"];
    const msgs = new Map<string, { conv: string; texto: string; quando: string }>();
    for (const t of termos) {
      const { data } = await sb
        .from("messages")
        .select("id, conversation_id, content, criado_em")
        .eq("role", "user")
        .ilike("content", `%${t}%`)
        .gte("criado_em", desde)
        .limit(1000);
      for (const m of (data ?? []) as Record<string, unknown>[]) {
        msgs.set(m.id as string, {
          conv: m.conversation_id as string,
          texto: String(m.content ?? ""),
          quando: m.criado_em as string,
        });
      }
    }
    log(`falas de lead citando um turno (120d): ${msgs.size}\n`);

    const afetadas: { texto: string; turno: string; conv: string }[] = [];
    for (const m of msgs.values()) {
      const turno = requestedPeriodoFromText(m.texto);
      if (!turno) continue;
      const t = semAcento(m.texto).replace(/\s+/g, " ");
      // O impedimento precisa estar PERTO da palavra do turno.
      TURNO.lastIndex = 0;
      let perto = false;
      let hit: RegExpExecArray | null;
      while ((hit = TURNO.exec(t)) !== null) {
        const janela = t.slice(Math.max(0, hit.index - 45), hit.index + hit[0].length + 45);
        if (IMPEDIMENTO.test(janela)) {
          perto = true;
          break;
        }
      }
      if (perto) afetadas.push({ texto: m.texto, turno, conv: m.conv });
    }

    log(`falas com marca de IMPEDIMENTO perto do turno, lidas como PEDIDO daquele turno: ${afetadas.length}`);
    log(`conversas distintas: ${new Set(afetadas.map((a) => a.conv)).size}\n`);
    for (const a of afetadas.slice(0, 40)) {
      log(`   [lido como ${a.turno}] ${a.texto.replace(/\s+/g, " ").slice(0, 120)}`);
    }
    expect(true).toBe(true);
  }, 600_000);
});
