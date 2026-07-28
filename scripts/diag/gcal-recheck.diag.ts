// Recheck do Google Calendar: 3 tentativas por conta ativa, para separar
// falha PERSISTENTE (refresh_token revogado → precisa reconectar o OAuth) de
// falha TRANSIENTE (429/500 do Google, corrida de refresh).
//
//   npx vitest run --config scripts/diag/vitest.diag.config.ts scripts/diag/gcal-recheck.diag.ts
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

function loadEnv() {
  const txt = fs.readFileSync(path.resolve(process.cwd(), ".env.production"), "utf8");
  for (const l of txt.split(/\r?\n/)) {
    if (!l || l.startsWith("#") || !l.includes("=")) continue;
    const i = l.indexOf("=");
    const k = l.slice(0, i).trim();
    if (!process.env[k]) process.env[k] = l.slice(i + 1).trim().replace(/^["']|["']$/g, "");
  }
}
loadEnv();

const { getSelfhost } = await import("@/integrations/selfhost/client.server");
const { listAvailableCalendars } = await import("@/lib/tools/google-calendar.server");
const sb = getSelfhost();

describe("Google Calendar — persistente vs transiente", () => {
  it("3 tentativas por conta ativa", async () => {
    const out: string[] = [];
    const { data: contas } = await sb.from("accounts").select("id, nome");
    const nomes = new Map((contas ?? []).map((c) => [c.id as string, c.nome as string]));
    const { data } = await sb
      .from("google_calendar_tokens")
      .select("account_id, expires_at, atualizado_em")
      .eq("ativo", true);

    for (const row of data ?? []) {
      const id = String((row as { account_id: string }).account_id);
      const tentativas: string[] = [];
      for (let i = 0; i < 3; i++) {
        try {
          const cals = await listAvailableCalendars(id);
          tentativas.push(`ok(${cals.length})`);
        } catch (e) {
          tentativas.push(`ERRO(${(e instanceof Error ? e.message : String(e)).slice(0, 40)})`);
        }
        await new Promise((r) => setTimeout(r, 500));
      }
      const okCount = tentativas.filter((t) => t.startsWith("ok")).length;
      const veredito =
        okCount === 3 ? "✅ saudável" : okCount === 0 ? "❌ QUEBRADA" : "⚠️  INTERMITENTE";
      const linha = `  ${veredito}  ${nomes.get(id) ?? id}  [${tentativas.join(" | ")}]  expira=${(row as { expires_at?: string }).expires_at ?? "?"}`;
      out.push(linha);
      console.log(linha);
    }

    fs.writeFileSync(
      path.resolve(process.cwd(), "scripts", "diag", "last-gcal-recheck.txt"),
      `${out.join("\n")}\n`,
      "utf8",
    );
    expect(out.length).toBeGreaterThan(0);
  }, 300_000);
});
