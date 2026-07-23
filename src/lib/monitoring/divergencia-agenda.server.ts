// Monitor de agendamento (lógica canônica, server-only). Dois sinais, ambos
// SOMENTE LEITURA:
//
//  1) DIVERGÊNCIA — a data que o AGENTE afirmou ao lead no texto (DD/MM) não bate
//     com a data efetivamente AGENDADA (booked_slot_iso). Fantasma: o lead acha
//     um dia, o CRM tem outro (caso Costa Lima Recreio, Melissa 21 99305-7044).
//
//  2) SLOT PRESO — o slot escolhido (selected_slot_iso) não está na oferta corrente
//     (offered_slots) e o agendamento NÃO saiu (sem appointment_id). Seleção presa
//     numa rodada anterior → o create falha e a conversa trava/escala (caso Costa
//     Lima Recreio, Neymar Junior 21 97558-2703).
//
// Reusa EXATAMENTE os mesmos helpers dos guards de booking (affirmedDatesFromAssistant
// + ddmmInBrt em booking-template.ts; isSlotNotOffered no scheduler) — o que o
// scheduler bloqueia em tempo real é o mesmo que este monitor audita depois.
import type { SupabaseClient } from "@supabase/supabase-js";
import { affirmedDatesFromAssistant, ddmmInBrt } from "@/lib/booking-template";
import { isSlotNotOffered } from "@/lib/agents/scheduler.server";

export interface DivergenciaItem {
  conv: string;
  conta: string;
  fone: string;
  atualizado: string;
  agendado_iso: string;
  agendado_ddmm: string;
  afirmado: string[];
  evidencia: string;
}

export interface DivergenciaResumo {
  total: number;
  ok: number;
  divergente: number;
  sem_data_no_texto: number;
  sem_iso: number;
  divergencias: DivergenciaItem[];
}

/** Lê TODAS as linhas de um builder, paginando de 1000 em 1000 (o Supabase corta
 *  em 1000 por página — sem isto lotes grandes truncam silenciosamente). */
async function fetchAll<T = Record<string, unknown>>(builder: {
  range: (
    from: number,
    to: number,
  ) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>;
}): Promise<T[]> {
  const pageSize = 1000;
  let from = 0;
  const rows: T[] = [];
  for (;;) {
    const { data, error } = await builder.range(from, from + pageSize - 1);
    if (error) throw new Error(error.message);
    const batch = data ?? [];
    rows.push(...batch);
    if (batch.length < pageSize) break;
    from += pageSize;
  }
  return rows;
}

/** Rótulo curto "qua 15/07 13:00" p/ logs/relatório. */
function labelBrt(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  const wd = new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo", weekday: "short" })
    .format(d)
    .replace(".", "");
  const hm = new Intl.DateTimeFormat("pt-BR", {
    timeZone: "America/Sao_Paulo",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(d);
  return `${wd} ${ddmmInBrt(iso)} ${hm}`;
}

/**
 * Varre as conversas com agendamento e classifica cada uma.
 * @param sb        cliente Supabase service-role (getSelfhost()).
 * @param windowDays se informado, só conversas atualizadas nos últimos N dias
 *                   (o cron usa janela curta; a varredura manual usa a base toda).
 */
export async function scanDivergenciasAgenda(
  sb: SupabaseClient,
  windowDays?: number,
): Promise<DivergenciaResumo> {
  let convBuilder = sb
    .from("conversations")
    .select("id, agent_id, phone, lead_phone, meta, atualizado_em")
    .not("meta->lead_data->>booked_slot_iso", "is", null)
    .order("atualizado_em", { ascending: false });
  if (windowDays && windowDays > 0) {
    const since = new Date(Date.now() - windowDays * 86_400_000).toISOString();
    convBuilder = convBuilder.gte("atualizado_em", since);
  }
  const convs = await fetchAll<{
    id: string;
    agent_id: string | null;
    phone: string | null;
    lead_phone: string | null;
    meta: { lead_data?: { booked_slot_iso?: string; selected_slot_iso?: string } } | null;
    atualizado_em: string;
  }>(convBuilder);

  // agentes → contas (para agrupar/rotular por clínica)
  const agentIds = [...new Set(convs.map((c) => c.agent_id).filter(Boolean))] as string[];
  const agentToAccount: Record<string, string> = {};
  for (let i = 0; i < agentIds.length; i += 200) {
    const { data } = await sb.from("agents").select("id, account_id").in("id", agentIds.slice(i, i + 200));
    for (const a of data ?? []) agentToAccount[a.id as string] = a.account_id as string;
  }
  const accountIds = [...new Set(Object.values(agentToAccount).filter(Boolean))];
  const accountName: Record<string, string> = {};
  for (let i = 0; i < accountIds.length; i += 200) {
    const { data } = await sb.from("accounts").select("id, nome").in("id", accountIds.slice(i, i + 200));
    for (const a of data ?? []) accountName[a.id as string] = a.nome as string;
  }

  // mensagens do agente, em lote PAGINADO (um lote de conversas rende >1000 msgs
  // e a página de 1000 truncaria — foi o que escondeu a conversa da Melissa).
  const convIds = convs.map((c) => c.id);
  const msgsByConv = new Map<string, string[]>();
  const CHUNK = 50;
  for (let i = 0; i < convIds.length; i += CHUNK) {
    const ids = convIds.slice(i, i + CHUNK);
    const rows = await fetchAll<{ conversation_id: string; content: string | null }>(
      sb.from("messages").select("conversation_id, content").eq("role", "assistant").in("conversation_id", ids),
    );
    for (const m of rows) {
      const arr = msgsByConv.get(m.conversation_id) ?? [];
      arr.push(m.content ?? "");
      msgsByConv.set(m.conversation_id, arr);
    }
  }

  const resumo: DivergenciaResumo = {
    total: convs.length,
    ok: 0,
    divergente: 0,
    sem_data_no_texto: 0,
    sem_iso: 0,
    divergencias: [],
  };

  for (const c of convs) {
    const ld = c.meta?.lead_data ?? {};
    const booked = (ld.booked_slot_iso ?? ld.selected_slot_iso ?? "").trim();
    if (!booked) {
      resumo.sem_iso++;
      continue;
    }
    const bookedDdmm = ddmmInBrt(booked);
    const texts = msgsByConv.get(c.id) ?? [];
    const affirmed = affirmedDatesFromAssistant(texts);

    if (affirmed.size === 0) {
      resumo.sem_data_no_texto++;
    } else if (affirmed.has(bookedDdmm)) {
      resumo.ok++;
    } else {
      resumo.divergente++;
      const evidencia =
        texts
          .find((t) => [...affirmed].some((d) => t.includes(d)))
          ?.replace(/\s+/g, " ")
          .slice(0, 140) ?? "";
      resumo.divergencias.push({
        conv: c.id,
        conta: accountName[agentToAccount[c.agent_id ?? ""] ?? ""] ?? "(conta?)",
        fone: c.lead_phone || c.phone || "(sem fone)",
        atualizado: c.atualizado_em,
        agendado_iso: booked,
        agendado_ddmm: bookedDdmm,
        afirmado: [...affirmed].sort(),
        evidencia,
      });
    }
  }
  return resumo;
}

export { labelBrt };

// ── sinal 2: slot preso (selected ∉ offered, sem agendamento) ──────────────

export interface StaleSlotItem {
  conv: string;
  conta: string;
  fone: string;
  atualizado: string;
  selected_iso: string;
  offered_isos: string[];
  stage: string | null;
  escalation_reason: string | null;
}

export interface StaleSlotResumo {
  /** conversas com selected_slot_iso e SEM appointment_id (denominador). */
  total_sem_agendamento: number;
  stale: number;
  itens: StaleSlotItem[];
}

/**
 * Conversas em que o slot escolhido não está na oferta corrente E o agendamento
 * não saiu (sem appointment_id) — o padrão de falha do caso Neymar, que o guard
 * `slot_not_offered` bloqueia em runtime. Este scan é a auditoria pós-hoc do
 * mesmo sinal (usa a MESMA função `isSlotNotOffered` do guard).
 *
 * Só considera SEM appointment_id de propósito: quando o agendamento saiu, o
 * `selected ∉ offered` do snapshot é majoritariamente ruído de ofertas
 * sequenciais/remarcação (a oferta foi sobrescrita DEPOIS do booking), e não a
 * falha que o guard pega.
 *
 * @param sb         cliente Supabase service-role (getSelfhost()).
 * @param windowDays se informado, só conversas atualizadas nos últimos N dias.
 */
export async function scanStaleSlots(
  sb: SupabaseClient,
  windowDays?: number,
): Promise<StaleSlotResumo> {
  let staleBuilder = sb
    .from("conversations")
    .select("id, agent_id, phone, lead_phone, meta, atualizado_em")
    .not("meta->lead_data->>selected_slot_iso", "is", null)
    .is("meta->lead_data->>appointment_id", null)
    .order("atualizado_em", { ascending: false });
  if (windowDays && windowDays > 0) {
    const since = new Date(Date.now() - windowDays * 86_400_000).toISOString();
    staleBuilder = staleBuilder.gte("atualizado_em", since);
  }
  const convs = await fetchAll<{
    id: string;
    agent_id: string | null;
    phone: string | null;
    lead_phone: string | null;
    meta: {
      stage?: string;
      lead_data?: {
        selected_slot_iso?: string;
        offered_slots?: { iso: string }[];
        escalation_reason?: string;
      };
    } | null;
    atualizado_em: string;
  }>(staleBuilder);

  // agentes → contas (para agrupar/rotular por clínica)
  const agentIds = [...new Set(convs.map((c) => c.agent_id).filter(Boolean))] as string[];
  const agentToAccount: Record<string, string> = {};
  for (let i = 0; i < agentIds.length; i += 200) {
    const { data } = await sb.from("agents").select("id, account_id").in("id", agentIds.slice(i, i + 200));
    for (const a of data ?? []) agentToAccount[a.id as string] = a.account_id as string;
  }
  const accountIds = [...new Set(Object.values(agentToAccount).filter(Boolean))];
  const accountName: Record<string, string> = {};
  for (let i = 0; i < accountIds.length; i += 200) {
    const { data } = await sb.from("accounts").select("id, nome").in("id", accountIds.slice(i, i + 200));
    for (const a of data ?? []) accountName[a.id as string] = a.nome as string;
  }

  const resumo: StaleSlotResumo = {
    total_sem_agendamento: convs.length,
    stale: 0,
    itens: [],
  };
  for (const c of convs) {
    const ld = c.meta?.lead_data ?? {};
    const offered = ld.offered_slots ?? [];
    if (!isSlotNotOffered(ld.selected_slot_iso, offered)) continue;
    resumo.stale++;
    resumo.itens.push({
      conv: c.id,
      conta: accountName[agentToAccount[c.agent_id ?? ""] ?? ""] ?? "(conta?)",
      fone: c.lead_phone || c.phone || "(sem fone)",
      atualizado: c.atualizado_em,
      selected_iso: (ld.selected_slot_iso ?? "").trim(),
      offered_isos: offered.map((s) => s.iso),
      stage: c.meta?.stage ?? null,
      escalation_reason: ld.escalation_reason ?? null,
    });
  }
  return resumo;
}
