// Server functions para o painel /admin (somente superadmin).
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { attachSelfhostAuth } from "@/integrations/selfhost/auth-attacher";
import { requireSuperAdmin } from "@/integrations/selfhost/auth-middleware";
import { getSelfhost } from "@/integrations/selfhost/client.server";
import { encryptValue } from "@/lib/crypto.server";


export const listAccounts = createServerFn({ method: "GET" })
  .middleware([attachSelfhostAuth, requireSuperAdmin])
  .handler(async () => {
    const sb = getSelfhost();
    const { data, error } = await sb
      .from("accounts")
      .select("id, nome, helena_account_id, criado_em, atualizado_em")
      .order("criado_em", { ascending: false });
    if (error) throw new Error(error.message);
    return { accounts: data ?? [] };
  });

/** Público (sem auth) — usado pelo embed para resolver qual conta abrir pelo helena_account_id. */
export const listAccountsByHelena = createServerFn({ method: "GET" })
  .inputValidator((d) => z.object({ helenaAccountId: z.string().min(1) }).parse(d))
  .handler(async ({ data }) => {
    const sb = getSelfhost();
    const { data: accounts } = await sb
      .from("accounts")
      .select("id, nome")
      .eq("helena_account_id", data.helenaAccountId)
      .order("criado_em", { ascending: true });
    return { accounts: accounts ?? [] };
  });

export const getAccountDetail = createServerFn({ method: "GET" })
  .middleware([attachSelfhostAuth, requireSuperAdmin])
  .inputValidator((d) => z.object({ accountId: z.string().min(1) }).parse(d))
  .handler(async ({ data }) => {
    const sb = getSelfhost();
    const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

    // A view llm_usage_daily devolve UMA linha por (account, day, provider).
    // O painel quer 1 linha por dia → vamos somar no client (provider-agnóstico).
    const [accountRes, agentRes, usageRaw, msgCountRes, lastLogsRes] = await Promise.all([
      sb.from("accounts").select("*").eq("id", data.accountId).maybeSingle(),
      sb.from("agents").select("*").eq("account_id", data.accountId).maybeSingle(),
      sb
        .from("llm_usage_daily")
        .select("day, provider, total_cost_usd, total_tokens, tokens_in_sum, tokens_out_sum, requests")
        .eq("account_id", data.accountId)
        .gte("day", since)
        .order("day", { ascending: false }),
      sb
        .from("messages")
        .select("id", { count: "exact", head: true })
        .eq("account_id", data.accountId),
      // Últimos 5 logs (qualquer tipo) pra dar contexto rápido na overview
      sb
        .from("admin_logs_view")
        .select("id, kind, status, created_at, model, error")
        .eq("account_id", data.accountId)
        .order("created_at", { ascending: false })
        .limit(5),
    ]);
    if (accountRes.error) throw new Error(accountRes.error.message);

    // Agrupa por dia (somando todos os providers)
    type UsageRow = {
      day: string; provider: string;
      total_cost_usd: number | null; total_tokens: number | null;
      tokens_in_sum: number | null; tokens_out_sum: number | null;
      requests: number | null;
    };
    const byDay = new Map<string, {
      day: string; total_cost_usd: number; total_tokens: number;
      tokens_in: number; tokens_out: number; requests: number;
    }>();
    for (const r of ((usageRaw.data ?? []) as UsageRow[])) {
      const k = r.day;
      const cur = byDay.get(k) ?? {
        day: k, total_cost_usd: 0, total_tokens: 0, tokens_in: 0, tokens_out: 0, requests: 0,
      };
      cur.total_cost_usd += Number(r.total_cost_usd ?? 0);
      cur.total_tokens += Number(r.total_tokens ?? 0);
      cur.tokens_in += Number(r.tokens_in_sum ?? 0);
      cur.tokens_out += Number(r.tokens_out_sum ?? 0);
      cur.requests += Number(r.requests ?? 0);
      byDay.set(k, cur);
    }
    const usage = Array.from(byDay.values()).sort((a, b) => b.day.localeCompare(a.day));

    return {
      account: accountRes.data,
      agent: agentRes.data ?? null,
      usage,
      messageCount: msgCountRes.count ?? 0,
      lastLogs: lastLogsRes.data ?? [],
    };
  });

// ──────────────────────────────────────────────────────────────────
// Logs unificados da conta — agent turns + follow-ups + warm-ups
// ──────────────────────────────────────────────────────────────────

export const listAccountLogs = createServerFn({ method: "GET" })
  .middleware([attachSelfhostAuth, requireSuperAdmin])
  .inputValidator((d) =>
    z
      .object({
        accountId: z.string().min(1),
        kind: z.enum(["all", "agent_turn", "followup", "warmup"]).default("all"),
        status: z.enum(["all", "success", "failed"]).default("all"),
        limit: z.number().int().min(1).max(200).default(50),
        offset: z.number().int().min(0).default(0),
        // Filtro por agente: útil quando a conta tem N agentes
        agentId: z.string().uuid().optional(),
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    const sb = getSelfhost();
    let q = sb
      .from("admin_logs_view")
      .select(
        "id, kind, account_id, agent_id, conversation_id, status, created_at, model, provider, latency_ms, tokens_in, tokens_out, cost_usd, error, detail",
        { count: "exact" },
      )
      .eq("account_id", data.accountId)
      .order("created_at", { ascending: false })
      .range(data.offset, data.offset + data.limit - 1);

    if (data.kind !== "all") q = q.eq("kind", data.kind);
    if (data.status !== "all") q = q.eq("status", data.status);
    if (data.agentId) q = q.eq("agent_id", data.agentId);

    const res = await q;
    if (res.error) throw new Error(res.error.message);
    return {
      logs: res.data ?? [],
      total: res.count ?? 0,
      hasMore: (res.count ?? 0) > data.offset + data.limit,
    };
  });

export const createAccount = createServerFn({ method: "POST" })
  .middleware([attachSelfhostAuth, requireSuperAdmin])
  .inputValidator((d) =>
    z
      .object({
        helenaAccountId: z.string().min(1).max(128),
        nome: z.string().min(1).max(120),
        helenaToken: z.string().min(8).max(1000),
        helenaBaseUrl: z
          .string()
          .url()
          .max(300)
          .optional()
          .or(z.literal("").transform(() => undefined)),
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    const sb = getSelfhost();

    // Conta quantas contas Sarai já existem para este helena_account_id
    const { count: existingCount } = await sb
      .from("accounts")
      .select("id", { count: "exact", head: true })
      .eq("helena_account_id", data.helenaAccountId);

    // Gera ID interno único:
    //   - 1ª conta: usa o próprio helenaAccountId (backward compat)
    //   - 2ª em diante: helenaAccountId-2, -3, etc.
    let internalId = data.helenaAccountId;
    if (existingCount && existingCount > 0) {
      let suffix = existingCount + 1;
      while (true) {
        const candidate = `${data.helenaAccountId}-${suffix}`;
        const { data: ex } = await sb
          .from("accounts")
          .select("id")
          .eq("id", candidate)
          .maybeSingle();
        if (!ex) { internalId = candidate; break; }
        suffix++;
      }
    } else {
      // Mesmo para a 1ª conta, verifica se o ID base já foi tomado diretamente
      const { data: ex } = await sb
        .from("accounts")
        .select("id")
        .eq("id", internalId)
        .maybeSingle();
      if (ex) {
        // Raro — ID já existe mas helena_account_id é diferente; adiciona sufixo
        let suffix = 2;
        while (true) {
          const candidate = `${data.helenaAccountId}-${suffix}`;
          const { data: ex2 } = await sb
            .from("accounts")
            .select("id")
            .eq("id", candidate)
            .maybeSingle();
          if (!ex2) { internalId = candidate; break; }
          suffix++;
        }
      }
    }

    const tokenEnc = await encryptValue(data.helenaToken);

    const accIns = await sb
      .from("accounts")
      .insert({
        id: internalId,
        nome: data.nome,
        helena_account_id: data.helenaAccountId,
        helena_base_url: data.helenaBaseUrl ?? "https://api.crmmentoriae7.com.br",
        helena_token_enc: tokenEnc,
      })
      .select("id")
      .single();
    if (accIns.error) throw new Error(accIns.error.message);

    const agentIns = await sb
      .from("agents")
      .insert({
        account_id: internalId,
        nome: "Assistente Virtual",
        system_prompt: "",
      })
      .select("id, webhook_secret")
      .single();
    if (agentIns.error) {
      await sb.from("accounts").delete().eq("id", internalId);
      throw new Error(agentIns.error.message);
    }

    // Cria linhas filhas padrão
    await Promise.all([
      sb.from("agent_audio").insert({ agent_id: agentIns.data.id }),
      sb.from("agent_followup").insert({ agent_id: agentIns.data.id }),
      sb.from("agent_warmup").insert({ agent_id: agentIns.data.id }),
      sb.from("channels_whatsapp").insert({ agent_id: agentIns.data.id }),
      sb.from("webchat_config").insert({ agent_id: agentIns.data.id }),
      sb.from("account_secrets").insert({ account_id: internalId }),
      sb.from("account_llm_config").insert({ account_id: internalId }),
      sb.from("account_voice_config").insert({ account_id: internalId }),
    ]);

    return {
      accountId: internalId,
      agentId: agentIns.data.id,
      webhookSecret: agentIns.data.webhook_secret as string,
    };
  });

export const getWebhookInfo = createServerFn({ method: "GET" })
  .middleware([attachSelfhostAuth, requireSuperAdmin])
  .inputValidator((d) => z.object({ accountId: z.string().min(1) }).parse(d))
  .handler(async ({ data }) => {
    const sb = getSelfhost();
    const { data: row, error } = await sb
      .from("agents")
      .select("webhook_secret")
      .eq("account_id", data.accountId)
      .single();
    if (error) throw new Error(error.message);
    return { accountId: data.accountId, webhookSecret: row.webhook_secret as string };
  });

