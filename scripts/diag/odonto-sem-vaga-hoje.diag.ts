// Read-only: (21) 96647-7334 / Odonto Carioca Campo Grande.
// Por que a IA disse que nao tinha vaga hoje tendo horario livre na agenda.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
const OUT = path.resolve(process.cwd(), "scripts", "diag", "last-report-semvaga.txt");
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
const TEL = "966477334";
const BR = (s: string) => new Date(s).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" });

describe("sem-vaga", () => {
  it("transcricao", async () => {
    const { data: convs } = await sb.from("conversations")
      .select("id, agent_id, phone, lead_phone, channel, meta, criado_em, atualizado_em")
      .or(`phone.like.%${TEL}%,lead_phone.like.%${TEL}%`).order("atualizado_em", { ascending: false });
    log(`conversas encontradas: ${convs?.length ?? 0}`);
    for (const c of convs ?? []) {
      log(`\n${"=".repeat(78)}`);
      log(`conv=${c.id} agent=${c.agent_id} canal=${c.channel} criada=${BR(c.criado_em as string)}`);
      log(`meta:\n${JSON.stringify(c.meta, null, 2)}`);
      const { data: msgs } = await sb.from("messages").select("role, content, meta, criado_em")
        .eq("conversation_id", c.id as string).order("criado_em", { ascending: true }).order("id", { ascending: true });
      log(`\n### ${msgs?.length ?? 0} mensagens`);
      for (const [i, m] of (msgs ?? []).entries()) {
        const mm = (m.meta ?? {}) as Record<string, unknown>;
        log(`\n[${String(i).padStart(3, "0")}] ${BR(m.criado_em as string)} ${m.role}/${mm.origem ?? "?"} echo=${mm.is_echo ?? false}`);
        log(`     ${JSON.stringify(String(m.content ?? "").slice(0, 700))}`);
        const rel = Object.fromEntries(Object.entries(mm).filter(([k]) => !["origem","transcription"].includes(k)));
        if (Object.keys(rel).length) log(`     meta: ${JSON.stringify(rel).slice(0, 1400)}`);
      }
    }
    expect(true).toBe(true);
  }, 600_000);
});
