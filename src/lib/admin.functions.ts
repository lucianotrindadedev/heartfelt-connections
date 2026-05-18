// Server functions para o painel /admin (somente superadmin).
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { attachSelfhostAuth } from "@/integrations/selfhost/auth-attacher";
import { requireSuperAdmin } from "@/integrations/selfhost/auth-middleware.server";
import { getSelfhost } from "@/integrations/selfhost/client.server";
import { encryptValue } from "@/lib/crypto.server";


export const listAccounts = createServerFn({ method: "GET" })
  .middleware([attachSelfhostAuth, requireSuperAdmin])
  .handler(async () => {
    const sb = getSelfhost();
    const { data, error } = await sb
      .from("accounts")
      .select("id, nome, criado_em, atualizado_em")
      .order("criado_em", { ascending: false });
    if (error) throw new Error(error.message);
    return { accounts: data ?? [] };
  });

export const getAccountDetail = createServerFn({ method: "GET" })
  .middleware([attachSelfhostAuth, requireSuperAdmin])
  .inputValidator((d) => z.object({ accountId: z.string().min(1) }).parse(d))
  .handler(async ({ data }) => {
    const sb = getSelfhost();
    const [accountRes, agentRes, usageRes, msgCountRes] = await Promise.all([
      sb.from("accounts").select("*").eq("id", data.accountId).maybeSingle(),
      sb.from("agents").select("*").eq("account_id", data.accountId).maybeSingle(),
      sb
        .from("llm_usage_daily")
        .select("day, total_cost_usd, total_tokens")
        .eq("account_id", data.accountId)
        .gte("day", new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10))
        .order("day", { ascending: false }),
      sb
        .from("messages")
        .select("id", { count: "exact", head: true })
        .eq("account_id", data.accountId),
    ]);
    if (accountRes.error) throw new Error(accountRes.error.message);
    return {
      account: accountRes.data,
      agent: agentRes.data ?? null,
      usage: usageRes.data ?? [],
      messageCount: msgCountRes.count ?? 0,
    };
  });

export const createAccount = createServerFn({ method: "POST" })
  .middleware([attachSelfhostAuth, requireSuperAdmin])
  .inputValidator((d) =>
    z
      .object({
        id: z
          .string()
          .min(1)
          .max(64)
          .regex(/^[a-zA-Z0-9_-]+$/, "Use apenas letras, números, _ ou -"),
        nome: z.string().min(1).max(120),
        nomeAgente: z.string().min(1).max(120).optional(),
        systemPrompt: z.string().max(20000).optional(),
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    const sb = getSelfhost();

    const existing = await sb.from("accounts").select("id").eq("id", data.id).maybeSingle();
    if (existing.data) throw new Error("Já existe uma conta com esse ID");

    const accIns = await sb
      .from("accounts")
      .insert({ id: data.id, nome: data.nome })
      .select("id")
      .single();
    if (accIns.error) throw new Error(accIns.error.message);

    const agentIns = await sb
      .from("agents")
      .insert({
        account_id: data.id,
        nome: data.nomeAgente ?? "Assistente Virtual",
        system_prompt: data.systemPrompt ?? "",
      })
      .select("id")
      .single();
    if (agentIns.error) {
      await sb.from("accounts").delete().eq("id", data.id);
      throw new Error(agentIns.error.message);
    }

    return { accountId: data.id, agentId: agentIns.data.id };
  });
