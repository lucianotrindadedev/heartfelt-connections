// Server functions para o painel admin gerenciar a Evolution API.
//
// Estrutura:
//  - Credenciais (URL + API key) sao GLOBAIS do SAAS (system_evolution_config).
//    Apenas superadmin pode ler/escrever.
//  - Por agente, o admin escolhe qual instancia da Evolution + qual grupo recebe
//    o alerta. Isso fica em agent_escalation (mantida).
//  - O toggle ativo continua sendo controlavel pelo dono do agente no embed.

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { attachSelfhostAuth } from "@/integrations/selfhost/auth-attacher";
import { requireSuperAdmin } from "@/integrations/selfhost/auth-middleware";
import { getSelfhost } from "@/integrations/selfhost/client.server";
import { encryptValue } from "@/lib/crypto.server";
import {
  EvolutionApiError,
  EvolutionConfigMissingError,
  listGroups as evoListGroups,
  listInstances as evoListInstances,
} from "@/lib/evolution.server";

// ── Credenciais globais ────────────────────────────────────────────────────

export const getSystemEvolutionConfig = createServerFn({ method: "GET" })
  .middleware([attachSelfhostAuth, requireSuperAdmin])
  .handler(async () => {
    const sb = getSelfhost();
    const { data } = await sb
      .from("system_evolution_config")
      .select("base_url, api_key_last4, atualizado_em")
      .eq("id", 1)
      .single();
    return {
      base_url: (data?.base_url as string | null) ?? "",
      key_last4: (data?.api_key_last4 as string | null) ?? null,
      atualizado_em: (data?.atualizado_em as string | null) ?? null,
      configured: !!(data?.base_url && data?.api_key_last4),
    };
  });

export const saveSystemEvolutionConfig = createServerFn({ method: "POST" })
  .middleware([attachSelfhostAuth, requireSuperAdmin])
  .inputValidator((d) =>
    z
      .object({
        base_url: z.string().url().max(300),
        api_key: z.string().min(8).max(500).optional(),
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    const sb = getSelfhost();
    const patch: Record<string, unknown> = {
      id: 1,
      base_url: data.base_url.trim().replace(/\/$/, ""),
      atualizado_em: new Date().toISOString(),
    };
    if (data.api_key) {
      patch.api_key_enc = await encryptValue(data.api_key);
      patch.api_key_last4 = data.api_key.slice(-4);
    }
    const { error } = await sb
      .from("system_evolution_config")
      .upsert(patch, { onConflict: "id" });
    if (error) throw new Error(error.message);
    return { ok: true };
  });

// ── Listagem (instancias + grupos) ────────────────────────────────────────

interface EvolutionResultOk<T> {
  ok: true;
  data: T;
}
interface EvolutionResultErr {
  ok: false;
  error: "not_configured" | "api_error";
  message: string;
}

export const listEvolutionInstances = createServerFn({ method: "GET" })
  .middleware([attachSelfhostAuth, requireSuperAdmin])
  .handler(async (): Promise<EvolutionResultOk<{ name: string; status?: string; profileName?: string }[]> | EvolutionResultErr> => {
    try {
      const instances = await evoListInstances();
      return { ok: true, data: instances };
    } catch (e) {
      if (e instanceof EvolutionConfigMissingError) {
        return { ok: false, error: "not_configured", message: e.message };
      }
      if (e instanceof EvolutionApiError) {
        return {
          ok: false,
          error: "api_error",
          message: `${e.status}: ${e.body.slice(0, 200)}`,
        };
      }
      const msg = e instanceof Error ? e.message : String(e);
      return { ok: false, error: "api_error", message: msg };
    }
  });

export const listEvolutionGroups = createServerFn({ method: "GET" })
  .middleware([attachSelfhostAuth, requireSuperAdmin])
  .inputValidator((d) => z.object({ instance: z.string().min(1).max(120) }).parse(d))
  .handler(async ({ data }): Promise<EvolutionResultOk<{ id: string; subject: string }[]> | EvolutionResultErr> => {
    try {
      const groups = await evoListGroups(data.instance);
      groups.sort((a, b) => a.subject.localeCompare(b.subject));
      return { ok: true, data: groups };
    } catch (e) {
      if (e instanceof EvolutionConfigMissingError) {
        return { ok: false, error: "not_configured", message: e.message };
      }
      if (e instanceof EvolutionApiError) {
        return {
          ok: false,
          error: "api_error",
          message: `${e.status}: ${e.body.slice(0, 200)}`,
        };
      }
      const msg = e instanceof Error ? e.message : String(e);
      return { ok: false, error: "api_error", message: msg };
    }
  });

// ── Binding por agente (admin) ─────────────────────────────────────────────

export const listAccountAgentsEscalation = createServerFn({ method: "GET" })
  .middleware([attachSelfhostAuth, requireSuperAdmin])
  .inputValidator((d) => z.object({ accountId: z.string().min(1) }).parse(d))
  .handler(async ({ data }) => {
    const sb = getSelfhost();
    const { data: agents, error } = await sb
      .from("agents")
      .select("id, nome")
      .eq("account_id", data.accountId)
      .order("criado_em", { ascending: true });
    if (error) throw new Error(error.message);

    const agentIds = (agents ?? []).map((a) => a.id as string);
    if (agentIds.length === 0) return { agents: [] };

    const { data: escs } = await sb
      .from("agent_escalation")
      .select("agent_id, evolution_instance, grupo_alerta, ativo")
      .in("agent_id", agentIds);

    const escByAgent = new Map(
      (escs ?? []).map((e) => [e.agent_id as string, e]),
    );

    return {
      agents: (agents ?? []).map((a) => {
        const e = escByAgent.get(a.id as string);
        return {
          id: a.id as string,
          nome: a.nome as string,
          ativo: !!e?.ativo,
          evolution_instance: (e?.evolution_instance as string | null) ?? "",
          grupo_alerta: (e?.grupo_alerta as string | null) ?? "",
        };
      }),
    };
  });

export const saveAgentEscalationAdmin = createServerFn({ method: "POST" })
  .middleware([attachSelfhostAuth, requireSuperAdmin])
  .inputValidator((d) =>
    z
      .object({
        agentId: z.string().uuid(),
        evolution_instance: z.string().max(120).optional(),
        grupo_alerta: z.string().max(120).optional(),
        ativo: z.boolean().optional(),
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    const sb = getSelfhost();
    const { agentId, ...rest } = data;
    const patch: Record<string, unknown> = {
      agent_id: agentId,
      ...rest,
      atualizado_em: new Date().toISOString(),
    };
    const { error } = await sb
      .from("agent_escalation")
      .upsert(patch, { onConflict: "agent_id" });
    if (error) throw new Error(error.message);
    return { ok: true };
  });
