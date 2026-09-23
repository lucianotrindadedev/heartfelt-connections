// Read-only: com a agenda REAL da Odonto Sorrisos, o que execListarHorarios
// devolve com oferta_primeiro_manha_tarde ligada (só em memória) — sem data,
// com "amanhã" e com "segunda". A duração da Clinicorp é lida do banco; para
// simular 15 min sem gravar, rode com DUR=15 (sobrescreve loadConfig via mock).
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
const OUT = path.resolve(process.cwd(), "scripts", "diag", "last-report-sorrisos-par.txt");
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
const DUR = process.env.DUR ? Number(process.env.DUR) : null;
if (DUR) {
  vi.mock("@/integrations/selfhost/client.server", async (orig) => {
    const real = await orig<typeof import("@/integrations/selfhost/client.server")>();
    return {
      ...real,
      getSelfhost: () => {
        const sb = real.getSelfhost();
        return new Proxy(sb, {
          get(t, p) {
            if (p !== "from") return Reflect.get(t, p);
            return (table: string) => {
              const q = t.from(table);
              if (table !== "clinicorp_config") return q;
              const sel = q.select.bind(q);
              (q as { select: unknown }).select = (...a: unknown[]) => {
                const b = sel(...(a as [string]));
                const eq = b.eq.bind(b);
                (b as { eq: unknown }).eq = (...e: unknown[]) => {
                  const c = eq(...(e as [string, string]));
                  const single = c.single.bind(c);
                  (c as { single: unknown }).single = async () => {
                    const r = await single();
                    return r.data ? { ...r, data: { ...r.data, duracao_consulta: Number(process.env.DUR) } } : r;
                  };
                  return c;
                };
                return b;
              };
              return q;
            };
          },
        });
      },
    };
  });
}
const { getSelfhost } = await import("@/integrations/selfhost/client.server");
const { execListarHorarios } = await import("@/lib/agents/scheduler.server");
const sb = getSelfhost();
const AGENT_CONV = "e0345474-0b74-40be-a7e5-5919adeb1e12";

describe("par manhã/tarde", () => {
  it("agenda real", async () => {
    const { data: conv } = await sb.from("conversations").select("agent_id").eq("id", AGENT_CONV).single();
    const { data: agent } = await sb.from("agents").select("id, account_id, settings").eq("id", conv!.agent_id).single();
    log(`duração simulada=${DUR ?? "(a do banco)"}`);
    for (const [rotulo, ligado, fala, alvo] of [
      ["sem data, config DESLIGADA", false, "Sim", undefined],
      ["sem data, config LIGADA", true, "Sim", undefined],
      ["'amanhã', config LIGADA", true, "tem vaga amanhã?", undefined],
      ["'segunda', config LIGADA", true, "Tem vaga para a segunda feira?", undefined],
      ["lead pediu tarde, config LIGADA", true, "prefiro de tarde", undefined],
    ] as const) {
      const ctx = {
        accountId: agent!.account_id, agentId: agent!.id, conversationId: "diag-par", stage: "QUALIFICATION", leadData: {},
        channel: "whatsapp",
        agentSettings: { ...(agent!.settings as Record<string, string>), ...(ligado ? { oferta_primeiro_manha_tarde: "true" } : {}) },
        history: [{ role: "user", content: fala }],
        integrations: { clinicorp: true, clinup: false, googleCalendar: false, clinicExperts: false, escalation: false },
        googleAgendas: [], clinicExpertsProfessionals: [], dryRun: true,
      } as never;
      const out = JSON.parse((await execListarHorarios(ctx, undefined, undefined, alvo, undefined)).result) as Record<string, unknown>;
      log(`\n── ${rotulo} (lead: "${fala}")`);
      log(`   ${((out.slots ?? []) as Record<string, string>[]).map((s) => `${s.date_label} ${s.time_label}`).join(" | ")}`);
      if (out.instrucao_oferta) log(`   instrucao_oferta: sim`);
    }
    expect(true).toBe(true);
  }, 600_000);
});
