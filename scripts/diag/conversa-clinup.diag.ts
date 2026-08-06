// Dump de UMA conversa (read-only) para diagnóstico — telefone via env.
//   DIAG_TEL=87271682 npx vitest run --config scripts/diag/vitest.diag.config.ts scripts/diag/conversa-clinup.diag.ts
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const OUT = path.resolve(process.cwd(), "scripts", "diag", "last-report-conversa.txt");
const REPORT: string[] = [];
function log(line = "") {
  REPORT.push(line);
  console.log(line);
  fs.writeFileSync(OUT, `${REPORT.join("\n")}\n`, "utf8");
}

function loadEnv() {
  const txt = fs.readFileSync(path.resolve(process.cwd(), ".env.production"), "utf8");
  for (const line of txt.split(/\r?\n/)) {
    if (!line || line.startsWith("#") || !line.includes("=")) continue;
    const i = line.indexOf("=");
    const k = line.slice(0, i).trim();
    const v = line.slice(i + 1).trim().replace(/^["']|["']$/g, "");
    if (!process.env[k]) process.env[k] = v;
  }
}
loadEnv();

const { getSelfhost } = await import("@/integrations/selfhost/client.server");
const sb = getSelfhost();
// Sem default: telefone de lead é dado pessoal e não fica versionado no repo.
const TEL = (process.env.DIAG_TEL ?? "").trim();

const brt = (iso: string) =>
  new Intl.DateTimeFormat("pt-BR", {
    timeZone: "America/Sao_Paulo",
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(iso));

describe("conversa", () => {
  it("dump", async () => {
    if (!TEL) {
      log("\n[diag] defina DIAG_TEL=<telefone ou trecho> para dumpar a conversa");
      expect(true).toBe(true);
      return;
    }
    const { data: convs } = await sb
      .from("conversations")
      .select("id, agent_id, phone, lead_phone, meta, criado_em, atualizado_em")
      .or(`phone.like.%${TEL}%,lead_phone.like.%${TEL}%`)
      .order("atualizado_em", { ascending: false })
      .limit(5);

    log(`\n[diag] telefone ~${TEL} → ${convs?.length ?? 0} conversa(s)\n`);
    for (const c of convs ?? []) {
      const { data: agent } = await sb
        .from("agents")
        .select("id, nome, account_id")
        .eq("id", c.agent_id as string)
        .maybeSingle();
      const { data: acc } = agent
        ? await sb.from("accounts").select("nome").eq("id", agent.account_id as string).maybeSingle()
        : { data: null };

      log(`══ conv=${c.id}  conta=${acc?.nome ?? "?"}  agente=${agent?.nome ?? "?"}`);
      log(`   phone=${c.phone} lead_phone=${c.lead_phone}  atualizado=${brt(c.atualizado_em as string)}`);
      const meta = c.meta as Record<string, unknown> | null;
      log(`   lead_data=${JSON.stringify(meta?.lead_data ?? {}, null, 1)}`);
      log(`   stage=${JSON.stringify((meta as { stage?: unknown })?.stage ?? null)}`);

      const { data: msgs } = await sb
        .from("messages")
        .select("role, content, criado_em, meta")
        .eq("conversation_id", c.id as string)
        .order("criado_em", { ascending: true });

      log(`   ── ${msgs?.length ?? 0} mensagem(ns):`);
      for (const m of msgs ?? []) {
        const txt = String(m.content ?? "").replace(/\s+/g, " ").slice(0, 400);
        log(`   [${brt(m.criado_em as string)}] ${String(m.role).toUpperCase()}: ${txt}`);
        const mm = m.meta as Record<string, unknown> | null;
        if (mm && Object.keys(mm).length) {
          log(`        meta: ${JSON.stringify(mm).slice(0, 900)}`);
        }
      }
      log("");
    }
    expect(true).toBe(true);
  }, 300_000);
});
