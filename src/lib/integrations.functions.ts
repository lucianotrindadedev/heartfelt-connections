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
import {
  SHEETS_SCOPES,
  getGoogleSheetsStatus,
  invalidateSheetCache,
  listAccountSheets,
  listAvailableSpreadsheets,
  listSheetTabs,
  querySheet,
  saveAccountSheets,
} from "@/lib/tools/google-sheets.server";

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
              rotuloNotificacao: z.string().max(80).optional(),
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
// GOOGLE SHEETS
// ============================================================

export const getGoogleSheetsStatusFn = createServerFn({ method: "GET" })
  .inputValidator((d) => accountIdInput.parse(d))
  .handler(async ({ data }) => {
    return getGoogleSheetsStatus(data.accountId);
  });

/**
 * URL de consentimento do Google Sheets. Usa o MESMO app (client_id/secret) do
 * Google Calendar, mas com escopo de planilha e callback próprio — o token do
 * Calendar já emitido não ganha escopo novo, e uma conta pode querer só a
 * planilha (sem agenda Google).
 */
export const getGoogleSheetsAuthUrl = createServerFn({ method: "GET" })
  .inputValidator((d) => accountIdInput.parse(d))
  .handler(async ({ data }) => {
    const clientId = process.env.GOOGLE_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET;

    if (!clientId) {
      throw new Error(
        "GOOGLE_CLIENT_ID não configurado no servidor. Configure GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET e APP_BASE_URL no Coolify.",
      );
    }
    if (!clientSecret) {
      throw new Error("GOOGLE_CLIENT_SECRET não configurado no servidor.");
    }

    const baseUrl = process.env.APP_BASE_URL;
    const redirectUri =
      process.env.GOOGLE_SHEETS_REDIRECT_URI
      || (baseUrl
        ? `${baseUrl.replace(/\/$/, "")}/api/public/auth/google-sheets/callback`
        : null);

    if (!redirectUri) {
      throw new Error(
        "Nem GOOGLE_SHEETS_REDIRECT_URI nem APP_BASE_URL estão configurados no servidor.",
      );
    }

    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: SHEETS_SCOPES.join(" "),
      access_type: "offline",
      prompt: "consent",
      state: data.accountId,
    });

    return { url: `https://accounts.google.com/o/oauth2/v2/auth?${params}` };
  });

export const disconnectGoogleSheets = createServerFn({ method: "POST" })
  .inputValidator((d) => accountIdInput.parse(d))
  .handler(async ({ data }) => {
    const sb = getSelfhost();
    await sb
      .from("google_sheets_config")
      .update({ ativo: false })
      .eq("account_id", data.accountId);
    invalidateSheetCache(data.accountId);
    return { ok: true };
  });

/** Lista as planilhas da conta Google conectada (próprias + compartilhadas). */
export const listGoogleSpreadsheetsFn = createServerFn({ method: "GET" })
  .inputValidator((d) => accountIdInput.parse(d))
  .handler(async ({ data }) => {
    try {
      const spreadsheets = await listAvailableSpreadsheets(data.accountId);
      return { ok: true as const, spreadsheets };
    } catch (e) {
      // Token emitido antes do escopo do Drive → 403. O painel cai no campo
      // manual (colar link) em vez de ficar sem saída.
      return {
        ok: false as const,
        error: e instanceof Error ? e.message : String(e),
        spreadsheets: [],
      };
    }
  });

/** Lista as abas de uma planilha — valida o ID/URL colado antes de salvar. */
export const listGoogleSheetTabsFn = createServerFn({ method: "POST" })
  .inputValidator((d) =>
    accountIdInput.extend({ spreadsheetId: z.string().min(1).max(300) }).parse(d),
  )
  .handler(async ({ data }) => {
    try {
      const info = await listSheetTabs(data.accountId, data.spreadsheetId);
      return { ok: true as const, ...info };
    } catch (e) {
      return { ok: false as const, error: e instanceof Error ? e.message : String(e) };
    }
  });

/** Salva as planilhas consultáveis. Vazio = agente sem tool de planilha. */
export const saveGoogleSheetsFn = createServerFn({ method: "POST" })
  .inputValidator((d) =>
    accountIdInput
      .extend({
        planilhas: z
          .array(
            z.object({
              label: z.string().min(1).max(80),
              spreadsheetId: z.string().min(1).max(300),
              aba: z.string().max(200).optional(),
              descricao: z.string().max(500).optional(),
            }),
          )
          .max(10),
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    await saveAccountSheets(data.accountId, data.planilhas);
    return { ok: true };
  });

/**
 * Prévia da planilha no painel — mesma leitura que o agente faz.
 * Com `spreadsheetId`, testa a planilha AVULSA (antes de salvar); sem ele, usa
 * a lista já gravada e resolve pelo `label`.
 */
export const previewGoogleSheetFn = createServerFn({ method: "POST" })
  .inputValidator((d) =>
    accountIdInput
      .extend({
        label: z.string().max(80).optional(),
        busca: z.string().max(200).optional(),
        spreadsheetId: z.string().max(300).optional(),
        aba: z.string().max(200).optional(),
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    if (data.spreadsheetId?.trim()) {
      return querySheet(
        data.accountId,
        [
          {
            label: data.label?.trim() || "(teste)",
            spreadsheetId: data.spreadsheetId,
            aba: data.aba?.trim() || undefined,
          },
        ],
        { busca: data.busca },
      );
    }
    const planilhas = await listAccountSheets(data.accountId);
    return querySheet(data.accountId, planilhas, { label: data.label, busca: data.busca });
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
      .select("subscriber_id, business_id, agenda_id, dentist_person_id, category_id, category_description, category_color, uppercase_patient_name, ativo, api_token_enc")
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
      category_id: (cfg?.category_id as string | null) ?? "",
      category_description: (cfg?.category_description as string | null) ?? "",
      category_color: (cfg?.category_color as string | null) ?? "",
      uppercase_patient_name: cfg?.uppercase_patient_name === true,
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
        category_id: z.string().optional(),
        category_description: z.string().optional(),
        category_color: z.string().optional(),
        uppercase_patient_name: z.boolean().optional(),
        ativo: z.boolean().optional(),
      })
      .parse(d)
  )
  .handler(async ({ data }) => {
    const sb = getSelfhost();
    const {
      accountId,
      api_token,
      code_link,
      profissional_ids,
      category_id,
      category_description,
      category_color,
      ...rest
    } = data;

    const patch: Record<string, unknown> = { ...rest, atualizado_em: new Date().toISOString() };
    if (code_link !== undefined) patch.agenda_id = code_link || null;
    // armazena como jsonb array ([] vira null — sem filtro de profissional)
    if (profissional_ids !== undefined) {
      patch.dentist_person_id = profissional_ids.length > 0 ? profissional_ids : null;
    }
    // Categoria de agendamento (seleção única). String vazia = sem categoria (null).
    if (category_id !== undefined) patch.category_id = category_id || null;
    if (category_description !== undefined) patch.category_description = category_description || null;
    if (category_color !== undefined) patch.category_color = category_color || null;
    if (api_token) patch.api_token_enc = await encryptValue(api_token);

    // IMPORTANTE: checar o erro. Antes o upsert era "fire-and-forget" e uma
    // falha (constraint, RLS, etc.) retornava ok:true silenciosamente — o painel
    // mostrava "salvo" mas nada persistia ("continua inativo").
    const { error } = await sb
      .from("clinicorp_config")
      .upsert({ account_id: accountId, ...patch }, { onConflict: "account_id" });
    if (error) throw new Error(`Falha ao salvar Clinicorp: ${error.message}`);

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

export const listClinicorpCategoriesFn = createServerFn({ method: "GET" })
  .inputValidator((d) => accountIdInput.parse(d))
  .handler(async ({ data }) => {
    const { listClinicorpCategories } = await import("@/lib/tools/clinicorp.server");
    try {
      const list = await listClinicorpCategories(data.accountId);
      return { ok: true, categories: list };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e), categories: [] };
    }
  });

// ============================================================
// CLINIC EXPERTS
// ============================================================
//
// A API do Clinic Experts (GET /professionals) não expõe o expediente de cada
// profissional — por isso a config guarda isso nós mesmos, um item por
// profissional selecionado, no mesmo espírito do array `agendas` do Google
// Calendar (ver getGoogleAgendasFn/saveGoogleAgendasFn acima).

const clinicExpertsProfessionalSchema = z.object({
  uuid: z.string().min(1),
  name: z.string().min(1).max(200),
  duracao_minutos: z.number().int().positive().max(1440).optional(),
  business_hours_json: z.string().max(4000).optional(),
});

export const getClinicExpertsConfig = createServerFn({ method: "GET" })
  .inputValidator((d) => accountIdInput.parse(d))
  .handler(async ({ data }) => {
    const sb = getSelfhost();
    const { data: cfg } = await sb
      .from("clinic_experts_config")
      .select("procedure_id, procedure_name, duracao_consulta, professionals, ativo, api_token_enc")
      .eq("account_id", data.accountId)
      .single();

    return {
      ativo: cfg?.ativo ?? false,
      procedure_id: (cfg?.procedure_id as number | null) ?? null,
      procedure_name: (cfg?.procedure_name as string | null) ?? "",
      duracao_consulta: (cfg?.duracao_consulta as number | null) ?? 40,
      professionals: Array.isArray(cfg?.professionals)
        ? (cfg.professionals as Record<string, unknown>[]).map((p) => ({
            uuid: String(p.uuid ?? ""),
            name: String(p.name ?? ""),
            duracao_minutos: typeof p.duracao_minutos === "number" ? p.duracao_minutos : undefined,
            business_hours_json:
              typeof p.business_hours_json === "string" ? p.business_hours_json : "",
          }))
        : [],
      token_configured: !!cfg?.api_token_enc,
    };
  });

export const saveClinicExpertsConfig = createServerFn({ method: "POST" })
  .inputValidator((d) =>
    accountIdInput
      .extend({
        api_token: z.string().optional(),
        procedure_id: z.number().int().optional(),
        procedure_name: z.string().optional(),
        duracao_consulta: z.number().int().positive().max(1440).optional(),
        professionals: z.array(clinicExpertsProfessionalSchema).optional(),
        ativo: z.boolean().optional(),
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    const sb = getSelfhost();
    const { accountId, api_token, procedure_id, procedure_name, professionals, ...rest } = data;

    const patch: Record<string, unknown> = { ...rest, atualizado_em: new Date().toISOString() };
    if (procedure_id !== undefined) patch.procedure_id = procedure_id || null;
    if (procedure_name !== undefined) patch.procedure_name = procedure_name || null;
    if (professionals !== undefined) patch.professionals = professionals;
    if (api_token) patch.api_token_enc = await encryptValue(api_token);

    const { error } = await sb
      .from("clinic_experts_config")
      .upsert({ account_id: accountId, ...patch }, { onConflict: "account_id" });
    if (error) throw new Error(`Falha ao salvar Clinic Experts: ${error.message}`);

    return { ok: true };
  });

export const testClinicExpertsConnection = createServerFn({ method: "POST" })
  .inputValidator((d) => accountIdInput.parse(d))
  .handler(async ({ data }) => {
    const { listClinicExpertsProfessionals } = await import("@/lib/tools/clinic-experts.server");
    try {
      await listClinicExpertsProfessionals(data.accountId);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });

export const listClinicExpertsProfessionalsFn = createServerFn({ method: "GET" })
  .inputValidator((d) => accountIdInput.parse(d))
  .handler(async ({ data }) => {
    const { listClinicExpertsProfessionals } = await import("@/lib/tools/clinic-experts.server");
    try {
      const list = await listClinicExpertsProfessionals(data.accountId);
      return { ok: true, professionals: list };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e), professionals: [] };
    }
  });

export const listClinicExpertsProceduresFn = createServerFn({ method: "GET" })
  .inputValidator((d) => accountIdInput.parse(d))
  .handler(async ({ data }) => {
    const { listClinicExpertsProcedures } = await import("@/lib/tools/clinic-experts.server");
    try {
      const list = await listClinicExpertsProcedures(data.accountId);
      return { ok: true, procedures: list };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e), procedures: [] };
    }
  });

// ============================================================
// CLINUP
// ============================================================

// Mesmo esquema do Clinic Experts, com UMA diferença: o identificador do
// profissional no Clinup é um INTEIRO (id), não um uuid. Guardado como string
// porque é o que trafega no formulário; o adapter converte na hora de agendar.
const clinupProfessionalSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).max(200),
  duracao_minutos: z.number().int().positive().max(1440).optional(),
  business_hours_json: z.string().max(4000).optional(),
});

export const getClinupConfig = createServerFn({ method: "GET" })
  .inputValidator((d) => accountIdInput.parse(d))
  .handler(async ({ data }) => {
    const sb = getSelfhost();
    const { data: cfg } = await sb
      .from("clinup_config")
      .select("base_url, clinic_id, agenda_id, duracao_consulta, professionals, ativo, api_token_enc")
      .eq("account_id", data.accountId)
      .single();

    return {
      ativo: cfg?.ativo ?? false,
      base_url: (cfg?.base_url as string | null) ?? "",
      clinic_id: (cfg?.clinic_id as string | null) ?? "",
      agenda_id: (cfg?.agenda_id as string | null) ?? "",
      duracao_consulta: (cfg?.duracao_consulta as number | null) ?? 40,
      professionals: Array.isArray(cfg?.professionals)
        ? (cfg.professionals as Record<string, unknown>[]).map((p) => ({
            id: String(p.id ?? ""),
            name: String(p.name ?? ""),
            duracao_minutos: typeof p.duracao_minutos === "number" ? p.duracao_minutos : undefined,
            business_hours_json:
              typeof p.business_hours_json === "string" ? p.business_hours_json : "",
          }))
        : [],
      token_configured: !!cfg?.api_token_enc,
      token_last4: cfg?.api_token_enc ? "****" : null,
    };
  });

export const listClinupProfessionalsFn = createServerFn({ method: "GET" })
  .inputValidator((d) => accountIdInput.parse(d))
  .handler(async ({ data }) => {
    const { listClinupProfessionals } = await import("@/lib/tools/clinup.server");
    try {
      const list = await listClinupProfessionals(data.accountId);
      return { ok: true, professionals: list };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e), professionals: [] };
    }
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
        professionals: z.array(clinupProfessionalSchema).optional(),
        ativo: z.boolean().optional(),
      })
      .parse(d)
  )
  .handler(async ({ data }) => {
    const sb = getSelfhost();
    const { accountId, api_token, professionals, ...rest } = data;

    const patch: Record<string, unknown> = { ...rest };
    if (professionals !== undefined) patch.professionals = professionals;
    if (api_token) {
      patch.api_token_enc = await encryptValue(api_token);
    }

    const { error } = await sb
      .from("clinup_config")
      .upsert({ account_id: accountId, ...patch }, { onConflict: "account_id" });
    if (error) throw new Error(`Falha ao salvar Clinup: ${error.message}`);

    return { ok: true };
  });

export const testClinupConnection = createServerFn({ method: "POST" })
  .inputValidator((d) => accountIdInput.parse(d))
  .handler(async ({ data }) => {
    // Valida a CREDENCIAL (chamada mais barata que exige auth real), igual ao
    // "testar conexão" do Clinic Experts. Antes isto chamava a busca de
    // horários, que engolia toda exceção e devolvia [] — o painel dizia
    // "Conexão OK" com a integração completamente quebrada.
    const { listClinupProfessionals } = await import("@/lib/tools/clinup.server");
    try {
      const profs = await listClinupProfessionals(data.accountId);
      return { ok: true, professionals: profs.length };
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

