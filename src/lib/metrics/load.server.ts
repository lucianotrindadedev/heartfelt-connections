// Leitura das métricas no banco. Vive num .server.ts porque `loadAgentMetrics`
// é uma função comum (não um handler de createServerFn): o plugin do TanStack
// só remove do bundle do cliente o que está DENTRO de um handler, então
// exportá-la de metrics.functions.ts arrastava o cliente Supabase para o
// browser e quebrava o build de produção (o dev não reclamava).
import { getSelfhost } from "@/integrations/selfhost/client.server";
import {
  aggregateAgentMetrics,
  emptyMetrics,
  type ConvRow,
  type MsgRow,
} from "@/lib/metrics/aggregate";

/**
 * Tamanho da página do PostgREST. NÃO é escolha de gosto: o servidor tem um
 * teto próprio de linhas por resposta (1000 por padrão) e `.limit(5000)` NÃO o
 * levanta — ele devolve 1000 calado. Foi exatamente o que aconteceu na primeira
 * versão deste painel: a conta tinha mais de mil conversas, o painel mostrou
 * "1000 conversas / 7,3% de agendamento" e o aviso de amostra cortada ficou
 * DESLIGADO, porque `.limit()` tinha sido respeitado do ponto de vista do
 * cliente. Número errado sem aviso é pior que número faltando.
 * Por isso a leitura é paginada com `.range()` até a página vir incompleta.
 */
const PAGE = 1000;

/** Teto de conversas lidas por chamada (as mais recentes primeiro). */
const MAX_CONVERSATIONS = 5_000;
/** Teto de mensagens lidas por chamada — o painel é aberto à vontade. */
const MAX_MESSAGES = 40_000;
/** Conversas por lote no `.in(conversation_id, [...])` — evita URL gigante. */
const CONV_CHUNK = 120;

/** Lê conversas + mensagens do período e devolve tudo agregado. */
export async function loadAgentMetrics(accountId: string, days: number) {
  const sb = getSelfhost();

  const agentRow = await sb
    .from("agents")
    .select("id, nome")
    .eq("account_id", accountId)
    .maybeSingle();
  const agentId = agentRow.data?.id as string | undefined;
  if (!agentId) return emptyMetrics(days);

  const sinceMs = Date.now() - days * 24 * 60 * 60 * 1000;
  const sinceIso = new Date(sinceMs).toISOString();

  // ── Conversas ATIVAS no período ─────────────────────────────────────────
  // Por atualizado_em, não por criado_em: uma conversa aberta mês passado que
  // fechou agendamento ontem é resultado de ontem.
  const convs: ConvRow[] = [];
  for (let from = 0; from < MAX_CONVERSATIONS; from += PAGE) {
    const res = await sb
      .from("conversations")
      .select("id, meta, channel, criado_em, atualizado_em")
      .eq("agent_id", agentId)
      .gte("atualizado_em", sinceIso)
      .order("atualizado_em", { ascending: false })
      .range(from, Math.min(from + PAGE, MAX_CONVERSATIONS) - 1);
    if (res.error) throw new Error(res.error.message);
    const rows = (res.data ?? []) as ConvRow[];
    convs.push(...rows);
    if (rows.length < PAGE) break; // página incompleta = acabou
  }
  const truncatedConversas = convs.length >= MAX_CONVERSATIONS;

  // ── Mensagens dessas conversas, em lotes e paginadas ────────────────────
  const msgs: MsgRow[] = [];
  let truncatedMensagens = false;
  outer: for (let i = 0; i < convs.length; i += CONV_CHUNK) {
    const ids = convs.slice(i, i + CONV_CHUNK).map((c) => c.id);
    for (let from = 0; ; from += PAGE) {
      const res = await sb
        .from("messages")
        .select("conversation_id, role, content, meta, criado_em")
        .in("conversation_id", ids)
        .gte("criado_em", sinceIso)
        .order("criado_em", { ascending: true })
        .range(from, from + PAGE - 1);
      if (res.error) throw new Error(res.error.message);
      const rows = (res.data ?? []) as MsgRow[];
      msgs.push(...rows);
      if (msgs.length >= MAX_MESSAGES) {
        truncatedMensagens = true;
        break outer;
      }
      if (rows.length < PAGE) break;
    }
  }

  return aggregateAgentMetrics({
    days,
    agentName: (agentRow.data?.nome as string | null) ?? null,
    convs,
    msgs,
    sinceMs,
    truncated: { conversas: truncatedConversas, mensagens: truncatedMensagens },
  });
}
