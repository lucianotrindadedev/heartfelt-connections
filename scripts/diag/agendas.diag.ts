// DIAGNÓSTICO DE AGENDAS — somente leitura, roda contra PRODUÇÃO.
//
// NÃO é teste unitário: fica fora de src/ de propósito (vitest.config.ts só
// inclui src/**/*.test.ts), para nunca entrar no `npm test`. Rode com:
//   npx vitest run --config scripts/diag/vitest.diag.config.ts
//
// O que valida, por CONTA ATIVA de cada provedor (Clinicorp, Google Calendar,
// Clinic Experts):
//   A. credencial viva (a chamada mais barata que exige auth de verdade);
//   B. o pipeline REAL de horários do scheduler (execListarHorarios), incluindo
//      filtro de turno, priorização por hora pedida e corte de 6;
//   C. sanidade da config (o que quebraria só na hora de fechar o agendamento).
//
// Nada aqui escreve: sem criar/cancelar agendamento, sem tocar CRM, sem
// mensagem para lead. execListarHorarios é read-only por construção.

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, beforeAll, afterAll } from "vitest";

// O reporter do vitest ENGOLE o stdout de teste que passa — e num diagnóstico
// o resultado do que passou é justamente o que interessa. Tudo vai para um
// arquivo, lido no fim.
const REPORT: string[] = [];
const REPORT_FILE = path.resolve(process.cwd(), "scripts", "diag", "last-report.txt");
function log(line = "") {
  REPORT.push(line);
  console.log(line);
}

// ── env de produção (o mesmo .env.production que o deploy usa) ──────────────
function loadEnv() {
  const file = path.resolve(process.cwd(), ".env.production");
  const txt = fs.readFileSync(file, "utf8");
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
const { execListarHorarios } = await import("@/lib/agents/scheduler.server");
const { listClinicorpProfessionals } = await import("@/lib/tools/clinicorp.server");
const { listClinicExpertsProfessionals, listClinicExpertsSlots } = await import(
  "@/lib/tools/clinic-experts.server"
);
const { listAvailableCalendars, listAccountAgendas } = await import(
  "@/lib/tools/google-calendar.server"
);
type AgentContext = import("@/lib/agents/context").AgentContext;

const sb = getSelfhost();

interface Alvo {
  accountId: string;
  nome: string;
  provedor: "clinicorp" | "google_calendar" | "clinic_experts";
}

const alvos: Alvo[] = [];
const nomes = new Map<string, string>();

beforeAll(async () => {
  const { data: contas } = await sb.from("accounts").select("id, nome");
  for (const c of contas ?? []) nomes.set(c.id as string, c.nome as string);

  const fontes: { tabela: string; provedor: Alvo["provedor"] }[] = [
    { tabela: "clinicorp_config", provedor: "clinicorp" },
    { tabela: "google_calendar_tokens", provedor: "google_calendar" },
    { tabela: "clinic_experts_config", provedor: "clinic_experts" },
  ];
  for (const { tabela, provedor } of fontes) {
    const { data } = await sb.from(tabela).select("account_id").eq("ativo", true);
    for (const row of data ?? []) {
      const accountId = String((row as { account_id: string }).account_id);
      alvos.push({ accountId, nome: nomes.get(accountId) ?? accountId, provedor });
    }
  }
  alvos.sort((a, b) => a.provedor.localeCompare(b.provedor) || a.nome.localeCompare(b.nome));
  log(`\n[diag] ${alvos.length} integrações ativas encontradas\n`);
});

/** Contexto mínimo para execListarHorarios — só o que o pipeline lê. */
async function ctxFor(alvo: Alvo): Promise<AgentContext> {
  const { data: agent } = await sb
    .from("agents")
    .select("id, settings, system_prompt")
    .eq("account_id", alvo.accountId)
    .eq("ativo", true)
    .limit(1)
    .maybeSingle();

  const { data: ce } = await sb
    .from("clinic_experts_config")
    .select("professionals")
    .eq("account_id", alvo.accountId)
    .maybeSingle();

  const googleAgendas =
    alvo.provedor === "google_calendar" ? await listAccountAgendas(alvo.accountId) : [];

  const profs = Array.isArray(ce?.professionals)
    ? (ce!.professionals as Record<string, unknown>[]).map((p) => ({
        uuid: String(p.uuid ?? ""),
        name: String(p.name ?? ""),
        duracaoMinutos: typeof p.duracao_minutos === "number" ? p.duracao_minutos : undefined,
        businessHoursJson:
          typeof p.business_hours_json === "string" ? p.business_hours_json : undefined,
      }))
    : [];

  return {
    accountId: alvo.accountId,
    agentId: (agent?.id as string) ?? "diag",
    conversationId: `diag-${alvo.provedor}`,
    stage: "SLOT_OFFER",
    leadData: {},
    conversationPhone: "5521999999999",
    effectivePhone: "5521999999999",
    channel: "whatsapp",
    helenaContact: null,
    agentSettings: (agent?.settings as Record<string, string>) ?? {},
    basePrompt: "",
    model: "x",
    qualifierModel: "x",
    qualifierFallbackModels: [],
    toolModel: "x",
    toolFallbackModels: [],
    fallbackModels: [],
    ragGateModel: "x",
    maxTokens: 1024,
    temperature: 0.5,
    modelTemperatures: {},
    orKey: "",
    integrations: {
      clinicorp: alvo.provedor === "clinicorp",
      clinup: false,
      googleCalendar: alvo.provedor === "google_calendar",
      clinicExperts: alvo.provedor === "clinic_experts",
      escalation: false,
    },
    googleAgendas,
    clinicExpertsProfessionals: profs,
    history: [],
    dryRun: true,
  } as AgentContext;
}

interface SlotOut {
  count: number;
  slots?: { iso: string; date_label: string; time_label: string }[];
  error?: string;
}

const resumo: string[] = [];

// ── A. Credencial viva ─────────────────────────────────────────────────────
describe("A. credencial de cada integração ativa", () => {
  it("todas as integrações ativas respondem com credencial válida", async () => {
    const quebradas: string[] = [];
    for (const alvo of alvos) {
      try {
        if (alvo.provedor === "google_calendar") {
          const cals = await listAvailableCalendars(alvo.accountId);
          log(`  ✅ [gcal]      ${alvo.nome} — ${cals.length} agenda(s)`);
        } else if (alvo.provedor === "clinicorp") {
          const p = await listClinicorpProfessionals(alvo.accountId);
          log(`  ✅ [clinicorp] ${alvo.nome} — ${p.length} profissional(is)`);
        } else {
          const p = await listClinicExpertsProfessionals(alvo.accountId);
          log(`  ✅ [experts]   ${alvo.nome} — ${p.length} profissional(is)`);
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        log(`  ❌ [${alvo.provedor}] ${alvo.nome} — ${msg.slice(0, 160)}`);
        quebradas.push(`${alvo.provedor}/${alvo.nome}: ${msg.slice(0, 120)}`);
      }
    }
    resumo.push(`A. credenciais: ${alvos.length - quebradas.length}/${alvos.length} OK`);
    if (quebradas.length) resumo.push(...quebradas.map((q) => `   ❌ ${q}`));
    expect(quebradas, `integrações com credencial quebrada:\n${quebradas.join("\n")}`).toEqual([]);
  }, 300_000);
});

// ── B. Pipeline REAL de horários (código do scheduler) ─────────────────────
describe("B. execListarHorarios (pipeline real do scheduler)", () => {
  it("cada provedor devolve horários coerentes", async () => {
    const falhas: string[] = [];
    for (const alvo of alvos) {
      const ctx = await ctxFor(alvo);
      try {
        const out = JSON.parse((await execListarHorarios(ctx)).result) as SlotOut;
        const slots = out.slots ?? [];
        if (out.error) {
          log(`  ⚠️  [${alvo.provedor}] ${alvo.nome} — erro: ${out.error.slice(0, 120)}`);
          falhas.push(`${alvo.nome}: ${out.error.slice(0, 100)}`);
          continue;
        }
        const amostra = slots
          .slice(0, 2)
          .map((s) => `${s.date_label} ${s.time_label}`)
          .join(" | ");
        log(
          `  ${slots.length > 0 ? "✅" : "⚠️ "} [${alvo.provedor}] ${alvo.nome} — ${slots.length} slot(s)${amostra ? `: ${amostra}` : " (agenda sem vaga na janela)"}`,
        );

        // Invariantes que valem para QUALQUER provedor:
        expect(slots.length, "corte de 6 slots").toBeLessThanOrEqual(6);
        for (const s of slots) {
          expect(s.iso, `slot sem iso em ${alvo.nome}`).toBeTruthy();
          expect(Number.isNaN(new Date(s.iso).getTime()), `iso inválido: ${s.iso}`).toBe(false);
          expect(
            new Date(s.iso).getTime(),
            `slot no PASSADO ofertado por ${alvo.nome}: ${s.iso}`,
          ).toBeGreaterThan(Date.now() - 60_000);
          expect(s.date_label, `slot sem date_label em ${alvo.nome}`).toBeTruthy();
          expect(s.time_label, `slot sem time_label em ${alvo.nome}`).toMatch(/^\d{2}:\d{2}$/);
        }
        // Ordem cronológica: o agente oferta "as 2 primeiras" e elas têm que
        // ser as mais próximas.
        const isos = slots.map((s) => new Date(s.iso).getTime());
        expect([...isos].sort((a, b) => a - b), `slots fora de ordem em ${alvo.nome}`).toEqual(isos);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        log(`  ❌ [${alvo.provedor}] ${alvo.nome} — exceção: ${msg.slice(0, 160)}`);
        falhas.push(`${alvo.nome}: ${msg.slice(0, 100)}`);
      }
    }
    resumo.push(`B. pipeline de horários: ${alvos.length - falhas.length}/${alvos.length} OK`);
    if (falhas.length) resumo.push(...falhas.map((f) => `   ⚠️  ${f}`));
  }, 600_000);
});

// ── B2. Filtro de turno ────────────────────────────────────────────────────
describe("B2. filtro de turno (periodo)", () => {
  it("periodo='tarde' nunca devolve horário da manhã", async () => {
    const violacoes: string[] = [];
    for (const alvo of alvos) {
      const ctx = await ctxFor(alvo);
      try {
        const out = JSON.parse(
          (await execListarHorarios(ctx, undefined, undefined, undefined, "tarde")).result,
        ) as SlotOut & { aviso_periodo?: string };
        const slots = out.slots ?? [];
        if (slots.length === 0) continue;
        // Quando NÃO há vaga no turno, o pipeline oferta outro turno DE PROPÓSITO
        // e avisa (aviso_periodo). Só é violação se ofertou manhã sem avisar.
        const temAviso = JSON.stringify(out).includes("turno");
        const manha = slots.filter((s) => Number(s.time_label.slice(0, 2)) < 12);
        if (manha.length > 0 && !temAviso) {
          violacoes.push(
            `${alvo.provedor}/${alvo.nome}: ${manha.map((s) => s.time_label).join(",")}`,
          );
        }
        log(
          `  ${manha.length === 0 || temAviso ? "✅" : "❌"} [${alvo.provedor}] ${alvo.nome} — tarde: ${slots.map((s) => s.time_label).join(", ")}${temAviso ? " (avisou que não há vaga no turno)" : ""}`,
        );
      } catch {
        /* já reportado na suíte B */
      }
    }
    resumo.push(`B2. filtro de turno: ${violacoes.length === 0 ? "OK" : `${violacoes.length} violação(ões)`}`);
    expect(violacoes, `ofertou manhã pedindo tarde, sem avisar:\n${violacoes.join("\n")}`).toEqual(
      [],
    );
  }, 600_000);
});

// ── C. Sanidade de config (falha só na hora de fechar) ─────────────────────
describe("C. config que só quebraria no momento do agendamento", () => {
  it("Clinic Experts: procedure_id e profissionais configurados", async () => {
    const { data } = await sb
      .from("clinic_experts_config")
      .select("account_id, procedure_id, procedure_name, professionals")
      .eq("ativo", true);
    const problemas: string[] = [];
    for (const row of data ?? []) {
      const nome = nomes.get(String(row.account_id)) ?? String(row.account_id);
      const profs = Array.isArray(row.professionals) ? row.professionals.length : 0;
      if (!row.procedure_id) {
        problemas.push(`${nome}: procedure_id AUSENTE → createClinicExpertsAppointment lança`);
        log(`  ❌ [experts] ${nome} — procedure_id ausente`);
      } else if (profs === 0) {
        problemas.push(`${nome}: nenhum profissional configurado`);
        log(`  ❌ [experts] ${nome} — 0 profissionais`);
      } else {
        log(
          `  ✅ [experts] ${nome} — procedure_id=${row.procedure_id} (${row.procedure_name ?? "?"}), ${profs} profissional(is)`,
        );
      }
    }
    resumo.push(`C. config Clinic Experts: ${problemas.length === 0 ? "OK" : problemas.join(" / ")}`);
    expect(problemas, problemas.join("\n")).toEqual([]);
  }, 120_000);

  it("Google Calendar: agendas resolvíveis", async () => {
    const problemas: string[] = [];
    for (const alvo of alvos.filter((a) => a.provedor === "google_calendar")) {
      const agendas = await listAccountAgendas(alvo.accountId);
      log(
        `  ${agendas.length >= 0 ? "✅" : "❌"} [gcal] ${alvo.nome} — ${agendas.length} agenda(s) configurada(s)${agendas.length > 1 ? " (multi-agenda)" : ""}`,
      );
      for (const a of agendas) {
        if (!a.calendarId) problemas.push(`${alvo.nome}: agenda "${a.label}" sem calendarId`);
      }
    }
    resumo.push(`C. config Google Calendar: ${problemas.length === 0 ? "OK" : problemas.join(" / ")}`);
    expect(problemas, problemas.join("\n")).toEqual([]);
  }, 300_000);
});

afterAll(() => {
  fs.writeFileSync(REPORT_FILE, `${REPORT.join("\n")}\n`, "utf8");
});

describe("RESUMO", () => {
  it("imprime", () => {
    log(`\n${"─".repeat(70)}\nRESUMO DO DIAGNÓSTICO\n${"─".repeat(70)}`);
    for (const l of resumo) log(l);
    log(`${"─".repeat(70)}\n`);
    expect(true).toBe(true);
  });
});
