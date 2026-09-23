// Read-only: reproduz a chamada de listar_horarios de um turno real, com o
// histórico da conversa até aquele instante — para ver o que o modelo recebeu.
//
//   CONV=<uuid> ATE=2026-09-23T11:06:00Z ACC=<uuid> npx vitest run \
//     --config scripts/diag/vitest.diag.config.ts \
//     scripts/diag/reproduz-listar-horarios.diag.ts
//
// Genérico de propósito: a versão anterior tinha a conversa da Milene chumbada
// no arquivo e virou lixo assim que apareceu o segundo caso.

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const OUT = path.resolve(process.cwd(), "scripts", "diag", "last-report-repro-horarios.txt");
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
const { execListarHorarios } = await import("@/lib/agents/scheduler.server");
const { requestedDateFromText, requestedWeekdayFromText, requestedPeriodoFromText } = await import(
  "@/lib/booking-template"
);
type AgentContext = import("@/lib/agents/context").AgentContext;

const sb = getSelfhost();
const CONV = process.env.CONV ?? "";
const ATE = process.env.ATE ?? new Date().toISOString();

describe("reproduz listar_horarios", () => {
  it("mostra o que a tool devolveu", async () => {
    if (!CONV) {
      log("passe CONV=<uuid da conversa>");
      expect(true).toBe(true);
      return;
    }

    const { data: conv } = await sb
      .from("conversations")
      .select("id, agent_id, phone, lead_phone")
      .eq("id", CONV)
      .maybeSingle();
    const cv = conv as Record<string, unknown>;
    const { data: agent } = await sb
      .from("agents")
      .select("id, account_id, settings, system_prompt")
      .eq("id", cv.agent_id as string)
      .maybeSingle();
    const ag = agent as Record<string, unknown>;
    const ACC = ag.account_id as string;

    const { data: msgs } = await sb
      .from("messages")
      .select("role, content, meta, criado_em")
      .eq("conversation_id", CONV)
      .lt("criado_em", ATE)
      .order("criado_em", { ascending: true });
    const history = ((msgs ?? []) as Record<string, unknown>[])
      .filter((m) => (m.meta as Record<string, unknown> | null)?.is_echo !== true)
      .filter((m) => (m.meta as Record<string, unknown> | null)?.origem !== "humano")
      .map((m) => ({ role: String(m.role), content: String(m.content ?? "") }));

    log(`conv=${CONV}  conta=${ACC}  corte=${ATE}`);
    log(`histórico: ${history.length} mensagens\n`);
    log("── como o código lê as últimas falas do lead ──");
    for (const h of history.filter((h) => h.role === "user").slice(-6)) {
      log(
        `   ${JSON.stringify(h.content.slice(0, 70))}\n      data=${requestedDateFromText(h.content)} dia=${requestedWeekdayFromText(h.content)} turno=${requestedPeriodoFromText(h.content)}`,
      );
    }

    const ctx = {
      accountId: ACC,
      agentId: ag.id as string,
      conversationId: "diag-repro",
      stage: "SLOT_OFFER",
      leadData: {},
      conversationPhone: String(cv.lead_phone ?? cv.phone ?? ""),
      effectivePhone: String(cv.lead_phone ?? cv.phone ?? ""),
      channel: "whatsapp",
      helenaContact: null,
      agentSettings: (ag.settings as Record<string, string>) ?? {},
      basePrompt: (ag.system_prompt as string) ?? "",
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

    const capturado: string[] = [];
    const orig = { log: console.log, warn: console.warn };
    console.log = (...a: unknown[]) => {
      const s = a.map(String).join(" ");
      if (s.includes("[clinicorp]") || s.includes("[scheduler]")) capturado.push(s);
    };
    console.warn = console.log;
    let out;
    try {
      const DATA_ALVO = process.env.DATA_ALVO || undefined;
      const PERIODO = process.env.PERIODO || undefined;
      log(`
(chamando com data_alvo=${DATA_ALVO ?? "-"} periodo=${PERIODO ?? "-"})`);
      out = await execListarHorarios(ctx, undefined, undefined, DATA_ALVO, PERIODO);
    } finally {
      console.log = orig.log;
      console.warn = orig.warn;
    }

    const parsed = JSON.parse(out.result) as Record<string, unknown>;
    const slots = (parsed.slots ?? []) as Record<string, unknown>[];
    log(`\n── a tool devolveu ${parsed.count} slots ──`);
    for (const s of slots) log(`   ${s.date_label} às ${s.time_label}`);
    for (const k of Object.keys(parsed)) {
      if (k !== "slots") log(`   [${k}] = ${JSON.stringify(parsed[k]).slice(0, 280)}`);
    }
    const tarde = slots.filter((s) => Number(String(s.time_label).slice(0, 2)) >= 12);
    log(`\n   de TARDE na lista: ${tarde.length}`);
    log(`\n── logs internos ──`);
    for (const c of capturado) log(`   ${c}`);
    expect(true).toBe(true);
  }, 600_000);
});
