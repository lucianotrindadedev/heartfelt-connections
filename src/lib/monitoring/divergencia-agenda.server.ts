// Monitor de agendamento (lógica canônica, server-only). Dois sinais, ambos
// SOMENTE LEITURA:
//
//  1) DIVERGÊNCIA — a data que o agente afirmou ao lead no texto (DD/MM) não bate
//     com a data efetivamente agendada (booked_slot_iso). Fantasma: o lead acha
//     um dia, o CRM tem outro (caso Costa Lima Recreio, Melissa 21 99305-7044).
//
//  2) SLOT PRESO (stale) — o slot escolhido (selected_slot_iso) não está na oferta
//     corrente (offered_slots) e o agendamento NÃO saiu (sem appointment_id).
//     Seleção "presa" numa rodada de oferta anterior → booking falha técnico e a
//     conversa trava/escala (caso Costa Lima Recreio, Neymar Junior 21 97558-2703).
//
// Os helpers abaixo ESPELHAM src/lib/booking-template.ts (mantidos em sincronia);
// ficam inline de propósito para o monitor não depender da ordem de merge das PRs
// que introduzem esses helpers no app.
import type { SupabaseClient } from "@supabase/supabase-js";

// ── helpers (espelham src/lib/booking-template.ts) ─────────────────────────

interface OfferedSlotLite {
  iso: string;
}

/** DD/MM (zero-padded, fuso BRT) de um instante ISO. "" se inválido. */
export function ddmmInBrt(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  return new Intl.DateTimeFormat("pt-BR", {
    timeZone: "America/Sao_Paulo",
    day: "2-digit",
    month: "2-digit",
  }).format(d);
}

/** Rótulo curto "qua 15/07 13:00" p/ logs/relatório. */
export function labelBrt(iso: string): string {
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

/** Datas DD/MM (zero-padded) afirmadas pelo agente nos textos dados. */
export function affirmedDatesFromAssistant(texts: string[]): Set<string> {
  const out = new Set<string>();
  for (const raw of texts) {
    const matches = (raw ?? "").matchAll(/\b(\d{1,2})\/(\d{1,2})(?:\/\d{2,4})?\b/g);
    for (const m of matches) {
      const dd = Number(m[1]);
      const mm = Number(m[2]);
      if (dd >= 1 && dd <= 31 && mm >= 1 && mm <= 12) {
        out.add(`${String(dd).padStart(2, "0")}/${String(mm).padStart(2, "0")}`);
      }
    }
  }
  return out;
}

/** selected_slot_iso NÃO está entre os horários da oferta corrente. Fail-open
 *  quando offered vazio (sem oferta atual não dá pra aferir). */
export function selectedSlotIsStale(
  selectedIso: string | null | undefined,
  offeredSlots: OfferedSlotLite[] | null | undefined,
): boolean {
  const sel = (selectedIso ?? "").trim();
  const offered = offeredSlots ?? [];
  if (!sel || offered.length === 0) return false;
  return !offered.some((s) => s.iso === sel);
}

// ── tipos de saída ─────────────────────────────────────────────────────────

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
  total_sem_agendamento: number; // conversas com selected_slot_iso e SEM appointment_id
  stale: number;
  itens: StaleSlotItem[];
}

// ── util ───────────────────────────────────────────────────────────────────

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

interface ConvRow {
  id: string;
  agent_id: string | null;
  phone: string | null;
  lead_phone: string | null;
  meta: {
    stage?: string;
    lead_data?: {
      booked_slot_iso?: string;
      selected_slot_iso?: string;
      offered_slots?: OfferedSlotLite[];
      appointment_id?: string | number;
      escalation_reason?: string;
    };
  } | null;
  atualizado_em: string;
}

/** agent_id → nome da conta (para rotular por clínica). */
async function resolveAccountNames(
  sb: SupabaseClient,
  convs: ConvRow[],
): Promise<(agentId: string | null) => string> {
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
  return (agentId) => accountName[agentToAccount[agentId ?? ""] ?? ""] ?? "(conta?)";
}

/** "atualizado_em" >= agora - N dias, em ISO; null se sem janela. */
function sinceIso(windowDays?: number): string | null {
  if (!windowDays || windowDays <= 0) return null;
  return new Date(Date.now() - windowDays * 86_400_000).toISOString();
}

// ── sinal 1: divergência (afirmado no texto ≠ agendado) ────────────────────

/**
 * @param sb        cliente Supabase service-role (getSelfhost()).
 * @param windowDays se informado, só conversas atualizadas nos últimos N dias.
 */
export async function scanDivergenciasAgenda(
  sb: SupabaseClient,
  windowDays?: number,
): Promise<DivergenciaResumo> {
  let convQuery = sb
    .from("conversations")
    .select("id, agent_id, phone, lead_phone, meta, atualizado_em")
    .not("meta->lead_data->>booked_slot_iso", "is", null)
    .order("atualizado_em", { ascending: false });
  const sinceDiv = sinceIso(windowDays);
  if (sinceDiv) convQuery = convQuery.gte("atualizado_em", sinceDiv);
  const convs = await fetchAll<ConvRow>(convQuery);
  const contaDe = await resolveAccountNames(sb, convs);

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
        conta: contaDe(c.agent_id),
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

// ── sinal 2: slot preso (selected ∉ offered, sem agendamento) ──────────────

/**
 * Conversas em que o slot escolhido não está na oferta corrente E o agendamento
 * não saiu (sem appointment_id) — o padrão de falha do caso Neymar. Só considera
 * SEM appointment_id de propósito: com agendamento, o `selected ∉ offered` do
 * snapshot é majoritariamente ruído de ofertas sequenciais/remarcação (a oferta
 * foi sobrescrita DEPOIS do booking), não a falha que o guard pega.
 */
export async function scanStaleSlots(
  sb: SupabaseClient,
  windowDays?: number,
): Promise<StaleSlotResumo> {
  let staleQuery = sb
    .from("conversations")
    .select("id, agent_id, phone, lead_phone, meta, atualizado_em")
    .not("meta->lead_data->>selected_slot_iso", "is", null)
    .is("meta->lead_data->>appointment_id", null)
    .order("atualizado_em", { ascending: false });
  const sinceStale = sinceIso(windowDays);
  if (sinceStale) staleQuery = staleQuery.gte("atualizado_em", sinceStale);
  const convs = await fetchAll<ConvRow>(staleQuery);
  const contaDe = await resolveAccountNames(sb, convs);

  const resumo: StaleSlotResumo = {
    total_sem_agendamento: convs.length,
    stale: 0,
    itens: [],
  };
  for (const c of convs) {
    const ld = c.meta?.lead_data ?? {};
    if (!selectedSlotIsStale(ld.selected_slot_iso, ld.offered_slots)) continue;
    resumo.stale++;
    resumo.itens.push({
      conv: c.id,
      conta: contaDe(c.agent_id),
      fone: c.lead_phone || c.phone || "(sem fone)",
      atualizado: c.atualizado_em,
      selected_iso: (ld.selected_slot_iso ?? "").trim(),
      offered_isos: (ld.offered_slots ?? []).map((s) => s.iso),
      stage: c.meta?.stage ?? null,
      escalation_reason: ld.escalation_reason ?? null,
    });
  }
  return resumo;
}
