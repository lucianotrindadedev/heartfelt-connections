// DIAGNÓSTICO DO FLUXO DO AGENTE — roda os agentes DE VERDADE (LLM real,
// agenda real, prompt real de cada conta) contra os 3 provedores.
//
//   npx vitest run --config scripts/diag/vitest.diag.config.ts scripts/diag/fluxo-agente.diag.ts
//
// SEGURANÇA — por que isto não fala com nenhum lead:
//   • chama runQualifierAgent / runSchedulerAgent DIRETO, nunca runAgentTurn.
//     Quem entrega mensagem (deliverReply) é o orquestrador, que não roda aqui.
//   • dryRun: true → nenhuma tag no CRM, nenhum evento criado/cancelado.
//   • conversationId é fictício ("diag-*") e não existe no banco: nada é
//     persistido em conversations.meta.
//   • as tools exercitadas de fato são de LEITURA (listar_horarios).
// Custo: ~1 chamada de LLM por cenário (centavos).
//
// O que valida:
//   D1. Fase 1 — o qualifier, agora com listar_horarios, traz horário REAL em
//       vez de prometer "vou verificar" (o bug da MF Beauty Magé, 28/07).
//   D2. Fase 1 — a decisão de repasse no mesmo turn (mesma lógica do
//       orquestrador) dispara quando o qualifier não trouxe horário.
//   D3. Fase 2 — modo unificado conduz qualificação E agenda no mesmo agente.
//   D4. Regressão — sem agenda ativa, nada disso liga.

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, beforeAll, afterAll } from "vitest";

const REPORT: string[] = [];
const REPORT_FILE = path.resolve(process.cwd(), "scripts", "diag", "last-report-fluxo.txt");
function log(line = "") {
  REPORT.push(line);
  console.log(line);
}

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
const { decryptValue } = await import("@/lib/crypto.server");
const { runQualifierAgent } = await import("@/lib/agents/qualifier.server");
const { runSchedulerAgent } = await import("@/lib/agents/scheduler.server");
const { listAccountAgendas } = await import("@/lib/tools/google-calendar.server");
const { isStage, routeForStage, clampStageForBooking } = await import("@/lib/agents/stage");
const { looksLikeStallReply } = await import("@/lib/agents/stage-signals");
type AgentContext = import("@/lib/agents/context").AgentContext;
type AgentResult = import("@/lib/agents/context").AgentResult;

const sb = getSelfhost();

/** Contas-alvo: uma por provedor, escolhidas entre as SAUDÁVEIS (suíte A). */
const CENARIOS = [
  { provedor: "clinic_experts", accountId: "a5786937-01f3-498b-8a82-39c80a39ce84", nome: "MF Beauty Magé" },
  { provedor: "clinicorp", accountId: "9d03ada1-0a96-483a-94e8-fce87d8bbf40", nome: "Clinica Bomfim" },
  { provedor: "google_calendar", accountId: "f9487fe3-dc30-444a-bd52-d335732003ee", nome: "Escudero Odontologia" },
] as const;

interface Conta {
  accountId: string;
  nome: string;
  provedor: string;
  ctxBase: AgentContext;
}

const contas: Conta[] = [];

beforeAll(async () => {
  for (const c of CENARIOS) {
    const { data: agent } = await sb
      .from("agents")
      .select("id, settings, system_prompt")
      .eq("account_id", c.accountId)
      .eq("ativo", true)
      .limit(1)
      .maybeSingle();
    const { data: secrets } = await sb
      .from("account_secrets")
      .select("openrouter_api_key_enc")
      .eq("account_id", c.accountId)
      .single();
    const { data: llm } = await sb
      .from("account_llm_config")
      .select("default_model, fallback_models, tool_model, max_tokens, temperature, model_temperatures, rag_gate_model")
      .eq("account_id", c.accountId)
      .maybeSingle();
    const orKey = (await decryptValue(secrets?.openrouter_api_key_enc as string)) ?? "";
    const { data: ce } = await sb
      .from("clinic_experts_config")
      .select("professionals")
      .eq("account_id", c.accountId)
      .maybeSingle();
    const profs = Array.isArray(ce?.professionals)
      ? (ce!.professionals as Record<string, unknown>[]).map((p) => ({
          uuid: String(p.uuid ?? ""),
          name: String(p.name ?? ""),
          businessHoursJson:
            typeof p.business_hours_json === "string" ? p.business_hours_json : undefined,
        }))
      : [];

    const model = (llm?.default_model as string) ?? "anthropic/claude-haiku-4.5";
    contas.push({
      accountId: c.accountId,
      nome: c.nome,
      provedor: c.provedor,
      ctxBase: {
        accountId: c.accountId,
        agentId: agent?.id as string,
        conversationId: `diag-fluxo-${c.provedor}`,
        stage: "QUALIFICATION",
        leadData: {},
        conversationPhone: "5521999990000",
        effectivePhone: "5521999990000",
        channel: "whatsapp",
        helenaContact: null,
        agentSettings: (agent?.settings as Record<string, string>) ?? {},
        basePrompt: (agent?.system_prompt as string) ?? "",
        model,
        qualifierModel: model,
        qualifierFallbackModels: (llm?.fallback_models as string[]) ?? [],
        toolModel: (llm?.tool_model as string) ?? model,
        toolFallbackModels: (llm?.fallback_models as string[]) ?? [],
        fallbackModels: (llm?.fallback_models as string[]) ?? [],
        ragGateModel: (llm?.rag_gate_model as string) ?? model,
        maxTokens: (llm?.max_tokens as number) ?? 1024,
        temperature: (llm?.temperature as number) ?? 0.5,
        modelTemperatures: (llm?.model_temperatures as Record<string, number>) ?? {},
        orKey,
        integrations: {
          clinicorp: c.provedor === "clinicorp",
          clinup: false,
          googleCalendar: c.provedor === "google_calendar",
          clinicExperts: c.provedor === "clinic_experts",
          escalation: false,
        },
        googleAgendas: c.provedor === "google_calendar" ? await listAccountAgendas(c.accountId) : [],
        clinicExpertsProfessionals: profs,
        history: [],
        dryRun: true, // NADA é escrito: sem tag no CRM, sem evento na agenda
      } as AgentContext,
    });
  }
  log(`\n[fluxo] ${contas.length} contas (uma por provedor), dryRun=true\n`);
});

/** Horários concretos citados na resposta ("14:30", "14h", "14h30"). */
function horariosNaResposta(reply: string): string[] {
  return [...reply.matchAll(/\b(\d{1,2})(?::(\d{2})|h(\d{2})?)\b/g)].map((m) =>
    `${m[1]!.padStart(2, "0")}:${m[2] ?? m[3] ?? "00"}`,
  );
}

/** MESMA decisão de repasse do orquestrador (Fase 1). Mantida em sincronia à
 *  mão de propósito: se divergir, o teste deixa de valer e é sinal de que a
 *  lógica precisa ser extraída para um módulo compartilhado. */
function decideRepasse(ctx: AgentContext, result: AgentResult, temAgenda: boolean) {
  const proposedStage = isStage(result.next_stage) ? result.next_stage : ctx.stage;
  const handsOff =
    routeForStage(clampStageForBooking(proposedStage, temAgenda)) === "scheduler";
  const ofertouReal =
    (result.tools_called ?? []).includes("listar_horarios") &&
    ((result.lead_data_patch?.offered_slots?.length ?? 0) > 0);
  const stalled = !handsOff && looksLikeStallReply(result.reply);
  return {
    proposedStage,
    cascata: temAgenda && (handsOff || stalled) && !ofertouReal && proposedStage !== "ESCALATED",
    ofertouReal,
    motivo: handsOff ? "next_stage" : stalled ? "stall" : "-",
  };
}

/** O cenário exato do bug: o agente propôs ver horários e o lead aceitou. */
const HISTORICO_ACEITE = [
  { role: "user" as const, content: "Tenho interesse e queria mais informações" },
  { role: "assistant" as const, content: "Olá! Eu sou a assistente da clínica. Qual é o seu primeiro nome?" },
  { role: "user" as const, content: "Maria" },
  {
    role: "assistant" as const,
    content:
      "Perfeito, Maria! Nesse caso o ideal é passar por uma avaliação. Quer que eu veja os horários disponíveis?",
  },
  { role: "user" as const, content: "Quero sim" },
];

describe("D1. Fase 1 — qualifier com consulta de agenda", () => {
  for (const idx of [0, 1, 2]) {
    it(`traz horário REAL em vez de prometer verificar [${CENARIOS[idx]!.provedor}]`, async () => {
      const c = contas[idx]!;
      const ctx: AgentContext = { ...c.ctxBase, history: [...HISTORICO_ACEITE] };
      const r = await runQualifierAgent(ctx);
      const chamouAgenda = (r.tools_called ?? []).includes("listar_horarios");
      const slots = r.lead_data_patch?.offered_slots ?? [];
      const stall = looksLikeStallReply(r.reply);

      log(`\n  ── [${c.provedor}] ${c.nome} — qualifier`);
      log(`     tools: ${(r.tools_called ?? []).join(", ") || "(nenhuma)"}`);
      log(`     next_stage: ${r.next_stage} | slots ofertados: ${slots.length}`);
      log(`     enrolação? ${stall ? "SIM ❌" : "não ✅"}`);
      log(`     reply: ${r.reply.replace(/\n/g, " ").slice(0, 200)}`);

      // O que NÃO pode acontecer de jeito nenhum:
      expect(stall, `qualifier enrolou em vez de agir: "${r.reply.slice(0, 120)}"`).toBe(false);

      // Se citou horário concreto, ele TEM que ter vindo da agenda.
      const citados = horariosNaResposta(r.reply);
      if (citados.length > 0) {
        expect(
          chamouAgenda,
          `citou horário (${citados.join(", ")}) SEM chamar listar_horarios — horário inventado`,
        ).toBe(true);
        const reais = new Set(slots.map((s) => s.time_label));
        const inventados = citados.filter((h) => !reais.has(h));
        expect(
          inventados,
          `horários citados que NÃO estão em offered_slots: ${inventados.join(", ")}`,
        ).toEqual([]);
      }
    }, 180_000);
  }
});

describe("D2. Fase 1 — decisão de repasse no mesmo turn", () => {
  // Determinístico de propósito: a decisão é código, não LLM. Testar com
  // resultado de LLM real tornaria o teste instável sem medir nada a mais.
  const casos: { nome: string; r: AgentResult; esperado: boolean; porque: string }[] = [
    {
      nome: "qualifier propôs SLOT_OFFER sem ofertar horário",
      r: { reply: "Perfeito! Vamos ver a agenda.", next_stage: "SLOT_OFFER", tools_called: [] },
      esperado: true,
      porque: "o scheduler tem que assumir no mesmo turn e trazer horário real",
    },
    {
      nome: "qualifier enrolou ('vou verificar a agenda')",
      r: { reply: "Ótimo! Vou verificar a agenda e já te aviso.", next_stage: "QUALIFICATION", tools_called: [] },
      esperado: true,
      porque: "promessa vazia — o scheduler responde de verdade",
    },
    {
      nome: "qualifier JÁ ofertou horário real",
      r: {
        reply: "Tenho quarta-feira, 29/07 às 12:00 ou 12:30. Qual fica melhor?",
        next_stage: "SLOT_OFFER",
        tools_called: ["listar_horarios"],
        lead_data_patch: {
          offered_slots: [
            { iso: "2026-07-29T12:00:00-03:00", date_label: "quarta-feira, 29/07", time_label: "12:00" },
          ],
        },
      },
      esperado: false,
      porque: "não gasta segunda chamada de LLM — a resposta dele já serve",
    },
    {
      nome: "qualifier pediu um dado ao lead",
      r: {
        reply: "Me passa seu nome completo, por favor, que eu já consulto os horários.",
        next_stage: "QUALIFICATION",
        tools_called: [],
      },
      esperado: false,
      porque: "pedir dado é progresso — cascatear descartaria a pergunta",
    },
    {
      nome: "qualifier escalou para humano",
      r: { reply: "Vou te transferir para a equipe.", next_stage: "ESCALATED", tools_called: [] },
      esperado: false,
      porque: "escalada nunca vira agendamento",
    },
  ];

  for (const caso of casos) {
    it(`${caso.nome} → cascata=${caso.esperado}`, () => {
      const d = decideRepasse(contas[0]!.ctxBase, caso.r, true);
      log(`  ── ${caso.nome}: next_stage=${d.proposedStage} ofertou_real=${d.ofertouReal} → cascata=${d.cascata} (${d.motivo})`);
      expect(d.cascata, caso.porque).toBe(caso.esperado);
    });
  }

  it("sem integração de agenda, NUNCA cascateia", () => {
    const d = decideRepasse(
      contas[0]!.ctxBase,
      { reply: "Vou verificar a agenda.", next_stage: "SLOT_OFFER", tools_called: [] },
      false,
    );
    expect(d.cascata).toBe(false);
  });
});

describe("D3. Fase 2 — modo unificado em QUALIFICATION", () => {
  // Cenário mais DURO que a produção de propósito: força stage=QUALIFICATION.
  // Na produção, com as correções da Fase 1, este mesmo diálogo chegaria já
  // promovido a SLOT_OFFER (userAcceptedSchedulingProposal). Aqui queremos
  // saber como o agente unificado se vira quando a promoção NÃO acontece —
  // que é justamente a razão de existir do modo unificado.
  //
  // O invariante NÃO é "tem que chamar a tool": o prompt do proprietário pode
  // legitimamente mandar coletar nome/WhatsApp antes (MF Beauty faz isso). O
  // invariante é: nunca PROMETER consultar a agenda sem consultar, e nunca
  // citar horário que não veio da tool.
  for (const idx of [0, 1, 2]) {
    it(`não enrola nem inventa horário [${CENARIOS[idx]!.provedor}]`, async () => {
      const c = contas[idx]!;
      const ctx: AgentContext = {
        ...c.ctxBase,
        agentSettings: { ...c.ctxBase.agentSettings, agent_mode: "unified" },
        stage: "QUALIFICATION",
        history: [...HISTORICO_ACEITE],
      };
      const r = await runSchedulerAgent(ctx);
      const slots = r.lead_data_patch?.offered_slots ?? [];

      log(`\n  ── [${c.provedor}] ${c.nome} — unificado (stage=QUALIFICATION)`);
      log(`     tools: ${(r.tools_called ?? []).join(", ") || "(nenhuma)"}`);
      log(`     next_stage: ${r.next_stage} | slots: ${slots.length}`);
      log(`     reply: ${r.reply.replace(/\n/g, " ").slice(0, 200)}`);

      expect(
        looksLikeStallReply(r.reply),
        `prometeu consultar a agenda sem consultar: "${r.reply.slice(0, 140)}"`,
      ).toBe(false);

      const citados = horariosNaResposta(r.reply);
      const reais = new Set(slots.map((s) => s.time_label));
      const inventados = citados.filter((h) => !reais.has(h));
      expect(inventados, `horários inventados: ${inventados.join(", ")}`).toEqual([]);
    }, 180_000);
  }
});

describe("D3b. Fase 2 — modo unificado em SLOT_OFFER", () => {
  // O lead está esperando ver horários. Duas saídas são legítimas:
  //   (a) ofertar horário REAL vindo da tool; ou
  //   (b) pedir um dado que o prompt do proprietário exige ANTES da agenda
  //       (a MF Beauty exige nome completo + WhatsApp — está escrito no prompt).
  // O que NÃO é legítimo: prometer consultar sem consultar, ou citar horário
  // que não veio da tool.
  //
  // NOTA de harness: aqui dryRun=true, o que DESLIGA o ensureOfferedSlots — a
  // busca determinística que, em produção, injeta os horários em SLOT_OFFER
  // independente de o LLM chamar a tool. Ou seja, este teste é mais duro que a
  // produção: mede só o que o modelo faz sozinho.
  for (const idx of [0, 1, 2]) {
    it(`oferta horário real ou pede o dado que falta [${CENARIOS[idx]!.provedor}]`, async () => {
      const c = contas[idx]!;
      const ctx: AgentContext = {
        ...c.ctxBase,
        agentSettings: { ...c.ctxBase.agentSettings, agent_mode: "unified" },
        stage: "SLOT_OFFER",
        leadData: { name: "Maria Silva", interest: "avaliação" },
        history: [...HISTORICO_ACEITE],
      };
      const r = await runSchedulerAgent(ctx);
      const slots = r.lead_data_patch?.offered_slots ?? [];

      log(`\n  ── [${c.provedor}] ${c.nome} — unificado (stage=SLOT_OFFER)`);
      log(`     tools: ${(r.tools_called ?? []).join(", ") || "(nenhuma)"}`);
      log(`     next_stage: ${r.next_stage} | slots: ${slots.length}`);
      log(`     reply: ${r.reply.replace(/\n/g, " ").slice(0, 200)}`);

      expect(looksLikeStallReply(r.reply), `enrolou: "${r.reply.slice(0, 140)}"`).toBe(false);

      const pediuDado =
        /\b(?:me\s+(?:passa|passe|manda|mande|envia|envie|informa|informe|confirma|confirme)|qual\s+(?:é\s+)?(?:o|a)\s+seu|nome\s+completo|whatsapp)\b/i.test(
          r.reply,
        );
      expect(
        slots.length > 0 || pediuDado,
        `em SLOT_OFFER não ofertou horário NEM pediu dado: "${r.reply.slice(0, 140)}"`,
      ).toBe(true);

      const citados = horariosNaResposta(r.reply);
      const reais = new Set(slots.map((s) => s.time_label));
      const inventados = citados.filter((h) => !reais.has(h));
      expect(inventados, `horários inventados: ${inventados.join(", ")}`).toEqual([]);
    }, 180_000);
  }
});

describe("D4. Regressão — conta SEM agenda", () => {
  it("qualifier sem agenda não ganha a tool nem cita horário", async () => {
    const c = contas[0]!;
    const ctx: AgentContext = {
      ...c.ctxBase,
      history: [...HISTORICO_ACEITE],
      integrations: {
        clinicorp: false,
        clinup: false,
        googleCalendar: false,
        clinicExperts: false,
        escalation: false,
      },
    };
    const r = await runQualifierAgent(ctx);
    log(`\n  ── sem agenda: tools=${(r.tools_called ?? []).join(",") || "(nenhuma)"} next_stage=${r.next_stage}`);
    log(`     reply: ${r.reply.replace(/\n/g, " ").slice(0, 180)}`);
    expect(
      (r.tools_called ?? []).includes("listar_horarios"),
      "conta sem agenda NÃO pode receber a tool de horários",
    ).toBe(false);
    // A trava anti-horário-inventado (scrubInventedTimeOffers) precisa continuar
    // valendo: sem offered_slots, nenhuma oferta concreta de dia+hora sobrevive.
    expect(
      /\b(segunda|terça|quarta|quinta|sexta|sábado|domingo|amanhã|hoje)[^.!?\n]{0,40}\s[àa]s\s*\d{1,2}/i.test(
        r.reply,
      ),
      `ofertou dia+hora sem agenda: "${r.reply.slice(0, 140)}"`,
    ).toBe(false);
  }, 180_000);
});

afterAll(() => {
  fs.writeFileSync(REPORT_FILE, `${REPORT.join("\n")}\n`, "utf8");
});
