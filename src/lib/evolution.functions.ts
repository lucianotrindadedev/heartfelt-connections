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

    interface EscRow {
      agent_id: string;
      evolution_instance: string | null;
      grupo_alerta: string | null;
      ativo: boolean | null;
      notificar_agendamentos: boolean | null;
      notification_template: string | null;
      notification_summary_enabled: boolean | null;
      notification_summary_instruction: string | null;
    }
    const { data: escsRaw } = await sb
      .from("agent_escalation")
      .select("agent_id, evolution_instance, grupo_alerta, ativo, notificar_agendamentos, notification_template, notification_summary_enabled, notification_summary_instruction")
      .in("agent_id", agentIds);
    const escs = (escsRaw ?? []) as unknown as EscRow[];

    const escByAgent = new Map(escs.map((e) => [e.agent_id, e]));

    return {
      agents: (agents ?? []).map((a) => {
        const e = escByAgent.get(a.id as string);
        return {
          id: a.id as string,
          nome: a.nome as string,
          ativo: !!e?.ativo,
          evolution_instance: e?.evolution_instance ?? "",
          grupo_alerta: e?.grupo_alerta ?? "",
          notificar_agendamentos: !!e?.notificar_agendamentos,
          notification_template: e?.notification_template ?? "",
          // default true: NULL/undefined contam como ligado
          notification_summary_enabled: e?.notification_summary_enabled !== false,
          notification_summary_instruction: e?.notification_summary_instruction ?? "",
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
        notificar_agendamentos: z.boolean().optional(),
        // Empty string = restaurar default (NULL no banco).
        notification_template: z.string().max(4000).optional(),
        notification_summary_enabled: z.boolean().optional(),
        notification_summary_instruction: z.string().max(2000).optional(),
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    const sb = getSelfhost();
    const { agentId, ...rest } = data;
    // String vazia em campos opcionais = NULL (volta ao default do código).
    const normalized: Record<string, unknown> = { ...rest };
    for (const k of ["notification_template", "notification_summary_instruction"] as const) {
      if (normalized[k] === "") normalized[k] = null;
    }
    const patch: Record<string, unknown> = {
      agent_id: agentId,
      ...normalized,
      atualizado_em: new Date().toISOString(),
    };
    const { error } = await sb
      .from("agent_escalation")
      .upsert(patch, { onConflict: "agent_id" });
    if (error) throw new Error(error.message);
    return { ok: true };
  });

// ── Pré-visualização da notificação ────────────────────────────────────────
//
// Renderiza um template com dados de exemplo fixos. NÃO chama o LLM (usa um
// resumo simulado), para a UI dar feedback instantâneo enquanto o usuário
// edita o template.

export const previewBookingNotification = createServerFn({ method: "POST" })
  .middleware([attachSelfhostAuth, requireSuperAdmin])
  .inputValidator((d) =>
    z
      .object({
        template: z.string().max(4000).optional(),
        summary_enabled: z.boolean().optional(),
        summary_instruction: z.string().max(2000).optional(),
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    const { renderBookingTemplate, buildTemplateVars, DEFAULT_TEMPLATE } =
      await import("@/lib/agents/notify-booking.server");
    const template = (data.template?.trim() || DEFAULT_TEMPLATE);
    const summaryEnabled = data.summary_enabled !== false;
    const sampleSummary = summaryEnabled
      ? "Lead com interesse em implante após extrações há 3 anos; prefere consulta à tarde no Recreio."
      : "";
    const vars = buildTemplateVars(
      {
        agentId: "preview",
        accountId: "preview",
        event: "created",
        patientName: "Maria Silva",
        phone: "+5521981783821",
        datetimeIso: new Date(Date.now() + 24 * 3600_000).toISOString(),
        appointmentLabel: "Visita guiada",
        agenda: "Festas",
        interesse: "IMPLANTE",
        observacoes: "Dor superior esquerda",
        agenteNome: "Sarah",
        empresa: "Costa Lima Odontologia",
        customFields: { idade: "42", convidados: "80" },
      },
      sampleSummary,
    );
    return {
      rendered: renderBookingTemplate(template, vars).trim(),
      // Lista das variáveis suportadas (alimenta o dropdown "Inserir variável").
      variables: [
        { group: "Lead", items: ["nome", "telefone", "interesse", "observacoes"] },
        {
          group: "Agendamento",
          items: ["evento", "data", "hora", "data_hora", "dia_semana", "tipo_consulta", "agenda"],
        },
        { group: "Contexto", items: ["resumo", "agente", "empresa"] },
        { group: "Custom fields", items: ["cf.<chave>"] },
      ],
    };
  });
