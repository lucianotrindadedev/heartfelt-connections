import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { getSelfhost } from "@/integrations/selfhost/client.server";
import { encryptValue } from "@/lib/crypto.server";
import { resetConversationHistory } from "@/lib/reset-conversation.server";
import {
  getGoogleCalendarStatus,
  listAvailableCalendars,
  selectGoogleCalendar,
  listAccountAgendas,
  saveAccountAgendas,
} from "@/lib/tools/google-calendar.server";

const accountIdInput = z.object({ accountId: z.string().min(1) });
const agentIdInput = z.object({ agentId: z.string().uuid() });

// ============================================================
// GOOGLE CALENDAR
// ============================================================

export const getGoogleCalendarStatusFn = createServerFn({ method: "GET" })
  .inputValidator((d) => accountIdInput.parse(d))
  .handler(async ({ data }) => {
    return getGoogleCalendarStatus(data.accountId);
  });

export const getGoogleAuthUrl = createServerFn({ method: "GET" })
  .inputValidator((d) => accountIdInput.parse(d))
  .handler(async ({ data }) => {
    const clientId = process.env.GOOGLE_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET;

    if (!clientId) {
      throw new Error(
        "GOOGLE_CLIENT_ID não configurado no servidor. Configure as variáveis de ambiente GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET e GOOGLE_REDIRECT_URI no Coolify.",
      );
    }
    if (!clientSecret) {
      throw new Error(
        "GOOGLE_CLIENT_SECRET não configurado no servidor.",
      );
    }

    const explicitRedirect = process.env.GOOGLE_REDIRECT_URI;
    const baseUrl = process.env.APP_BASE_URL;

    const redirectUri = explicitRedirect
      || (baseUrl ? `${baseUrl.replace(/\/$/, "")}/api/public/auth/google/callback` : null);

    if (!redirectUri) {
      throw new Error(
        "Nem GOOGLE_REDIRECT_URI nem APP_BASE_URL estão configurados no servidor.",
      );
    }

    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: [
        "https://www.googleapis.com/auth/calendar.events",
        "https://www.googleapis.com/auth/calendar.readonly",
        "https://www.googleapis.com/auth/userinfo.email",
      ].join(" "),
      access_type: "offline",
      prompt: "consent",
      state: data.accountId,
    });

    return { url: `https://accounts.google.com/o/oauth2/v2/auth?${params}` };
  });

export const disconnectGoogleCalendar = createServerFn({ method: "POST" })
  .inputValidator((d) => accountIdInput.parse(d))
  .handler(async ({ data }) => {
    const sb = getSelfhost();
    await sb
      .from("google_calendar_tokens")
      .update({ ativo: false })
      .eq("account_id", data.accountId);
    return { ok: true };
  });

/** Lista calendários disponíveis na conta Google conectada (writer ou owner). */
export const listGoogleCalendarsFn = createServerFn({ method: "GET" })
  .inputValidator((d) => accountIdInput.parse(d))
  .handler(async ({ data }) => {
    const calendars = await listAvailableCalendars(data.accountId);
    return { calendars };
  });

/** Salva qual calendário será usado pelo agente para agendar. */
export const selectGoogleCalendarFn = createServerFn({ method: "POST" })
  .inputValidator((d) =>
    accountIdInput
      .extend({
        calendarId: z.string().min(1).max(300),
        calendarName: z.string().max(300).optional(),
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    await selectGoogleCalendar(data.accountId, data.calendarId, data.calendarName);
    return { ok: true };
  });

/** Lista as agendas múltiplas configuradas (label + calendarId + descrição). */
export const getGoogleAgendasFn = createServerFn({ method: "GET" })
  .inputValidator((d) => accountIdInput.parse(d))
  .handler(async ({ data }) => {
    const agendas = await listAccountAgendas(data.accountId);
    return { agendas };
  });

/**
 * Salva a lista de agendas múltiplas. Vazio/1 item → agente usa agenda única.
 * 2+ → o agente recebe o parâmetro `agenda` e escolhe conforme o prompt.
 */
export const saveGoogleAgendasFn = createServerFn({ method: "POST" })
  .inputValidator((d) =>
    accountIdInput
      .extend({
        agendas: z
          .array(
            z.object({
              label: z.string().min(1).max(80),
              calendarId: z.string().min(1).max(300),
              descricao: z.string().max(500).optional(),
              duracaoMinutos: z.number().int().positive().max(1440).optional(),
              businessHoursJson: z.string().max(4000).optional(),
              umaPorDia: z.boolean().optional(),
              diasUmaPorDia: z.array(z.string().max(10)).max(7).optional(),
              granularidadeMinutos: z.number().int().positive().max(120).optional(),
              bufferMinutos: z.number().int().positive().max(720).optional(),
              bufferDias: z.array(z.string().max(10)).max(7).optional(),
              tituloTemplate: z.string().max(500).optional(),
              descricaoTemplate: z.string().max(2000).optional(),
            }),
          )
          .max(20),
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    await saveAccountAgendas(data.accountId, data.agendas);
    return { ok: true };
  });

// ============================================================
// CLINICORP
// ============================================================

export const getClinicorpConfig = createServerFn({ method: "GET" })
  .inputValidator((d) => accountIdInput.parse(d))
  .handler(async ({ data }) => {
    const sb = getSelfhost();
    const { data: cfg } = await sb
      .from("clinicorp_config")
      .select("subscriber_id, business_id, agenda_id, dentist_person_id, ativo, api_token_enc")
      .eq("account_id", data.accountId)
      .single();

    return {
      ativo: cfg?.ativo ?? false,
      subscriber_id: (cfg?.subscriber_id as string | null) ?? "",
      business_id: (cfg?.business_id as number | null) ?? null,
      code_link: (cfg?.agenda_id as string | number | null)
        ? String(cfg!.agenda_id)
        : "",
      profissional_ids: Array.isArray(cfg?.dentist_person_id)
        ? (cfg.dentist_person_id as unknown[]).map(Number)
        : [],
      token_configured: !!cfg?.api_token_enc,
    };
  });

export const saveClinicorpConfig = createServerFn({ method: "POST" })
  .inputValidator((d) =>
    accountIdInput
      .extend({
        api_token: z.string().optional(),
        subscriber_id: z.string().optional(),
        business_id: z.number().int().optional(),
        code_link: z.string().optional(),
        profissional_ids: z.array(z.number().int()).optional(), // dentist_person_id (jsonb)
        ativo: z.boolean().optional(),
      })
      .parse(d)
  )
  .handler(async ({ data }) => {
    const sb = getSelfhost();
    const { accountId, api_token, code_link, profissional_ids, ...rest } = data;

    const patch: Record<string, unknown> = { ...rest };
    if (code_link !== undefined) patch.agenda_id = code_link || null;
    // armazena como jsonb array ([] vira null — sem filtro de profissional)
    if (profissional_ids !== undefined) {
      patch.dentist_person_id = profissional_ids.length > 0 ? profissional_ids : null;
    }
    if (api_token) patch.api_token_enc = await encryptValue(api_token);

    await sb
      .from("clinicorp_config")
      .upsert({ account_id: accountId, ...patch }, { onConflict: "account_id" });

    return { ok: true };
  });

export const testClinicorpConnection = createServerFn({ method: "POST" })
  .inputValidator((d) => accountIdInput.parse(d))
  .handler(async ({ data }) => {
    const { listClinicorpSlots } = await import("@/lib/tools/clinicorp.server");
    const today = new Date().toISOString().slice(0, 10);
    const nextWeek = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
    try {
      await listClinicorpSlots(data.accountId, today, nextWeek);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });

export const listClinicorpProfessionalsFn = createServerFn({ method: "GET" })
  .inputValidator((d) => accountIdInput.parse(d))
  .handler(async ({ data }) => {
    const { listClinicorpProfessionals } = await import("@/lib/tools/clinicorp.server");
    try {
      const list = await listClinicorpProfessionals(data.accountId);
      return { ok: true, professionals: list };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e), professionals: [] };
    }
  });

// ============================================================
// CLINUP
// ============================================================

export const getClinupConfig = createServerFn({ method: "GET" })
  .inputValidator((d) => accountIdInput.parse(d))
  .handler(async ({ data }) => {
    const sb = getSelfhost();
    const { data: cfg } = await sb
      .from("clinup_config")
      .select("base_url, clinic_id, agenda_id, duracao_consulta, ativo, api_token_enc")
      .eq("account_id", data.accountId)
      .single();

    return {
      ativo: cfg?.ativo ?? false,
      base_url: (cfg?.base_url as string | null) ?? "",
      clinic_id: (cfg?.clinic_id as string | null) ?? "",
      agenda_id: (cfg?.agenda_id as string | null) ?? "",
      duracao_consulta: (cfg?.duracao_consulta as number | null) ?? 40,
      token_last4: cfg?.api_token_enc ? "****" : null,
    };
  });

export const saveClinupConfig = createServerFn({ method: "POST" })
  .inputValidator((d) =>
    accountIdInput
      .extend({
        api_token: z.string().optional(),
        base_url: z.string().url().optional(),
        clinic_id: z.string().optional(),
        agenda_id: z.string().optional(),
        duracao_consulta: z.number().int().min(5).max(480).optional(),
        ativo: z.boolean().optional(),
      })
      .parse(d)
  )
  .handler(async ({ data }) => {
    const sb = getSelfhost();
    const { accountId, api_token, ...rest } = data;

    const patch: Record<string, unknown> = { ...rest };
    if (api_token) {
      patch.api_token_enc = await encryptValue(api_token);
    }

    await sb
      .from("clinup_config")
      .upsert({ account_id: accountId, ...patch }, { onConflict: "account_id" });

    return { ok: true };
  });

export const testClinupConnection = createServerFn({ method: "POST" })
  .inputValidator((d) => accountIdInput.parse(d))
  .handler(async ({ data }) => {
    const { listClinupSlotsRange } = await import("@/lib/tools/clinup.server");
    const today = new Date().toISOString().slice(0, 10);
    const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
    try {
      await listClinupSlotsRange(data.accountId, today, tomorrow);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });

// ============================================================
// ESCALAÇÃO HUMANA
// ============================================================

// No painel do agente (embed) so expomos o TOGGLE ativo/desativo + leitura
// read-only do que o admin configurou. As credenciais Evolution sao globais
// (system_evolution_config) e a instancia/grupo do agente sao configurados
// pelo admin em /admin/account/$accountId.
export const getAgentEscalation = createServerFn({ method: "GET" })
  .inputValidator((d) => agentIdInput.parse(d))
  .handler(async ({ data }) => {
    const sb = getSelfhost();
    const { data: cfg } = await sb
      .from("agent_escalation")
      .select("evolution_instance, grupo_alerta, ativo")
      .eq("agent_id", data.agentId)
      .maybeSingle();

    // Saber se a Evolution global ja foi configurada pelo superadmin —
    // isso muda a copy do toggle no embed.
    const { data: sys } = await sb
      .from("system_evolution_config")
      .select("base_url, api_key_last4")
      .eq("id", 1)
      .maybeSingle();
    const system_configured = !!(sys?.base_url && sys?.api_key_last4);

    const instance = (cfg?.evolution_instance as string | null) ?? "";
    const grupo = (cfg?.grupo_alerta as string | null) ?? "";

    return {
      ativo: cfg?.ativo ?? false,
      evolution_instance: instance,
      grupo_alerta: grupo,
      system_configured,
      agent_bound: !!(instance && grupo),
    };
  });

export const saveAgentEscalation = createServerFn({ method: "POST" })
  .inputValidator((d) =>
    agentIdInput
      .extend({
        ativo: z.boolean(),
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    const sb = getSelfhost();
    const { agentId, ativo } = data;

    await sb
      .from("agent_escalation")
      .upsert(
        { agent_id: agentId, ativo, atualizado_em: new Date().toISOString() },
        { onConflict: "agent_id" },
      );

    return { ok: true };
  });

// ============================================================
// FOLLOW-UP
// ============================================================

export const getFollowupConfig = createServerFn({ method: "GET" })
  .inputValidator((d) => agentIdInput.parse(d))
  .handler(async ({ data }) => {
    const sb = getSelfhost();
    const { data: fu } = await sb
      .from("agent_followup")
      .select("ativo, max_tentativas, delay_horas, prompt_fu1, prompt_fu2")
      .eq("agent_id", data.agentId)
      .single();

    return {
      ativo: fu?.ativo ?? false,
      max_tentativas: (fu?.max_tentativas as number | null) ?? 2,
      delay_horas: (fu?.delay_horas as number[] | null) ?? [1, 5],
      prompt_fu1: (fu?.prompt_fu1 as string | null) ?? "",
      prompt_fu2: (fu?.prompt_fu2 as string | null) ?? "",
    };
  });

export const saveFollowupConfig = createServerFn({ method: "POST" })
  .inputValidator((d) =>
    agentIdInput
      .extend({
        ativo: z.boolean().optional(),
        max_tentativas: z.number().int().min(1).max(5).optional(),
        delay_horas: z.array(z.number()).max(5).optional(),
        prompt_fu1: z.string().max(2000).optional(),
        prompt_fu2: z.string().max(2000).optional(),
      })
      .parse(d)
  )
  .handler(async ({ data }) => {
    const sb = getSelfhost();
    const { agentId, ...patch } = data;
    await sb.from("agent_followup").update(patch).eq("agent_id", agentId);
    return { ok: true };
  });

// ============================================================
// WARM-UP
// ============================================================

export const getWarmupConfig = createServerFn({ method: "GET" })
  .inputValidator((d) => agentIdInput.parse(d))
  .handler(async ({ data }) => {
    const sb = getSelfhost();
    const { data: wuRaw } = await sb
      .from("agent_warmup")
      .select(
        "ativo, tempo_wu1_h, tempo_wu2_h, tempo_wu3_h, tempo_wu4_h, tempo_wu5_h, " +
        "prompt_wu1, prompt_wu2, prompt_wu3, prompt_wu4, prompt_wu5",
      )
      .eq("agent_id", data.agentId)
      .single();
    const wu = wuRaw as Record<string, unknown> | null;

    return {
      ativo: (wu?.ativo as boolean | undefined) ?? false,
      tempo_wu1_h: (wu?.tempo_wu1_h as number | null) ?? 96,
      tempo_wu2_h: (wu?.tempo_wu2_h as number | null) ?? 72,
      tempo_wu3_h: (wu?.tempo_wu3_h as number | null) ?? 48,
      tempo_wu4_h: (wu?.tempo_wu4_h as number | null) ?? 24,
      tempo_wu5_h: (wu?.tempo_wu5_h as number | null) ?? 2,
      prompt_wu1: (wu?.prompt_wu1 as string | null) ?? "",
      prompt_wu2: (wu?.prompt_wu2 as string | null) ?? "",
      prompt_wu3: (wu?.prompt_wu3 as string | null) ?? "",
      prompt_wu4: (wu?.prompt_wu4 as string | null) ?? "",
      prompt_wu5: (wu?.prompt_wu5 as string | null) ?? "",
    };
  });

export const saveWarmupConfig = createServerFn({ method: "POST" })
  .inputValidator((d) =>
    agentIdInput
      .extend({
        ativo: z.boolean().optional(),
        tempo_wu1_h: z.number().int().min(1).optional(),
        tempo_wu2_h: z.number().int().min(1).optional(),
        tempo_wu3_h: z.number().int().min(1).optional(),
        tempo_wu4_h: z.number().int().min(1).optional(),
        tempo_wu5_h: z.number().int().min(1).optional(),
        prompt_wu1: z.string().max(2000).optional(),
        prompt_wu2: z.string().max(2000).optional(),
        prompt_wu3: z.string().max(2000).optional(),
        prompt_wu4: z.string().max(2000).optional(),
        prompt_wu5: z.string().max(2000).optional(),
      })
      .parse(d)
  )
  .handler(async ({ data }) => {
    const sb = getSelfhost();
    const { agentId, ...patch } = data;
    await sb.from("agent_warmup").update(patch).eq("agent_id", agentId);
    return { ok: true };
  });

// ============================================================
// RESET AGENTE
// ============================================================

export const resetAgent = createServerFn({ method: "POST" })
  .inputValidator((d) => z.object({ agentId: z.string().uuid() }).parse(d))
  .handler(async ({ data }) => {
    const sb = getSelfhost();
    const { data: convs } = await sb
      .from("conversations")
      .select("id")
      .eq("agent_id", data.agentId);

    if (!convs?.length) return { ok: true, deleted: 0 };

    for (const c of convs) {
      await resetConversationHistory(c.id as string);
    }

    return { ok: true, deleted: convs.length };
  });

