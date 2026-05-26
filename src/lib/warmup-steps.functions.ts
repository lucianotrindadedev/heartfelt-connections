// Server functions da sequência de Warm-up (lembretes de consulta).
//
// Cada agente tem N steps numerados (ordem 1, 2, 3, ...). Cada step define:
//   - quanto tempo ANTES da consulta dispara (ex.: 24h, 2h, 30min)
//   - qual template Helena enviar (busca por nome via /chat/v1/template)
//   - janela de tolerância em minutos (cobre atraso do cron)
//
// Funciona com qualquer source de agenda ativo: Clinicorp, Google Calendar,
// Clinup. Adapter em src/lib/warmup/sources.server.ts.

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { getSelfhost } from "@/integrations/selfhost/client.server";
import {
  loadHelenaAccount,
  loadHelenaSession,
  listHelenaTemplates,
} from "@/lib/helena.server";

const stepInputSchema = z.object({
  ordem: z.number().int().min(1).max(20),
  enabled: z.boolean().default(true),
  time_before_value: z.number().int().min(1).max(10000),
  time_before_unit: z.enum(["minutes", "hours", "days"]),
  helena_template_name: z.string().max(200).default(""),
  window_minutes: z.number().int().min(1).max(720).default(30),
  appointment_status_filter: z.array(z.string()).nullable().optional(),
});

// ── List ──────────────────────────────────────────────────────────────────

export const listWarmupSteps = createServerFn({ method: "GET" })
  .inputValidator((d) => z.object({ agentId: z.string().uuid() }).parse(d))
  .handler(async ({ data }) => {
    const sb = getSelfhost();
    const res = await sb
      .from("warmup_steps")
      .select("*")
      .eq("agent_id", data.agentId)
      .order("ordem", { ascending: true });
    if (res.error) throw new Error(res.error.message);
    return { steps: res.data ?? [] };
  });

// ── Create ────────────────────────────────────────────────────────────────

export const createWarmupStep = createServerFn({ method: "POST" })
  .inputValidator((d) =>
    z.object({ agentId: z.string().uuid() }).merge(stepInputSchema).parse(d),
  )
  .handler(async ({ data }) => {
    const sb = getSelfhost();
    const { agentId, ...payload } = data;
    const res = await sb
      .from("warmup_steps")
      .insert({ agent_id: agentId, ...payload })
      .select("id")
      .single();
    if (res.error) throw new Error(res.error.message);
    return { id: res.data.id as string };
  });

// ── Update ────────────────────────────────────────────────────────────────

export const updateWarmupStep = createServerFn({ method: "POST" })
  .inputValidator((d) =>
    z
      .object({ id: z.string().uuid() })
      .merge(stepInputSchema.partial())
      .parse(d),
  )
  .handler(async ({ data }) => {
    const sb = getSelfhost();
    const { id, ...patch } = data;
    const res = await sb.from("warmup_steps").update(patch).eq("id", id);
    if (res.error) throw new Error(res.error.message);
    return { ok: true };
  });

// ── Delete ────────────────────────────────────────────────────────────────

export const deleteWarmupStep = createServerFn({ method: "POST" })
  .inputValidator((d) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data }) => {
    const sb = getSelfhost();
    const res = await sb.from("warmup_steps").delete().eq("id", data.id);
    if (res.error) throw new Error(res.error.message);
    return { ok: true };
  });

// ── Listar templates Helena (pra UI mostrar dropdown) ─────────────────────

/**
 * Retorna a lista de templates ATTENDANCE disponíveis no Helena pra essa conta.
 * Usa a primeira sessão disponível pra descobrir o channelId.
 */
export const listAccountHelenaTemplates = createServerFn({ method: "GET" })
  .inputValidator((d) => z.object({ accountId: z.string() }).parse(d))
  .handler(async ({ data }) => {
    const sb = getSelfhost();

    const { data: convs } = await sb
      .from("conversations")
      .select("helena_session_id, agents!inner(account_id)")
      .eq("agents.account_id", data.accountId)
      .not("helena_session_id", "is", null)
      .limit(20);

    const helena = await loadHelenaAccount(data.accountId).catch(() => null);
    if (!helena) {
      return {
        ok: false as const,
        error: "Conta do CRM não configurada para essa account.",
        templates: [] as never[],
      };
    }

    let channelId: string | null = null;
    let sessionsTried = 0;
    for (const c of convs ?? []) {
      const sid = c.helena_session_id as string | null;
      if (!sid) continue;
      sessionsTried++;
      const session = await loadHelenaSession(helena, sid).catch(() => null);
      if (session?.channelId) {
        channelId = session.channelId;
        break;
      }
    }
    if (!channelId) {
      return {
        ok: false as const,
        error: `Nenhuma sessão do CRM com channelId encontrada (testei ${sessionsTried}). Garanta que pelo menos um lead já mandou msg pelo WhatsApp.`,
        templates: [] as never[],
      };
    }

    const templates = await listHelenaTemplates(helena, channelId);
    if (templates.length === 0) {
      return {
        ok: false as const,
        error: `channelId ${channelId} OK, mas o CRM retornou 0 templates. Verifique se há templates ATTENDANCE aprovados pra esse canal no painel do CRM.`,
        templates: [] as never[],
        channelId,
      };
    }
    return { ok: true as const, channelId, templates };
  });
