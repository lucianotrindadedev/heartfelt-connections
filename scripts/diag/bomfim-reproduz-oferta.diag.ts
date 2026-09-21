// Read-only: reproduz a chamada de listar_horarios do turno das 12:46 da
// Milene (21 99004-9579, Clinica Bomfim) — com o histórico REAL da conversa —
// para ver o que o modelo recebeu antes de ofertar 28/09.

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const OUT = path.resolve(process.cwd(), "scripts", "diag", "last-report-bomfim-repro.txt");
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
const { execListarHorarios } = await import("@/lib/agents/scheduler.server");
type AgentContext = import("@/lib/agents/context").AgentContext;

const sb = getSelfhost();
const ACC = "9d03ada1-0a96-483a-94e8-fce87d8bbf40"; // Clinica Bomfim
const CONV = "e0e6bfc5-3048-4aa3-838e-a14780a40e1f";

describe("reproduz a oferta da Bomfim", () => {
  it("chama listar_horarios como o qualifier chamou", async () => {
    const { data: agent } = await sb
      .from("agents")
      .select("id, settings, system_prompt")
      .eq("account_id", ACC)
      .eq("ativo", true)
      .limit(1)
      .maybeSingle();

    // Histórico REAL até o turno da oferta (12:46).
    const { data: msgs } = await sb
      .from("messages")
      .select("role, content, meta, criado_em")
      .eq("conversation_id", CONV)
      .lt("criado_em", "2026-09-21T15:46:00Z")
      .order("criado_em", { ascending: true });
    const history = ((msgs ?? []) as Record<string, unknown>[])
      .filter((m) => (m.meta as Record<string, unknown> | null)?.is_echo !== true)
      .filter((m) => (m.meta as Record<string, unknown> | null)?.origem !== "humano")
      .map((m) => ({ role: String(m.role), content: String(m.content ?? "") }));
    log(`histórico reconstruído: ${history.length} mensagens`);
    log(`última do lead: ${JSON.stringify(history[history.length - 1]?.content.slice(0, 60))}\n`);

    const ctx = {
      accountId: ACC,
      agentId: agent?.id as string,
      conversationId: "diag-bomfim-repro",
      stage: "QUALIFICATION",
      leadData: {},
      conversationPhone: "5521990049579",
      effectivePhone: "5521990049579",
      channel: "whatsapp",
      helenaContact: null,
      agentSettings: (agent?.settings as Record<string, string>) ?? {},
      basePrompt: (agent?.system_prompt as string) ?? "",
      history,
      integrations: {
        clinicorp: true,
        clinup: false,
        googleCalendar: false,
        clinicExperts: false,
        escalation: false,
      },
      googleAgendas: [],
      clinicExpertsProfessionals: [],
      dryRun: true,
    } as unknown as AgentContext;

    const { requestedDateFromText, requestedWeekdayFromText } = await import("@/lib/booking-template");
    log("-- cada fala de lead do historico --");
    for (const h of history) {
      if (h.role !== "user") continue;
      const d = requestedDateFromText(h.content);
      const w = requestedWeekdayFromText(h.content);
      if (d || w) log(`   ${JSON.stringify(h.content.slice(0, 70))} -> date=${d} weekday=${w}`);
    }
    log("");
    // Chamada "simples": exatamente o que o qualifier faz quando o LLM não
    // passa data_alvo nem periodo.
    const out = await execListarHorarios(ctx, undefined, undefined, undefined, undefined);
    const parsed = JSON.parse(out.result) as Record<string, unknown>;
    log("── o que a tool devolveu ao modelo ──");
    log(`count = ${JSON.stringify(parsed.count)}`);
    const slots = (parsed.slots ?? []) as Record<string, unknown>[];
    for (const s of slots) {
      log(`   ${s.date_label} às ${s.time_label}   (${s.iso})`);
    }
    for (const k of Object.keys(parsed)) {
      if (k !== "slots") log(`   [${k}] = ${JSON.stringify(parsed[k]).slice(0, 300)}`);
    }

    const manha = slots.filter((s) => Number(String(s.time_label).slice(0, 2)) < 12);
    const tarde = slots.filter((s) => Number(String(s.time_label).slice(0, 2)) >= 12);
    log(`\n── contraturno (o prompt exige 1 manhã + 1 tarde) ──`);
    log(`   slots de MANHÃ na lista: ${manha.length}  ${manha.map((s) => `${s.date_label} ${s.time_label}`).join(" | ")}`);
    log(`   slots de TARDE na lista: ${tarde.length}  ${tarde.map((s) => `${s.date_label} ${s.time_label}`).join(" | ")}`);
    expect(true).toBe(true);
  }, 600_000);
});
