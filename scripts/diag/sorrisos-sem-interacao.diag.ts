// Read-only: (38) 99881-0514 / Odonto Sorrisos.
// As mensagens do lead caem na conversa e7787ba7 (phone 87996030402), que junta
// dezenas de contatos. Mede a mistura inteira (paginando) e mostra o trecho de hoje.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
const OUT = path.resolve(process.cwd(), "scripts", "diag", "last-report-sorrisos.txt");
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
const CONV = "e7787ba7-0753-4e7c-a8dd-9ce6e932b3fc";
const BR = (s: string) => new Date(s).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" });
type Row = { id: string; role: string; content: string; meta: Record<string, unknown> | null; criado_em: string };

describe("sorrisos", () => {
  it("mistura e trecho de hoje", async () => {
    const all: Row[] = [];
    for (let f = 0; ; f += 1000) {
      const { data } = await sb.from("messages").select("id, role, content, meta, criado_em")
        .eq("conversation_id", CONV).order("criado_em", { ascending: true }).order("id", { ascending: true }).range(f, f + 999);
      const page = (data ?? []) as Row[];
      all.push(...page);
      if (page.length < 1000) break;
    }
    const remetentes = new Set(all.filter((m) => m.role === "user").map((m) => String((m.meta ?? {}).channel_from ?? "?")));
    const turnosAgente = all.filter((m) => (m.meta ?? {}).origem === "agente").length;
    log(`### conversa ${CONV} (phone=87996030402)`);
    log(`mensagens totais: ${all.length} | remetentes distintos (role=user): ${remetentes.size} | respostas do agente: ${turnosAgente}`);
    log(`periodo: ${BR(all[0]!.criado_em)} -> ${BR(all[all.length - 1]!.criado_em)}`);

    const idx = all.findIndex((m) => String((m.meta ?? {}).channel_from ?? "").includes("998810514"));
    log(`\nprimeira mensagem do (38) 99881-0514: indice ${idx} de ${all.length}`);
    const ini = Math.max(0, idx - 10);
    const fim = Math.min(all.length, idx + 40);
    for (let i = ini; i < fim; i++) {
      const m = all[i]!; const mm = m.meta ?? {};
      log(`\n[${i}] ${BR(m.criado_em)} ${m.role}/${mm.origem ?? "?"} echo=${mm.is_echo ?? false} from=${mm.channel_from ?? "-"}`);
      log(`     ${JSON.stringify(String(m.content ?? "").slice(0, 450))}`);
      const rel = Object.fromEntries(Object.entries(mm).filter(([k]) => ["agent", "stage_from", "stage_to", "stage_effective", "tools_called", "booking_error", "reply_llm_original", "duplicate_reply_blocked", "false_confirmation_scrubbed", "same_turn_handoff", "tipo"].includes(k)));
      if (Object.keys(rel).length) log(`     meta: ${JSON.stringify(rel).slice(0, 700)}`);
    }
    expect(true).toBe(true);
  }, 900_000);
});
