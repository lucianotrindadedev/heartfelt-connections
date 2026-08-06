// DIAGNÓSTICO CLINUP — somente leitura, roda contra PRODUÇÃO.
//
//   npx vitest run --config scripts/diag/vitest.diag.config.ts scripts/diag/clinup-agenda.diag.ts
//
// Por que existe: o agendas.diag.ts cobre Clinicorp / Google Calendar / Clinic
// Experts e NÃO cobre o Clinup — a conta que mais reclama de "não temos vaga"
// com a agenda livre é justamente uma Clinup (Implanto Master).
//
// O que valida, por conta com clinup_config.ativo:
//   A. credencial + profissionais habilitados vs profissionais REAIS da API;
//   B. API CRUA (/datas, /horas) por profissional, dia a dia;
//   C. o que o ADAPTER (listClinupSlotsDetailed) devolve para os mesmos dias —
//      qualquer dia/hora que a API tem e o adapter não é filtro nosso comendo
//      vaga real;
//   D. o pipeline do scheduler (execListarHorarios), inclusive com data_alvo=hoje.
//
// Nada aqui escreve: só GET + execListarHorarios (read-only por construção).

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, beforeAll } from "vitest";

const REPORT: string[] = [];
const REPORT_FILE = path.resolve(process.cwd(), "scripts", "diag", "last-report-clinup-agenda.txt");
function log(line = "") {
  REPORT.push(line);
  console.log(line);
  // Escreve a cada linha: o process.on("exit") do worker do vitest nem sempre
  // roda, e um diagnóstico sem relatório não serve para nada.
  fs.writeFileSync(REPORT_FILE, `${REPORT.join("\n")}\n`, "utf8");
}

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
const { decryptValue } = await import("@/lib/crypto.server");
const { listClinupProfessionals, listClinupSlotsDetailed } = await import(
  "@/lib/tools/clinup.server"
);
const { execListarHorarios } = await import("@/lib/agents/scheduler.server");
type AgentContext = import("@/lib/agents/context").AgentContext;

const sb = getSelfhost();
const BASE = "https://app.sistemaclinup.com.br/api/open";
const TZ = "America/Sao_Paulo";
const fmtDia = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(d);
const hoje = () => fmtDia(new Date());
const maisDias = (n: number) => fmtDia(new Date(Date.now() + n * 86_400_000));

interface Conta {
  accountId: string;
  nome: string;
  token: string;
  agendaId: string;
  duracao: number;
  professionals: {
    id: string;
    name: string;
    duracaoMinutos?: number;
    businessHoursJson?: string;
  }[];
}

const contas: Conta[] = [];

async function get(token: string, pathname: string): Promise<{ status: number; json: unknown }> {
  const res = await fetch(`${BASE}${pathname}`, {
    headers: { Authorization: token, accept: "application/json" },
  });
  let json: unknown = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { status: res.status, json };
}

beforeAll(async () => {
  const { data: rows } = await sb
    .from("clinup_config")
    .select("account_id, api_token_enc, agenda_id, duracao_consulta, professionals, ativo")
    .eq("ativo", true);

  const { data: accs } = await sb.from("accounts").select("id, nome");
  const nomes = new Map<string, string>();
  for (const a of accs ?? []) nomes.set(a.id as string, a.nome as string);

  for (const r of rows ?? []) {
    const accountId = String(r.account_id);
    const token = (await decryptValue(r.api_token_enc as unknown as string)) ?? "";
    const rawProfs = Array.isArray(r.professionals) ? (r.professionals as Record<string, unknown>[]) : [];
    contas.push({
      accountId,
      nome: nomes.get(accountId) ?? accountId,
      token,
      agendaId: (r.agenda_id as string) ?? "",
      duracao: (r.duracao_consulta as number) || 40,
      professionals: rawProfs
        .map((p) => ({
          id: String(p.id ?? ""),
          name: String(p.name ?? ""),
          duracaoMinutos: typeof p.duracao_minutos === "number" ? p.duracao_minutos : undefined,
          businessHoursJson:
            typeof p.business_hours_json === "string" ? p.business_hours_json : undefined,
        }))
        .filter((p) => p.id),
    });
  }
  log(`\n[diag clinup] ${contas.length} conta(s) com Clinup ATIVO — hoje=${hoje()} (${TZ})\n`);
});

/** Contexto mínimo para execListarHorarios com Clinup. */
async function ctxFor(c: Conta, history: { role: "user" | "assistant"; content: string }[] = []): Promise<AgentContext> {
  const { data: agent } = await sb
    .from("agents")
    .select("id, settings")
    .eq("account_id", c.accountId)
    .eq("ativo", true)
    .limit(1)
    .maybeSingle();

  return {
    accountId: c.accountId,
    agentId: (agent?.id as string) ?? "diag",
    conversationId: "diag-clinup",
    stage: "SLOT_OFFER",
    leadData: {},
    conversationPhone: "5531999999999",
    effectivePhone: "5531999999999",
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
      clinicorp: false,
      clinup: true,
      googleCalendar: false,
      clinicExperts: false,
      escalation: false,
    },
    googleAgendas: [],
    clinicExpertsProfessionals: [],
    clinupProfessionals: c.professionals,
    history,
    dryRun: true,
  } as unknown as AgentContext;
}

// ── A. config vs realidade ─────────────────────────────────────────────────
describe("A. config Clinup vs profissionais reais da API", () => {
  it("cada conta tem profissional habilitado e o id existe na API", async () => {
    for (const c of contas) {
      log(`\n  ── ${c.nome} (${c.accountId})`);
      log(`     duracao_consulta=${c.duracao}min  agenda_id(legado)="${c.agendaId}"`);
      log(`     profissionais habilitados: ${c.professionals.length}`);
      for (const p of c.professionals) {
        const bh = p.businessHoursJson?.trim();
        let bhResumo = "(sem expediente configurado — confia 100% na API)";
        if (bh) {
          try {
            const parsed = JSON.parse(bh) as Record<string, unknown>;
            const dias = Object.entries(parsed)
              .filter(([, v]) => Array.isArray(v) && (v as unknown[]).length > 0)
              .map(([k, v]) => `${k}:${JSON.stringify(v)}`);
            // Todos os dias vazios NÃO bloqueia nada: o adapter só aplica a
            // restrição quando algum dia tem bloco (temExpediente) — sem isso
            // confia 100% nos horários que a API do Clinup já devolve.
            bhResumo = dias.length
              ? dias.join("  ")
              : "todos os dias vazios → sem restrição (confia 100% na API)";
          } catch {
            bhResumo = `⚠️ business_hours_json inválido: ${bh.slice(0, 80)}`;
          }
        }
        log(`       #${p.id} ${p.name} — dur=${p.duracaoMinutos ?? c.duracao}min`);
        log(`          expediente: ${bhResumo}`);
      }

      try {
        const reais = await listClinupProfessionals(c.accountId);
        log(`     API /profissionais → ${reais.length}: ${reais.map((r) => `#${r.id} ${r.name}`).join(" | ")}`);
        const idsReais = new Set(reais.map((r) => r.id));
        for (const p of c.professionals) {
          if (!idsReais.has(p.id)) {
            log(`     ❌ profissional habilitado #${p.id} (${p.name}) NÃO existe na API`);
          }
        }
        const faltando = reais.filter((r) => !c.professionals.some((p) => p.id === r.id));
        if (faltando.length) {
          log(
            `     ⚠️  ${faltando.length} profissional(is) da clínica NÃO habilitado(s) no painel: ${faltando.map((f) => `#${f.id} ${f.name}`).join(", ")}`,
          );
        }
      } catch (e) {
        log(`     ❌ credencial/API: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    expect(contas.length).toBeGreaterThan(0);
  }, 300_000);
});

// ── B/C. API crua vs adapter, dia a dia ────────────────────────────────────
describe("B. API crua (/datas, /horas) vs C. adapter (listClinupSlotsDetailed)", () => {
  it("nenhuma vaga real some no caminho", async () => {
    const DIAS = 5;
    for (const c of contas) {
      log(`\n  ══ ${c.nome}`);

      // ---- B: API crua, por profissional
      const cruPorDia = new Map<string, Set<string>>(); // data → HH:MM
      for (const p of c.professionals) {
        const { status, json } = await get(c.token, `/datas?profissionalId=${p.id}&data=${hoje()}`);
        const datas = ((json as { datas?: string[] })?.datas ?? []).map((d) => String(d).slice(0, 10));
        log(`\n     #${p.id} ${p.name} — /datas(${hoje()}) → ${status}, ${datas.length} data(s): ${datas.slice(0, 10).join(", ")}${datas.length > 10 ? " …" : ""}`);
        if (!datas.includes(hoje())) {
          log(`        ⚠️  HOJE (${hoje()}) NÃO está na lista de datas da API para este profissional`);
        }

        for (let i = 0; i < DIAS; i++) {
          const dia = maisDias(i);
          const { json: h } = await get(c.token, `/horas?profissionalId=${p.id}&data=${dia}`);
          const horas = ((h as { horas?: string[] })?.horas ?? []).map((x) => String(x).slice(0, 5));
          const naListaDeDatas = datas.includes(dia);
          if (horas.length) {
            const set = cruPorDia.get(dia) ?? new Set<string>();
            for (const x of horas) set.add(x);
            cruPorDia.set(dia, set);
          }
          log(
            `        ${dia} → ${horas.length} hora(s)${naListaDeDatas ? "" : "  [dia NÃO listado em /datas]"}${horas.length ? `: ${horas.slice(0, 12).join(" ")}${horas.length > 12 ? " …" : ""}` : ""}`,
          );
        }
      }

      // ---- C: adapter para a mesma janela
      let adapter: Awaited<ReturnType<typeof listClinupSlotsDetailed>> = [];
      try {
        adapter = await listClinupSlotsDetailed(c.accountId, hoje(), maisDias(DIAS - 1));
      } catch (e) {
        log(`\n     ❌ adapter falhou: ${e instanceof Error ? e.message : String(e)}`);
      }
      const adapterPorDia = new Map<string, string[]>();
      for (const s of adapter) {
        const arr = adapterPorDia.get(s.date) ?? [];
        arr.push(s.time.slice(0, 5));
        adapterPorDia.set(s.date, arr);
      }
      log(`\n     adapter (listClinupSlotsDetailed ${hoje()}→${maisDias(DIAS - 1)}): ${adapter.length} slot(s)`);
      for (let i = 0; i < DIAS; i++) {
        const dia = maisDias(i);
        const cru = [...(cruPorDia.get(dia) ?? [])].sort();
        const ad = (adapterPorDia.get(dia) ?? []).sort();
        const perdidos = cru.filter((h) => !ad.includes(h));
        const flag = cru.length > 0 && ad.length === 0 ? "❌" : perdidos.length ? "⚠️ " : "✅";
        log(
          `       ${flag} ${dia}: API=${cru.length}  adapter=${ad.length}${perdidos.length ? `  PERDIDOS(${perdidos.length}): ${perdidos.slice(0, 12).join(" ")}` : ""}`,
        );
      }
    }
    expect(true).toBe(true);
  }, 600_000);
});

// ── D. pipeline do scheduler ───────────────────────────────────────────────
describe("D. execListarHorarios (pipeline real do scheduler)", () => {
  it("busca simples e busca ancorada em HOJE", async () => {
    for (const c of contas) {
      log(`\n  ══ ${c.nome}`);
      const ctx = await ctxFor(c);

      const simples = JSON.parse((await execListarHorarios(ctx)).result) as {
        count: number;
        slots?: { iso: string; date_label: string; time_label: string }[];
        debug?: unknown;
      };
      log(
        `     simples → ${simples.count} slot(s): ${(simples.slots ?? []).map((s) => `${s.date_label} ${s.time_label}`).join(" | ") || JSON.stringify(simples.debug)}`,
      );

      // O caso do print: lead responde "Hoje".
      const ctxHoje = await ctxFor(c, [{ role: "user", content: "Hoje" }]);
      const comHoje = JSON.parse(
        (await execListarHorarios(ctxHoje, undefined, undefined, hoje())).result,
      ) as {
        count: number;
        slots?: { iso: string; date_label: string; time_label: string }[];
        aviso_data?: string;
        debug?: unknown;
      };
      const doDia = (comHoje.slots ?? []).filter((s) => s.iso.slice(0, 10) === hoje());
      log(
        `     data_alvo=HOJE → ${comHoje.count} slot(s), ${doDia.length} de hoje: ${(comHoje.slots ?? []).map((s) => `${s.date_label} ${s.time_label}`).join(" | ") || JSON.stringify(comHoje.debug)}`,
      );
      if (comHoje.aviso_data) log(`        aviso_data: ${comHoje.aviso_data.slice(0, 120)}`);
    }
    expect(true).toBe(true);
  }, 600_000);
});

// ── E. reprodução do caso Sérgio (04/08): "quero as 9:00" + "Hoje" ─────────
describe("E. lead pede um DIA e cita uma HORA — o dia pedido sobrevive ao corte de 6?", () => {
  it("compara: sem hora citada vs com hora citada", async () => {
    for (const c of contas) {
      log(`\n  ══ ${c.nome}`);
      const semHora = await ctxFor(c, [{ role: "user", content: "Hoje" }]);
      const comHora = await ctxFor(c, [
        { role: "user", content: "Ou sobre anúncio flexível Mas quero falar com um atendente as 9:00 horas" },
        { role: "user", content: "Hoje" },
      ]);

      const rodar = async (ctx: AgentContext, rotulo: string) => {
        const out = JSON.parse(
          (await execListarHorarios(ctx, undefined, undefined, hoje())).result,
        ) as {
          count: number;
          slots?: { iso: string; date_label: string; time_label: string }[];
          aviso_data?: string;
        };
        const doDia = (out.slots ?? []).filter((s) => s.iso.slice(0, 10) === hoje());
        log(
          `     ${rotulo}: ${out.count} slot(s), ${doDia.length} de HOJE → ${(out.slots ?? []).map((s) => `${s.date_label.slice(-5)} ${s.time_label}`).join(" | ")}`,
        );
        if (out.aviso_data) log(`        ⚠️  aviso_data: "${out.aviso_data.slice(0, 90)}…"`);
        return doDia.length;
      };

      const a = await rodar(semHora, 'só "Hoje"        ');
      const b = await rodar(comHora, '"as 9:00" + "Hoje"');
      // A invariante é "o dia pedido NÃO some", não "o dia pedido leva tudo":
      // com uma hora citada é esperado (e desejável) que dias vizinhos entrem no
      // corte. O que nunca pode acontecer é o dia pedido zerar tendo vaga — é aí
      // que o agente responde "hoje não temos vaga" com hoje livre.
      if (a > 0 && b === 0) {
        log(
          `     ❌ citar uma hora ZEROU o dia pedido (tinha ${a} vaga(s)) — o agente conclui "hoje não temos vaga" com hoje livre`,
        );
      } else if (a > 0) {
        log(`     ✅ o dia pedido sobreviveu ao corte (${b} de ${a} vaga(s))`);
      }
      expect(a === 0 || b > 0, "o dia pedido sumiu inteiro do corte de 6").toBe(true);
    }
    expect(true).toBe(true);
  }, 600_000);
});

process.on("exit", () => {
  if (REPORT.length) fs.writeFileSync(REPORT_FILE, `${REPORT.join("\n")}\n`, "utf8");
});
