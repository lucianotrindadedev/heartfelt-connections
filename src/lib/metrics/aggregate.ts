// Agregação das métricas do agente — PURO, sem banco.
//
// Separado da server function de propósito: assim dá pra alimentar a agregação
// com linhas de verdade (script de diagnóstico) ou sintéticas (teste) e conferir
// os números, em vez de confiar que "o painel parece certo". Quem lê do banco é
// metrics.functions.ts; aqui só entra dado já carregado.
import {
  classifyObjections,
  interestKey,
  isUsableInterest,
  median,
  percentile,
  topCounts,
  type ObjectionKey,
} from "@/lib/metrics/lead-signals";

/**
 * Acima disto o intervalo entre a fala do lead e a resposta do agente não é
 * "demora": é agente pausado, atendimento programado ou lead que voltou horas
 * depois. Entra numa contagem à parte em vez de envenenar a mediana.
 */
export const RESPONSE_OUTLIER_MS = 2 * 60 * 60 * 1000;

/** Chaves de telemetria que indicam agendamento SEGURADO ou falho. */
const BOOKING_HEALTH_KEYS = [
  "false_confirmation_scrubbed",
  "false_confirmation_blocked",
  "booking_validation_only_blocked",
  "booking_guard_hold",
  "booking_escalated_technical",
  "double_booking_blocked",
  "preflight_blocked",
  "phantom_reschedule_blocked",
] as const;

const BOOKING_HEALTH_LABELS: Record<string, string> = {
  false_confirmation_scrubbed: "Confirmação falsa corrigida",
  false_confirmation_blocked: "Confirmação falsa bloqueada",
  booking_validation_only_blocked: "Faltou dado obrigatório",
  booking_guard_hold: "Agendamento segurado por trava",
  booking_escalated_technical: "Escalado por falha técnica",
  double_booking_blocked: "Agendamento duplicado evitado",
  preflight_blocked: "Dado inválido barrado antes de agendar",
  phantom_reschedule_blocked: "Remarcação fantasma bloqueada",
};

const STAGE_LABELS: Record<string, string> = {
  RECEPTION: "Recepção",
  QUALIFICATION: "Qualificação",
  SLOT_OFFER: "Oferta de horário",
  NAME_COLLECT: "Coleta de dados",
  BOOKING: "Fechando agendamento",
  CONFIRMED: "Confirmado",
  ESCALATED: "Escalado p/ humano",
};

/** Ordem real do funil — não é alfabética nem a ordem que o banco devolve. */
const STAGE_ORDER = [
  "RECEPTION",
  "QUALIFICATION",
  "SLOT_OFFER",
  "NAME_COLLECT",
  "BOOKING",
  "CONFIRMED",
  "ESCALATED",
];

export const CHANNEL_LABELS: Record<string, string> = {
  whatsapp: "WhatsApp",
  instagram: "Instagram",
  messenger: "Messenger",
  unknown: "Não identificado",
};

export type LeadData = {
  name?: string;
  interest?: string;
  appointment_id?: string;
  booked_slot_iso?: string;
  selected_slot_iso?: string;
  selected_agenda?: string;
  escalation_reason?: string;
  custom_fields?: Record<string, unknown>;
};

export type ConvRow = {
  id: string;
  meta: Record<string, unknown> | null;
  channel: string | null;
  criado_em: string;
  atualizado_em: string;
};

export type MsgRow = {
  conversation_id: string;
  role: string;
  content: string | null;
  meta: Record<string, unknown> | null;
  criado_em: string;
};

export type Appointment = {
  name: string;
  slotIso: string | null;
  agenda: string | null;
  channel: string;
  bookedAt: string;
  interest: string | null;
};

/** Data (YYYY-MM-DD) no fuso de Brasília — o dono lê o painel no horário dele. */
export function dayBrt(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

export function aggregateAgentMetrics(input: {
  days: number;
  agentName: string | null;
  convs: ConvRow[];
  msgs: MsgRow[];
  sinceMs: number;
  truncated: { conversas: boolean; mensagens: boolean };
}) {
  const { days, agentName, convs, msgs, sinceMs, truncated } = input;

  // ── Varredura das mensagens ─────────────────────────────────────────────
  const llmLatencies: number[] = [];
  const replyDelays: number[] = [];
  let repliesOutOfHours = 0;
  let agentMessages = 0;
  let leadMessages = 0;
  let costUsd = 0;
  let deliveryFailures = 0;
  const bookingHealth = new Map<string, number>();
  // Objeção contada UMA vez por conversa: um lead que repete "tá caro" cinco
  // vezes é um lead com objeção de preço, não cinco.
  const objectionsByConv = new Map<string, Set<ObjectionKey>>();
  // Quando o agendamento foi FEITO (turn que chamou a tool), não quando a
  // conversa foi tocada pela última vez.
  const bookedAtByConv = new Map<string, string>();
  const msgsByDay = new Map<string, number>();

  // Agrupa por conversa pra medir o intervalo lead → resposta na ordem certa.
  const byConv = new Map<string, MsgRow[]>();
  for (const m of msgs) {
    const list = byConv.get(m.conversation_id);
    if (list) list.push(m);
    else byConv.set(m.conversation_id, [m]);
  }

  for (const [convId, list] of byConv) {
    list.sort((a, b) => a.criado_em.localeCompare(b.criado_em));
    let lastUserAt: number | null = null;
    for (const m of list) {
      const meta = (m.meta ?? {}) as Record<string, unknown>;
      const origem = String(meta.origem ?? "");
      const day = dayBrt(m.criado_em);
      if (day) msgsByDay.set(day, (msgsByDay.get(day) ?? 0) + 1);

      // Eco (a própria mensagem do agente devolvida pelo CRM) não é conversa:
      // contaria em dobro e ainda zeraria o tempo de resposta.
      if (meta.is_echo === true) continue;

      if (m.role === "user" && origem === "lead") {
        leadMessages += 1;
        // Só a PRIMEIRA mensagem da rajada marca o relógio: o lead que manda
        // três seguidas espera desde a primeira, não desde a última.
        if (lastUserAt == null) lastUserAt = new Date(m.criado_em).getTime();
        for (const key of classifyObjections(m.content ?? "")) {
          const set = objectionsByConv.get(convId) ?? new Set<ObjectionKey>();
          set.add(key);
          objectionsByConv.set(convId, set);
        }
        continue;
      }

      if (origem !== "agente") continue;

      agentMessages += 1;
      const latency = Number(meta.latency_ms ?? 0);
      if (latency > 0) llmLatencies.push(latency);
      costUsd += Number(meta.cost_usd_estimate ?? 0) + Number(meta.split_cost_usd ?? 0);
      if (meta.delivery_status && meta.delivery_status !== "delivered") deliveryFailures += 1;

      for (const k of BOOKING_HEALTH_KEYS) {
        if (meta[k]) bookingHealth.set(k, (bookingHealth.get(k) ?? 0) + 1);
      }

      const tools = Array.isArray(meta.tools_called) ? (meta.tools_called as string[]) : [];
      if (tools.some((t) => t.startsWith("criar_agendamento") || t.startsWith("agendar_"))) {
        bookedAtByConv.set(convId, m.criado_em);
      }

      if (lastUserAt != null) {
        const delta = new Date(m.criado_em).getTime() - lastUserAt;
        if (delta >= 0) {
          if (delta <= RESPONSE_OUTLIER_MS) replyDelays.push(delta);
          else repliesOutOfHours += 1;
        }
        lastUserAt = null; // só o PRIMEIRO retorno conta como tempo de resposta
      }
    }
  }

  // ── Varredura das conversas ─────────────────────────────────────────────
  const stageCounts = new Map<string, number>();
  const channelCounts = new Map<string, number>();
  const escalationCounts = new Map<string, number>();
  const interestEntries: { key: string; label: string }[] = [];
  const convsByDay = new Map<string, number>();
  const appointments: Appointment[] = [];

  for (const c of convs) {
    const meta = (c.meta ?? {}) as Record<string, unknown>;
    const ld = (meta.lead_data ?? {}) as LeadData;

    const stage = String(meta.stage ?? "").toUpperCase();
    if (stage) stageCounts.set(stage, (stageCounts.get(stage) ?? 0) + 1);

    const ch = (c.channel ?? "unknown").toLowerCase();
    channelCounts.set(ch, (channelCounts.get(ch) ?? 0) + 1);

    const startDay = dayBrt(c.criado_em);
    if (startDay && new Date(c.criado_em).getTime() >= sinceMs) {
      convsByDay.set(startDay, (convsByDay.get(startDay) ?? 0) + 1);
    }

    if (ld.escalation_reason) {
      const r = String(ld.escalation_reason).slice(0, 60);
      escalationCounts.set(r, (escalationCounts.get(r) ?? 0) + 1);
    }

    const cf = (ld.custom_fields ?? {}) as Record<string, unknown>;
    const rawInterest =
      ld.interest ??
      (typeof cf.procedimento === "string" ? cf.procedimento : undefined) ??
      (typeof cf.tipo_tratamento === "string" ? cf.tipo_tratamento : undefined);
    const usableInterest = isUsableInterest(rawInterest) ? rawInterest!.trim() : null;
    if (usableInterest) {
      interestEntries.push({ key: interestKey(usableInterest), label: usableInterest });
    }

    if (ld.appointment_id) {
      appointments.push({
        name: (ld.name ?? "").trim() || "Sem nome",
        slotIso: ld.booked_slot_iso ?? ld.selected_slot_iso ?? null,
        agenda: ld.selected_agenda ?? null,
        channel: CHANNEL_LABELS[ch] ?? ch,
        bookedAt: bookedAtByConv.get(c.id) ?? c.atualizado_em,
        interest: usableInterest,
      });
    }
  }

  appointments.sort((a, b) => b.bookedAt.localeCompare(a.bookedAt));

  // Série diária unificada (conversas iniciadas x mensagens trocadas).
  const allDays = new Set([...convsByDay.keys(), ...msgsByDay.keys()]);
  const daily = [...allDays]
    .filter(Boolean)
    .sort()
    .map((day) => ({
      day,
      conversas: convsByDay.get(day) ?? 0,
      mensagens: msgsByDay.get(day) ?? 0,
    }));

  const objectionCounts = new Map<ObjectionKey, number>();
  for (const set of objectionsByConv.values()) {
    for (const k of set) objectionCounts.set(k, (objectionCounts.get(k) ?? 0) + 1);
  }

  const totalConversas = convs.length;
  const totalAgendamentos = appointments.length;

  return {
    days,
    truncated,
    agentName,
    kpis: {
      conversas: totalConversas,
      agendamentos: totalAgendamentos,
      // Quantas das conversas ativas viraram agendamento. É a métrica que o
      // dono cobra; só o número absoluto esconde queda de eficiência quando o
      // volume sobe junto.
      taxaAgendamento:
        totalConversas > 0 ? Math.round((totalAgendamentos / totalConversas) * 1000) / 10 : 0,
      mensagensLead: leadMessages,
      mensagensAgente: agentMessages,
      escalados: stageCounts.get("ESCALATED") ?? 0,
      custoUsd: Math.round(costUsd * 10000) / 10000,
      falhasEntrega: deliveryFailures,
    },
    tempoResposta: {
      // Quanto o lead esperou de fato (inclui o debounce de agrupamento).
      medianaMs: median(replyDelays),
      p90Ms: percentile(replyDelays, 90),
      amostra: replyDelays.length,
      foraDeExpediente: repliesOutOfHours,
      // Só o tempo do modelo — separa "a IA está lenta" de "o debounce está alto".
      llmMedianaMs: median(llmLatencies),
      llmP90Ms: percentile(llmLatencies, 90),
    },
    funil: STAGE_ORDER.filter((s) => (stageCounts.get(s) ?? 0) > 0).map((s) => ({
      stage: s,
      label: STAGE_LABELS[s] ?? s,
      count: stageCounts.get(s) ?? 0,
    })),
    // Conversas sem estágio nenhum — normalmente contato que chegou e nunca
    // teve um turno do agente. O funil NÃO soma o total de conversas por causa
    // delas; sem expor esse número a tela parece estar perdendo gente.
    funilSemEstagio: totalConversas - STAGE_ORDER.reduce((sum, s) => sum + (stageCounts.get(s) ?? 0), 0),
    agendamentos: appointments.slice(0, 25),
    interesses: topCounts(interestEntries, 10),
    objecoes: [...objectionCounts.entries()]
      .map(([key, count]) => ({ key, count }))
      .sort((a, b) => b.count - a.count),
    objecoesLeadsAnalisados: byConv.size,
    escaladas: [...escalationCounts.entries()]
      .map(([motivo, count]) => ({ motivo, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 8),
    canais: [...channelCounts.entries()]
      .map(([key, count]) => ({ label: CHANNEL_LABELS[key] ?? key, count }))
      .sort((a, b) => b.count - a.count),
    saudeAgendamento: [...bookingHealth.entries()]
      .map(([key, count]) => ({ label: BOOKING_HEALTH_LABELS[key] ?? key, count }))
      .sort((a, b) => b.count - a.count),
    daily,
  };
}

export type AgentMetrics = ReturnType<typeof aggregateAgentMetrics>;

export function emptyMetrics(days: number): AgentMetrics {
  return aggregateAgentMetrics({
    days,
    agentName: null,
    convs: [],
    msgs: [],
    sinceMs: Date.now(),
    truncated: { conversas: false, mensagens: false },
  });
}
