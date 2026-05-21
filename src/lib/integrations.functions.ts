import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { getSelfhost } from "@/integrations/selfhost/client.server";
import { encryptValue } from "@/lib/crypto.server";
import { getGoogleCalendarStatus } from "@/lib/tools/google-calendar.server";

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
    const redirectUri =
      process.env.GOOGLE_REDIRECT_URI ?? `${process.env.APP_BASE_URL ?? ""}/api/public/auth/google/callback`;

    if (!clientId) throw new Error("GOOGLE_CLIENT_ID não configurado");

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

export const getAgentEscalation = createServerFn({ method: "GET" })
  .inputValidator((d) => agentIdInput.parse(d))
  .handler(async ({ data }) => {
    const sb = getSelfhost();
    const { data: cfg } = await sb
      .from("agent_escalation")
      .select("grupo_alerta, evolution_url, evolution_instance, ativo, evolution_key_enc")
      .eq("agent_id", data.agentId)
      .single();

    return {
      ativo: cfg?.ativo ?? false,
      grupo_alerta: (cfg?.grupo_alerta as string | null) ?? "",
      evolution_url: (cfg?.evolution_url as string | null) ?? "",
      evolution_instance: (cfg?.evolution_instance as string | null) ?? "",
      key_last4: cfg?.evolution_key_enc ? "****" : null,
    };
  });

export const saveAgentEscalation = createServerFn({ method: "POST" })
  .inputValidator((d) =>
    agentIdInput
      .extend({
        evolution_key: z.string().optional(),
        grupo_alerta: z.string().optional(),
        evolution_url: z.string().optional(),
        evolution_instance: z.string().optional(),
        ativo: z.boolean().optional(),
      })
      .parse(d)
  )
  .handler(async ({ data }) => {
    const sb = getSelfhost();
    const { agentId, evolution_key, ...rest } = data;

    const patch: Record<string, unknown> = { ...rest };
    if (evolution_key) {
      patch.evolution_key_enc = await encryptValue(evolution_key);
    }

    await sb
      .from("agent_escalation")
      .upsert({ agent_id: agentId, ...patch }, { onConflict: "agent_id" });

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

    // Busca todas as conversas do agente
    const { data: convs } = await sb
      .from("conversations")
      .select("id")
      .eq("agent_id", data.agentId);

    if (!convs?.length) return { ok: true, deleted: 0 };

    const ids = convs.map((c: { id: unknown }) => c.id as string);

    // Remove mensagens e estados
    await Promise.all([
      sb.from("messages").delete().in("conversation_id", ids),
      sb.from("conversation_state").delete().in("conversation_id", ids),
      sb.from("message_queue").delete().in("conversation_id", ids),
    ]);

    return { ok: true, deleted: ids.length };
  });

