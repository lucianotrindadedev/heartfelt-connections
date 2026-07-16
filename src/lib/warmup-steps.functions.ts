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

// ── Seleção de profissional do warm-up (Clinicorp) ───────────────────────
// Guardada em agents.settings.warmup_prof_ids ("111,222"). Vazio = todos.

export const getWarmupProfessionals = createServerFn({ method: "GET" })
  .inputValidator((d) => z.object({ agentId: z.string().uuid() }).parse(d))
  .handler(async ({ data }) => {
    const sb = getSelfhost();
    const { data: row } = await sb
      .from("agents")
      .select("settings")
      .eq("id", data.agentId)
      .single();
    const s = (row?.settings as Record<string, string> | null) ?? {};
    const raw = (s.warmup_prof_ids ?? "").trim();
    const professional_ids = raw
      ? raw.split(",").map((x) => Number(x.trim())).filter((n) => Number.isFinite(n) && n > 0)
      : [];
    return { professional_ids };
  });

export const saveWarmupProfessionals = createServerFn({ method: "POST" })
  .inputValidator((d) =>
    z
      .object({ agentId: z.string().uuid(), professional_ids: z.array(z.number().int()).max(200) })
      .parse(d),
  )
  .handler(async ({ data }) => {
    const sb = getSelfhost();
    const { data: row } = await sb
      .from("agents")
      .select("settings")
      .eq("id", data.agentId)
      .single();
    const s = { ...((row?.settings as Record<string, string> | null) ?? {}) };
    s.warmup_prof_ids = data.professional_ids.join(",");
    const { error } = await sb.from("agents").update({ settings: s }).eq("id", data.agentId);
    if (error) throw new Error(`Falha ao salvar profissionais do warm-up: ${error.message}`);
    return { ok: true };
  });

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

    // Templates (warm-up) são um recurso do WhatsApp Oficial — Instagram/Messenger
    // NÃO têm templates. Se a conta tem múltiplos canais, pegar o channelId de uma
    // sessão de Instagram fazia o CRM retornar 0 templates. Filtramos para SÓ
    // conversas de WhatsApp, garantindo o channelId do canal certo.
    // ORDENADO POR RECÊNCIA: quando a conta troca o número do WhatsApp, o CRM
    // cria um canal NOVO e as conversas antigas continuam apontando pro canal
    // ANTIGO. Sem ordenar, a query pegava um canal arbitrário (às vezes o do
    // número velho, que não tem os templates) e o app dizia "0 templates" com os
    // templates existindo no número atual. Caso real (Escudero: 3 números ao
    // longo do tempo — eb3f8deb → bee2a827 → 30617312; só o atual tinha os WU).
    // Pegamos os canais do MAIS RECENTE pro mais antigo e usamos o primeiro que
    // tiver templates — o número atual vence, e ainda funciona durante a troca.
    const { data: convs } = await sb
      .from("conversations")
      .select("helena_session_id, channel, atualizado_em, agents!inner(account_id)")
      .eq("agents.account_id", data.accountId)
      .eq("channel", "whatsapp")
      .not("helena_session_id", "is", null)
      .order("atualizado_em", { ascending: false })
      .limit(20);

    const helena = await loadHelenaAccount(data.accountId).catch(() => null);
    if (!helena) {
      return {
        ok: false as const,
        error: "Conta do CRM não configurada para essa account.",
        templates: [] as never[],
      };
    }

    // Canais distintos, do mais recente pro mais antigo (preserva a ordem).
    const channelIds: string[] = [];
    let sessionsTried = 0;
    for (const c of convs ?? []) {
      const sid = c.helena_session_id as string | null;
      if (!sid) continue;
      sessionsTried++;
      const session = await loadHelenaSession(helena, sid).catch(() => null);
      if (session?.channelId && !channelIds.includes(session.channelId)) {
        channelIds.push(session.channelId);
      }
    }
    if (channelIds.length === 0) {
      return {
        ok: false as const,
        error: `Nenhum canal de WhatsApp com sessão encontrado (testei ${sessionsTried}). Templates são só do WhatsApp Oficial — garanta que pelo menos um lead já falou pelo WhatsApp.`,
        templates: [] as never[],
      };
    }

    // Primeiro canal (mais recente) que retornar templates. Assim uma troca de
    // número não esconde os templates do número atual.
    for (const channelId of channelIds) {
      const templates = await listHelenaTemplates(helena, channelId);
      if (templates.length > 0) {
        return { ok: true as const, channelId, templates };
      }
    }

    return {
      ok: false as const,
      error: `Testei ${channelIds.length} canal(is) de WhatsApp (${channelIds.join(", ")}) e o CRM retornou 0 templates ATTENDANCE aprovados. Verifique se há templates aprovados pra esse canal no painel do CRM.`,
      templates: [] as never[],
      channelId: channelIds[0],
    };
  });
