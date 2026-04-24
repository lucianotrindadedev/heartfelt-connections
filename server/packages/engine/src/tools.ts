// ---------------------------------------------------------------------------
// Tool framework – registry + built-in tool implementations
// Matches EXACT tools from n8n workflows (01-08)
// ---------------------------------------------------------------------------

import type { LlmToolDef } from "@sarai/shared";
import type { HelenaClient } from "@sarai/shared";
import { logger, getValidGoogleToken, db, integrations, env } from "@sarai/shared";
import { eq, and, sql } from "drizzle-orm";

// ---------------------------------------------------------------------------
// ToolContext – passed by the worker for every tool invocation
// ---------------------------------------------------------------------------
export interface ToolContext {
  agentConfig: any; // Agent config with integrations
  conversation: any; // Conversation record with helenaSessionId, helenaContactId
  phone: string;
  helena: HelenaClient; // Initialized Helena client
  contactInfo: any; // Helena contact info (includes tagNames, utm, etc.)
}

type ToolHandler = (
  args: Record<string, any>,
  ctx: ToolContext,
) => Promise<any>;

const TOOL_REGISTRY: Record<
  string,
  { definition: LlmToolDef; handler: ToolHandler }
> = {};

function registerTool(
  name: string,
  description: string,
  parameters: Record<string, unknown>,
  handler: ToolHandler,
) {
  TOOL_REGISTRY[name] = {
    definition: {
      type: "function",
      function: { name, description, parameters },
    },
    handler,
  };
}

// ---------------------------------------------------------------------------
// Clinicorp helper – centralised HTTP calls with Basic auth
// ---------------------------------------------------------------------------

interface ClinicorpConfig {
  api_token: string; // base64-encoded credentials
  subscriber_id: string; // e.g. "magnum"
  business_id: string; // e.g. "5576666615382016"
  code_link: string; // e.g. "43855"
  agenda_id: string; // e.g. "5652391183777792"
}

function getClinicorpConfig(ctx: ToolContext): ClinicorpConfig | null {
  return ctx.agentConfig.integrations?.clinicorp ?? null;
}

async function clinicorpRequest(
  method: string,
  path: string,
  config: ClinicorpConfig,
  queryParams?: Record<string, string>,
  body?: any,
): Promise<any> {
  const url = new URL(`https://api.clinicorp.com${path}`);
  if (queryParams) {
    for (const [k, v] of Object.entries(queryParams)) {
      if (v != null && v !== "") url.searchParams.set(k, v);
    }
  }

  const res = await fetch(url.toString(), {
    method,
    headers: {
      Authorization: `Basic ${config.api_token}`,
      accept: "application/json",
      "Content-Type": "application/json",
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Clinicorp ${res.status}: ${text}`);
  }
  return res.json();
}

// ---------------------------------------------------------------------------
// ClinicExpress helper – centralised HTTP calls with Bearer auth
// ---------------------------------------------------------------------------

async function clinicExpressRequest(
  method: string,
  path: string,
  token: string,
  body?: any,
  queryParams?: Record<string, string>,
): Promise<any> {
  const url = new URL(`https://api.clinicaexperts.com.br/api/v1${path}`);
  if (queryParams) {
    for (const [k, v] of Object.entries(queryParams)) {
      if (v) url.searchParams.set(k, v);
    }
  }
  const res = await fetch(url.toString(), {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      accept: "application/json",
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!res.ok) throw new Error(`ClinicExpress ${res.status}: ${await res.text().catch(() => "")}`);
  return res.json();
}

// ---------------------------------------------------------------------------
// Clinup helper – centralised HTTP calls with plain token auth
// ---------------------------------------------------------------------------

async function clinupRequest(
  method: string,
  path: string,
  apiToken: string,
  body?: any,
  queryParams?: Record<string, string>,
): Promise<any> {
  const url = new URL(`https://app.sistemaclinup.com.br/api/open${path}`);
  if (queryParams) {
    for (const [k, v] of Object.entries(queryParams)) {
      if (v) url.searchParams.set(k, v);
    }
  }
  const res = await fetch(url.toString(), {
    method,
    headers: {
      Authorization: apiToken,
      "Content-Type": "application/json",
      accept: "application/json",
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!res.ok) throw new Error(`Clinup ${res.status}: ${await res.text().catch(() => "")}`);
  return res.json();
}

// ---------------------------------------------------------------------------
// Google Calendar helper – centralised HTTP calls with Bearer auth
// ---------------------------------------------------------------------------

/**
 * Get a valid Google access token, auto-refreshing if expired.
 * Updates the encrypted config in DB when refreshed.
 */
async function getGoogleAccessToken(gcConfig: any, accountId: string): Promise<string> {
  if (!gcConfig?.access_token || !gcConfig?.refresh_token) {
    throw new Error("Google Calendar não configurado (tokens ausentes)");
  }

  const result = await getValidGoogleToken({
    access_token: gcConfig.access_token,
    refresh_token: gcConfig.refresh_token,
    expires_at: gcConfig.expires_at || 0,
  });

  // If token was refreshed, update it in DB
  if (result.refreshed && result.newConfig) {
    const updatedConfig = { ...gcConfig, ...result.newConfig };
    const configJson = JSON.stringify(updatedConfig);
    try {
      await db.execute(
        sql`UPDATE integrations 
            SET config_enc = pgp_sym_encrypt(${configJson}::text, ${env.PGCRYPTO_KEY}),
                updated_at = now()
            WHERE account_id = ${accountId} AND type = 'google_calendar'`
      );
    } catch (e) {
      logger.warn({ err: (e as Error).message }, "failed to persist refreshed google token");
    }
  }

  return result.access_token;
}

async function googleCalendarRequest(
  method: string,
  path: string,
  accessToken: string,
  body?: any,
  queryParams?: Record<string, string>,
): Promise<any> {
  const url = new URL(`https://www.googleapis.com/calendar/v3${path}`);
  if (queryParams) {
    for (const [k, v] of Object.entries(queryParams)) {
      if (v) url.searchParams.set(k, v);
    }
  }
  const res = await fetch(url.toString(), {
    method,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!res.ok) throw new Error(`Google Calendar ${res.status}: ${await res.text().catch(() => "")}`);
  if (method === "DELETE") return { ok: true };
  return res.json();
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. refletir – internal reasoning (not sent to client)
// ═══════════════════════════════════════════════════════════════════════════

registerTool(
  "refletir",
  "Use para pensar internamente sobre a situação antes de responder. O conteúdo NÃO é enviado ao cliente.",
  {
    type: "object",
    properties: {
      pensamento: {
        type: "string",
        description: "Seu raciocínio interno",
      },
    },
    required: ["pensamento"],
  },
  async (_args) => {
    return { noted: true };
  },
);

// ═══════════════════════════════════════════════════════════════════════════
// 2. listar_tags – list all tags from Helena CRM
// ═══════════════════════════════════════════════════════════════════════════

registerTool(
  "listar_tags",
  "Lista todas as tags disponíveis no CRM Helena. SEMPRE chame listar_tags ANTES de add_tags para verificar as tags existentes.",
  {
    type: "object",
    properties: {},
  },
  async (_args, ctx) => {
    try {
      const result = await ctx.helena.listTags();
      return result;
    } catch (e: any) {
      return { error: e.message };
    }
  },
);

// ═══════════════════════════════════════════════════════════════════════════
// 3. add_tags – add tags to current contact via Helena CRM
// ═══════════════════════════════════════════════════════════════════════════

const BLOCKED_TAGS = ["N/A Não Agendado", "IA Agendou", "CRC Agendou"];

registerTool(
  "add_tags",
  'Adiciona tags ao contato atual no CRM Helena. IMPORTANTE: NÃO pode adicionar as tags: "N/A Não Agendado", "IA Agendou", "CRC Agendou". Sempre chame listar_tags antes para verificar as tags disponíveis.',
  {
    type: "object",
    properties: {
      tagNames: {
        type: "array",
        items: { type: "string" },
        description: "Lista de nomes de tags para adicionar ao contato",
      },
    },
    required: ["tagNames"],
  },
  async (args, ctx) => {
    const contactId = ctx.conversation.helenaContactId;
    if (!contactId) return { error: "Contato Helena não encontrado na conversa" };

    const tagNames: string[] = args.tagNames || [];
    const blocked = tagNames.filter((t) => BLOCKED_TAGS.includes(t));
    if (blocked.length > 0) {
      return { error: `Tags bloqueadas (não podem ser adicionadas pela IA): ${blocked.join(", ")}` };
    }

    try {
      const result = await ctx.helena.addTags(contactId, tagNames);
      return { success: true, result };
    } catch (e: any) {
      return { error: e.message };
    }
  },
);

// ═══════════════════════════════════════════════════════════════════════════
// 4. buscar_paciente – search patient in Clinicorp by phone
// ═══════════════════════════════════════════════════════════════════════════

registerTool(
  "buscar_paciente",
  "Busca paciente no Clinicorp pelo telefone.",
  {
    type: "object",
    properties: {
      telefone: {
        type: "string",
        description: "Telefone do paciente (opcional, usa o da conversa se não informado)",
      },
    },
  },
  async (args, ctx) => {
    const config = getClinicorpConfig(ctx);
    if (!config) return { error: "Clinicorp não configurado" };

    const phone = args.telefone || ctx.phone;
    try {
      return await clinicorpRequest("GET", "/rest/v1/patient/get", config, {
        subscriber_id: config.subscriber_id,
        Phone: phone,
      });
    } catch (e: any) {
      return { error: e.message };
    }
  },
);

// ═══════════════════════════════════════════════════════════════════════════
// 5. criar_paciente – create patient in Clinicorp
// ═══════════════════════════════════════════════════════════════════════════

registerTool(
  "criar_paciente",
  "Cria um novo paciente no Clinicorp.",
  {
    type: "object",
    properties: {
      nome: {
        type: "string",
        description: "Nome completo do paciente",
      },
      telefone: {
        type: "string",
        description: "Telefone do paciente (opcional, usa o da conversa se não informado)",
      },
    },
    required: ["nome"],
  },
  async (args, ctx) => {
    const config = getClinicorpConfig(ctx);
    if (!config) return { error: "Clinicorp não configurado" };

    const phone = args.telefone || ctx.phone;
    try {
      return await clinicorpRequest(
        "POST",
        "/rest/v1/patient/create",
        config,
        undefined,
        {
          subscriber_id: config.subscriber_id,
          Name: args.nome,
          MobilePhone: phone,
          IgnoreSameName: "X",
        },
      );
    } catch (e: any) {
      return { error: e.message };
    }
  },
);

// ═══════════════════════════════════════════════════════════════════════════
// 6. buscar_horarios – search available appointment slots in Clinicorp
// ═══════════════════════════════════════════════════════════════════════════

registerTool(
  "buscar_horarios",
  "Busca horários disponíveis para agendamento no Clinicorp.",
  {
    type: "object",
    properties: {
      data: {
        type: "string",
        description: "Data para buscar horários (formato YYYY-MM-DD)",
      },
    },
    required: ["data"],
  },
  async (args, ctx) => {
    const config = getClinicorpConfig(ctx);
    if (!config) return { error: "Clinicorp não configurado" };

    try {
      return await clinicorpRequest(
        "GET",
        "/rest/v1/appointment/get_avaliable_times_calendar",
        config,
        {
          subscriber_id: config.subscriber_id,
          date: args.data,
          code_link: config.code_link,
        },
      );
    } catch (e: any) {
      return { error: e.message };
    }
  },
);

// ═══════════════════════════════════════════════════════════════════════════
// 7. criar_agendamento – create appointment in Clinicorp
// ═══════════════════════════════════════════════════════════════════════════

registerTool(
  "criar_agendamento",
  "Cria um novo agendamento/consulta no Clinicorp.",
  {
    type: "object",
    properties: {
      patient_id: {
        type: "string",
        description: "ID do paciente no Clinicorp (Patient_PersonId)",
      },
      from_time: {
        type: "string",
        description: "Horário de início (ex: 08:00)",
      },
      to_time: {
        type: "string",
        description: "Horário de término (ex: 09:00)",
      },
      data: {
        type: "string",
        description: "Data do agendamento (formato YYYY-MM-DD)",
      },
      dentist_id: {
        type: "string",
        description: "ID do dentista (opcional, usa agenda padrão se não informado)",
      },
    },
    required: ["patient_id", "from_time", "to_time", "data"],
  },
  async (args, ctx) => {
    const config = getClinicorpConfig(ctx);
    if (!config) return { error: "Clinicorp não configurado" };

    try {
      return await clinicorpRequest(
        "POST",
        "/rest/v1/appointment/create_appointment_by_api",
        config,
        undefined,
        {
          subscriber_id: config.subscriber_id,
          Patient_PersonId: args.patient_id,
          fromTime: args.from_time,
          toTime: args.to_time,
          date: args.data,
          Clinic_BusinessId: config.business_id,
          Dentist_PersonId: args.dentist_id || config.agenda_id,
        },
      );
    } catch (e: any) {
      return { error: e.message };
    }
  },
);

// ═══════════════════════════════════════════════════════════════════════════
// 8. buscar_agendamentos – list appointments from Clinicorp
// ═══════════════════════════════════════════════════════════════════════════

registerTool(
  "buscar_agendamentos",
  "Lista agendamentos/consultas no Clinicorp.",
  {
    type: "object",
    properties: {
      data_inicio: {
        type: "string",
        description: "Data início (formato YYYY-MM-DD, padrão: hoje)",
      },
      data_fim: {
        type: "string",
        description: "Data fim (formato YYYY-MM-DD, padrão: 30 dias à frente)",
      },
      patient_id: {
        type: "string",
        description: "ID do paciente no Clinicorp (opcional)",
      },
    },
  },
  async (args, ctx) => {
    const config = getClinicorpConfig(ctx);
    if (!config) return { error: "Clinicorp não configurado" };

    const from =
      args.data_inicio || new Date().toISOString().slice(0, 10);
    const to =
      args.data_fim ||
      new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);

    try {
      const params: Record<string, string> = {
        subscriber_id: config.subscriber_id,
        from,
        to,
        businessId: config.business_id,
      };
      if (args.patient_id) {
        params.patientId = args.patient_id;
      }
      return await clinicorpRequest(
        "GET",
        "/rest/v1/appointment/list",
        config,
        params,
      );
    } catch (e: any) {
      return { error: e.message };
    }
  },
);

// ═══════════════════════════════════════════════════════════════════════════
// 9. cancelar_agendamento – cancel appointment in Clinicorp
// ═══════════════════════════════════════════════════════════════════════════

registerTool(
  "cancelar_agendamento",
  "Cancela um agendamento existente no Clinicorp.",
  {
    type: "object",
    properties: {
      agendamento_id: {
        type: "string",
        description: "ID do agendamento a cancelar",
      },
    },
    required: ["agendamento_id"],
  },
  async (args, ctx) => {
    const config = getClinicorpConfig(ctx);
    if (!config) return { error: "Clinicorp não configurado" };

    try {
      return await clinicorpRequest(
        "POST",
        "/rest/v1/appointment/cancel_appointment",
        config,
        undefined,
        {
          subscriber_id: config.subscriber_id,
          id: args.agendamento_id,
        },
      );
    } catch (e: any) {
      return { error: e.message };
    }
  },
);

// ═══════════════════════════════════════════════════════════════════════════
// 10. buscar_status – list appointment statuses from Clinicorp
// ═══════════════════════════════════════════════════════════════════════════

registerTool(
  "buscar_status",
  "Lista os status de agendamento disponíveis no Clinicorp.",
  {
    type: "object",
    properties: {},
  },
  async (_args, ctx) => {
    const config = getClinicorpConfig(ctx);
    if (!config) return { error: "Clinicorp não configurado" };

    try {
      return await clinicorpRequest(
        "GET",
        "/rest/v1/appointment/status_list",
        config,
        { subscriber_id: config.subscriber_id },
      );
    } catch (e: any) {
      return { error: e.message };
    }
  },
);

// ═══════════════════════════════════════════════════════════════════════════
// 11. alterar_status – change appointment status in Clinicorp
// ═══════════════════════════════════════════════════════════════════════════

registerTool(
  "alterar_status",
  "Altera o status de um agendamento no Clinicorp.",
  {
    type: "object",
    properties: {
      agendamento_id: {
        type: "string",
        description: "ID do agendamento",
      },
      status_id: {
        type: "string",
        description: "ID do novo status (obtenha com buscar_status)",
      },
    },
    required: ["agendamento_id", "status_id"],
  },
  async (args, ctx) => {
    const config = getClinicorpConfig(ctx);
    if (!config) return { error: "Clinicorp não configurado" };

    try {
      return await clinicorpRequest(
        "GET",
        "/rest/v1/appointment/change_status",
        config,
        {
          subscriber_id: config.subscriber_id,
          id: args.agendamento_id,
          status_id: args.status_id,
        },
      );
    } catch (e: any) {
      return { error: e.message };
    }
  },
);

// ═══════════════════════════════════════════════════════════════════════════
// 12. escalar_humano – escalate to human agent (Workflow 05)
// ═══════════════════════════════════════════════════════════════════════════

registerTool(
  "escalar_humano",
  "Escala a conversa para um atendente humano. Adiciona a tag 'IA Desligada' e trava a conversa.",
  {
    type: "object",
    properties: {
      motivo: {
        type: "string",
        description: "Motivo da escalação para humano",
      },
      resumo_conversa: {
        type: "string",
        description: "Resumo breve da conversa até o momento",
      },
    },
    required: ["motivo"],
  },
  async (args, ctx) => {
    const { db, conversationState } = await import("@sarai/shared");
    const { eq } = await import("drizzle-orm");

    // Step 1: Add "IA Desligada" tag to contact via Helena
    const contactId = ctx.conversation.helenaContactId;
    if (contactId) {
      try {
        await ctx.helena.addTags(contactId, ["IA Desligada"]);
      } catch (e: any) {
        logger.warn({ err: e.message }, "Failed to add 'IA Desligada' tag");
      }
    }

    // Step 2: Lock the conversation
    await db
      .update(conversationState)
      .set({
        lockConversa: true,
        updatedAt: new Date(),
      })
      .where(eq(conversationState.conversationId, ctx.conversation.id));

    // Step 3: Send alert to WhatsApp group via Evolution API (if configured)
    const evoConfig = ctx.agentConfig.integrations?.evolution_api;
    const alertGroupJid = ctx.agentConfig.integrations?.alert_group_jid;
    if (evoConfig && alertGroupJid) {
      try {
        const { EvolutionClient } = await import("@sarai/shared");
        const evo = new EvolutionClient({
          baseUrl: evoConfig.base_url,
          apiKey: evoConfig.api_key,
          instanceName: evoConfig.instance_name,
        });
        const alertText = [
          `🚨 *Escalação para Humano*`,
          `📞 Telefone: ${ctx.phone}`,
          `📋 Motivo: ${args.motivo}`,
          args.resumo_conversa
            ? `💬 Resumo: ${args.resumo_conversa}`
            : "",
        ]
          .filter(Boolean)
          .join("\n");
        await evo.sendGroupAlert(alertGroupJid, alertText);
      } catch (e: any) {
        logger.warn({ err: e.message }, "Failed to send escalation alert to group");
      }
    }

    // Step 4: Optionally transfer in Leads360 / Central360 (if configured)
    const central360Config = ctx.agentConfig.integrations?.central360;
    if (central360Config) {
      try {
        await fetch(`${central360Config.base_url}/transfer`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${central360Config.token}`,
          },
          body: JSON.stringify({
            sessionId: ctx.conversation.helenaSessionId,
            contactId,
            reason: args.motivo,
          }),
        });
      } catch (e: any) {
        logger.warn({ err: e.message }, "Failed to transfer in Central360");
      }
    }

    return {
      success: true,
      message: "Conversa escalada para atendimento humano.",
      lockConversa: true,
    };
  },
);

// ═══════════════════════════════════════════════════════════════════════════
// 13. listar_arquivos – list media assets from the database
// ═══════════════════════════════════════════════════════════════════════════

registerTool(
  "listar_arquivos",
  "Lista os arquivos de mídia disponíveis para envio ao cliente.",
  {
    type: "object",
    properties: {},
  },
  async (_args, ctx) => {
    try {
      const { db, mediaAssets } = await import("@sarai/shared");
      const { eq } = await import("drizzle-orm");

      const assets = await db
        .select()
        .from(mediaAssets)
        .where(eq(mediaAssets.agentId, ctx.agentConfig.id));

      return assets.map((a) => ({
        id: a.id,
        name: a.name,
        description: a.description,
        source: a.source,
        mimeType: a.mimeType,
      }));
    } catch (e: any) {
      return { error: e.message };
    }
  },
);

// ═══════════════════════════════════════════════════════════════════════════
// 14. enviar_arquivo – send a file to client via Helena CRM
// ═══════════════════════════════════════════════════════════════════════════

registerTool(
  "enviar_arquivo",
  "Envia um arquivo/mídia para o cliente via Helena CRM.",
  {
    type: "object",
    properties: {
      file_id: {
        type: "string",
        description: "ID do arquivo da lista de media_assets (use listar_arquivos para obter)",
      },
      url: {
        type: "string",
        description: "URL direta do arquivo para enviar (alternativa ao file_id)",
      },
      texto: {
        type: "string",
        description: "Legenda/texto a enviar junto com o arquivo",
      },
    },
  },
  async (args, ctx) => {
    const sessionId = ctx.conversation.helenaSessionId;
    if (!sessionId) return { error: "Sessão Helena não encontrada na conversa" };

    let fileUrl = args.url;

    // If file_id provided, look up the URL from media_assets
    if (!fileUrl && args.file_id) {
      try {
        const { db, mediaAssets } = await import("@sarai/shared");
        const { eq } = await import("drizzle-orm");

        const [asset] = await db
          .select()
          .from(mediaAssets)
          .where(eq(mediaAssets.id, args.file_id))
          .limit(1);

        if (!asset) return { error: `Arquivo com ID '${args.file_id}' não encontrado` };
        fileUrl = asset.source;
      } catch (e: any) {
        return { error: e.message };
      }
    }

    if (!fileUrl) return { error: "Forneça file_id ou url do arquivo" };

    try {
      const result = await ctx.helena.sendFile(sessionId, fileUrl, args.texto || "");
      return { success: true, messageId: result.id };
    } catch (e: any) {
      return { error: e.message };
    }
  },
);

// ═══════════════════════════════════════════════════════════════════════════
// 15. ce_buscar_paciente – search patient in ClinicExpress by phone
// ═══════════════════════════════════════════════════════════════════════════

registerTool(
  "ce_buscar_paciente",
  "Busca paciente no ClinicExpress pelo telefone.",
  {
    type: "object",
    properties: {
      telefone: {
        type: "string",
        description: "Telefone do paciente (opcional, usa o da conversa se não informado)",
      },
    },
  },
  async (args, ctx) => {
    const token = ctx.agentConfig.integrations?.clinicexpress?.token;
    if (!token) return { error: "ClinicExpress não configurado" };

    const phone = args.telefone || ctx.phone;
    try {
      return await clinicExpressRequest("GET", "/patients", token, { phone });
    } catch (e: any) {
      return { error: e.message };
    }
  },
);

// ═══════════════════════════════════════════════════════════════════════════
// 16. ce_criar_paciente – create patient in ClinicExpress
// ═══════════════════════════════════════════════════════════════════════════

registerTool(
  "ce_criar_paciente",
  "Cria um novo paciente no ClinicExpress.",
  {
    type: "object",
    properties: {
      nome: {
        type: "string",
        description: "Nome completo do paciente",
      },
      telefone: {
        type: "string",
        description: "Telefone do paciente (opcional, usa o da conversa se não informado)",
      },
    },
    required: ["nome"],
  },
  async (args, ctx) => {
    const token = ctx.agentConfig.integrations?.clinicexpress?.token;
    if (!token) return { error: "ClinicExpress não configurado" };

    const phone = args.telefone || ctx.phone;
    try {
      return await clinicExpressRequest("POST", "/patients", token, {
        name: args.nome,
        phone,
      });
    } catch (e: any) {
      return { error: e.message };
    }
  },
);

// ═══════════════════════════════════════════════════════════════════════════
// 17. ce_buscar_horarios – search available hours in ClinicExpress
// ═══════════════════════════════════════════════════════════════════════════

registerTool(
  "ce_buscar_horarios",
  "Busca horários disponíveis para agendamento no ClinicExpress.",
  {
    type: "object",
    properties: {
      professional_uuid: {
        type: "string",
        description: "UUID do profissional",
      },
      data: {
        type: "string",
        description: "Data para buscar horários (formato YYYY-MM-DD)",
      },
    },
    required: ["professional_uuid", "data"],
  },
  async (args, ctx) => {
    const token = ctx.agentConfig.integrations?.clinicexpress?.token;
    if (!token) return { error: "ClinicExpress não configurado" };

    try {
      return await clinicExpressRequest("GET", "/available-hours", token, undefined, {
        professional_uuid: args.professional_uuid,
        date: args.data,
      });
    } catch (e: any) {
      return { error: e.message };
    }
  },
);

// ═══════════════════════════════════════════════════════════════════════════
// 18. ce_criar_agendamento – create booking in ClinicExpress
// ═══════════════════════════════════════════════════════════════════════════

registerTool(
  "ce_criar_agendamento",
  "Cria um novo agendamento/consulta no ClinicExpress.",
  {
    type: "object",
    properties: {
      starts_at: {
        type: "string",
        description: "Data/hora de início (ISO datetime)",
      },
      ends_at: {
        type: "string",
        description: "Data/hora de término (ISO datetime)",
      },
      patient_uuid: {
        type: "string",
        description: "UUID do paciente",
      },
      professional_uuid: {
        type: "string",
        description: "UUID do profissional",
      },
      procedures: {
        type: "array",
        items: {
          type: "object",
          properties: {
            uuid: { type: "string" },
          },
        },
        description: "Lista de procedimentos (cada um com uuid)",
      },
    },
    required: ["starts_at", "ends_at", "patient_uuid", "professional_uuid", "procedures"],
  },
  async (args, ctx) => {
    const token = ctx.agentConfig.integrations?.clinicexpress?.token;
    if (!token) return { error: "ClinicExpress não configurado" };

    try {
      return await clinicExpressRequest("POST", "/bookings", token, {
        starts_at: args.starts_at,
        ends_at: args.ends_at,
        patient_uuid: args.patient_uuid,
        professional_uuid: args.professional_uuid,
        procedures: args.procedures,
      });
    } catch (e: any) {
      return { error: e.message };
    }
  },
);

// ═══════════════════════════════════════════════════════════════════════════
// 19. ce_buscar_agendamentos – list bookings in ClinicExpress
// ═══════════════════════════════════════════════════════════════════════════

registerTool(
  "ce_buscar_agendamentos",
  "Lista agendamentos/consultas no ClinicExpress por período.",
  {
    type: "object",
    properties: {
      data_inicio: {
        type: "string",
        description: "Data/hora início (ISO datetime)",
      },
      data_fim: {
        type: "string",
        description: "Data/hora fim (ISO datetime)",
      },
    },
    required: ["data_inicio", "data_fim"],
  },
  async (args, ctx) => {
    const token = ctx.agentConfig.integrations?.clinicexpress?.token;
    if (!token) return { error: "ClinicExpress não configurado" };

    try {
      return await clinicExpressRequest("GET", "/bookings", token, undefined, {
        starts_at: args.data_inicio,
        ends_at: args.data_fim,
      });
    } catch (e: any) {
      return { error: e.message };
    }
  },
);

// ═══════════════════════════════════════════════════════════════════════════
// 20. ce_remarcar – reschedule booking in ClinicExpress
// ═══════════════════════════════════════════════════════════════════════════

registerTool(
  "ce_remarcar",
  "Remarca um agendamento existente no ClinicExpress.",
  {
    type: "object",
    properties: {
      booking_uuid: {
        type: "string",
        description: "UUID do agendamento",
      },
      starts_at: {
        type: "string",
        description: "Nova data/hora de início (ISO datetime)",
      },
      ends_at: {
        type: "string",
        description: "Nova data/hora de término (ISO datetime)",
      },
    },
    required: ["booking_uuid", "starts_at", "ends_at"],
  },
  async (args, ctx) => {
    const token = ctx.agentConfig.integrations?.clinicexpress?.token;
    if (!token) return { error: "ClinicExpress não configurado" };

    try {
      return await clinicExpressRequest(
        "PATCH",
        `/bookings/${args.booking_uuid}/reschedule`,
        token,
        {
          starts_at: args.starts_at,
          ends_at: args.ends_at,
        },
      );
    } catch (e: any) {
      return { error: e.message };
    }
  },
);

// ═══════════════════════════════════════════════════════════════════════════
// 21. ce_cancelar – cancel booking in ClinicExpress
// ═══════════════════════════════════════════════════════════════════════════

registerTool(
  "ce_cancelar",
  "Cancela um agendamento existente no ClinicExpress.",
  {
    type: "object",
    properties: {
      booking_uuid: {
        type: "string",
        description: "UUID do agendamento",
      },
      motivo: {
        type: "string",
        description: "Motivo do cancelamento",
      },
    },
    required: ["booking_uuid", "motivo"],
  },
  async (args, ctx) => {
    const token = ctx.agentConfig.integrations?.clinicexpress?.token;
    if (!token) return { error: "ClinicExpress não configurado" };

    try {
      return await clinicExpressRequest(
        "PATCH",
        `/bookings/${args.booking_uuid}/reschedule`,
        token,
        {
          cancelled: true,
          cancellation_reason: args.motivo,
        },
      );
    } catch (e: any) {
      return { error: e.message };
    }
  },
);

// ═══════════════════════════════════════════════════════════════════════════
// 22. cu_buscar_paciente – search patient in Clinup by phone
// ═══════════════════════════════════════════════════════════════════════════

registerTool(
  "cu_buscar_paciente",
  "Busca paciente no Clinup pelo celular.",
  {
    type: "object",
    properties: {
      celular: {
        type: "string",
        description: "Celular do paciente (opcional, usa o da conversa se não informado)",
      },
    },
  },
  async (args, ctx) => {
    const apiToken = ctx.agentConfig.integrations?.clinup?.api_token;
    if (!apiToken) return { error: "Clinup não configurado" };

    const phone = args.celular || ctx.phone;
    try {
      return await clinupRequest("GET", "/paciente", apiToken, undefined, {
        celular: phone,
      });
    } catch (e: any) {
      return { error: e.message };
    }
  },
);

// ═══════════════════════════════════════════════════════════════════════════
// 23. cu_criar_paciente – create patient in Clinup
// ═══════════════════════════════════════════════════════════════════════════

registerTool(
  "cu_criar_paciente",
  "Cria um novo paciente no Clinup.",
  {
    type: "object",
    properties: {
      nome: {
        type: "string",
        description: "Nome completo do paciente",
      },
      celular: {
        type: "string",
        description: "Celular do paciente (opcional, usa o da conversa se não informado)",
      },
    },
    required: ["nome"],
  },
  async (args, ctx) => {
    const apiToken = ctx.agentConfig.integrations?.clinup?.api_token;
    if (!apiToken) return { error: "Clinup não configurado" };

    const phone = args.celular || ctx.phone;
    try {
      return await clinupRequest("POST", "/paciente", apiToken, {
        nome: args.nome,
        celular: phone,
      });
    } catch (e: any) {
      return { error: e.message };
    }
  },
);

// ═══════════════════════════════════════════════════════════════════════════
// 24. cu_buscar_datas – search available dates in Clinup
// ═══════════════════════════════════════════════════════════════════════════

registerTool(
  "cu_buscar_datas",
  "Busca datas disponíveis para um profissional no Clinup.",
  {
    type: "object",
    properties: {
      profissional_id: {
        type: "string",
        description: "ID do profissional",
      },
      data: {
        type: "string",
        description: "Data de referência (formato YYYY-MM-DD)",
      },
    },
    required: ["profissional_id", "data"],
  },
  async (args, ctx) => {
    const apiToken = ctx.agentConfig.integrations?.clinup?.api_token;
    if (!apiToken) return { error: "Clinup não configurado" };

    try {
      return await clinupRequest("GET", "/datas", apiToken, undefined, {
        profissionalId: args.profissional_id,
        data: args.data,
      });
    } catch (e: any) {
      return { error: e.message };
    }
  },
);

// ═══════════════════════════════════════════════════════════════════════════
// 25. cu_buscar_horarios – search available hours in Clinup
// ═══════════════════════════════════════════════════════════════════════════

registerTool(
  "cu_buscar_horarios",
  "Busca horários disponíveis para um profissional em uma data no Clinup.",
  {
    type: "object",
    properties: {
      profissional_id: {
        type: "string",
        description: "ID do profissional",
      },
      data: {
        type: "string",
        description: "Data para buscar horários (formato YYYY-MM-DD)",
      },
    },
    required: ["profissional_id", "data"],
  },
  async (args, ctx) => {
    const apiToken = ctx.agentConfig.integrations?.clinup?.api_token;
    if (!apiToken) return { error: "Clinup não configurado" };

    try {
      return await clinupRequest("GET", "/horas", apiToken, undefined, {
        profissionalId: args.profissional_id,
        data: args.data,
      });
    } catch (e: any) {
      return { error: e.message };
    }
  },
);

// ═══════════════════════════════════════════════════════════════════════════
// 26. cu_criar_consulta – create appointment in Clinup
// ═══════════════════════════════════════════════════════════════════════════

registerTool(
  "cu_criar_consulta",
  "Cria uma nova consulta/agendamento no Clinup.",
  {
    type: "object",
    properties: {
      profissional_id: {
        type: "string",
        description: "ID do profissional",
      },
      paciente_id: {
        type: "string",
        description: "ID do paciente",
      },
      data: {
        type: "string",
        description: "Data da consulta (formato YYYY-MM-DD)",
      },
      hora: {
        type: "string",
        description: "Horário da consulta (formato HH:mm)",
      },
      observacao: {
        type: "string",
        description: "Observação sobre a consulta (opcional)",
      },
    },
    required: ["profissional_id", "paciente_id", "data", "hora"],
  },
  async (args, ctx) => {
    const apiToken = ctx.agentConfig.integrations?.clinup?.api_token;
    if (!apiToken) return { error: "Clinup não configurado" };

    try {
      return await clinupRequest("POST", "/consultas", apiToken, {
        profissionalId: args.profissional_id,
        pacienteId: args.paciente_id,
        data: args.data,
        hora: args.hora,
        Observacao: args.observacao || "",
      });
    } catch (e: any) {
      return { error: e.message };
    }
  },
);

// ═══════════════════════════════════════════════════════════════════════════
// 27. cu_buscar_consultas – list appointments in Clinup
// ═══════════════════════════════════════════════════════════════════════════

registerTool(
  "cu_buscar_consultas",
  "Lista consultas de um paciente no Clinup.",
  {
    type: "object",
    properties: {
      paciente_id: {
        type: "string",
        description: "ID do paciente",
      },
    },
    required: ["paciente_id"],
  },
  async (args, ctx) => {
    const apiToken = ctx.agentConfig.integrations?.clinup?.api_token;
    if (!apiToken) return { error: "Clinup não configurado" };

    try {
      return await clinupRequest("GET", "/consultas", apiToken, undefined, {
        pacienteId: args.paciente_id,
      });
    } catch (e: any) {
      return { error: e.message };
    }
  },
);

// ═══════════════════════════════════════════════════════════════════════════
// 28. cu_gerir_consultas – reschedule or cancel appointment in Clinup
// ═══════════════════════════════════════════════════════════════════════════

registerTool(
  "cu_gerir_consultas",
  "Remarca ou cancela uma consulta no Clinup.",
  {
    type: "object",
    properties: {
      consulta_id: {
        type: "string",
        description: "ID da consulta",
      },
      data: {
        type: "string",
        description: "Nova data (formato YYYY-MM-DD, opcional para cancelamento)",
      },
      hora: {
        type: "string",
        description: "Novo horário (formato HH:mm, opcional para cancelamento)",
      },
      confirmada: {
        type: "boolean",
        description: "Se a consulta está confirmada (false para cancelar)",
      },
      motivo: {
        type: "string",
        description: "Motivo da alteração/cancelamento",
      },
    },
    required: ["consulta_id"],
  },
  async (args, ctx) => {
    const apiToken = ctx.agentConfig.integrations?.clinup?.api_token;
    if (!apiToken) return { error: "Clinup não configurado" };

    const body: Record<string, any> = { id: args.consulta_id };
    if (args.data) body.data = args.data;
    if (args.hora) body.hora = args.hora;
    if (args.confirmada !== undefined) body.confirmada = args.confirmada;
    if (args.motivo) body.motivo = args.motivo;

    try {
      return await clinupRequest("PUT", "/consultas", apiToken, body);
    } catch (e: any) {
      return { error: e.message };
    }
  },
);

// ═══════════════════════════════════════════════════════════════════════════
// 29. gc_buscar_eventos – list events from Google Calendar
// ═══════════════════════════════════════════════════════════════════════════

registerTool(
  "gc_buscar_eventos",
  "Lista eventos do Google Calendar em um período.",
  {
    type: "object",
    properties: {
      data_inicio: {
        type: "string",
        description: "Data/hora início (ISO datetime)",
      },
      data_fim: {
        type: "string",
        description: "Data/hora fim (ISO datetime)",
      },
    },
    required: ["data_inicio", "data_fim"],
  },
  async (args, ctx) => {
    const gcConfig = ctx.agentConfig.integrations?.google_calendar;
    if (!gcConfig?.calendar_id) {
      return { error: "Google Calendar não configurado" };
    }

    try {
      const accessToken = await getGoogleAccessToken(gcConfig, ctx.agentConfig.accountId);
      return await googleCalendarRequest(
        "GET",
        `/calendars/${encodeURIComponent(gcConfig.calendar_id)}/events`,
        accessToken,
        undefined,
        {
          timeMin: args.data_inicio,
          timeMax: args.data_fim,
          singleEvents: "true",
          orderBy: "startTime",
        },
      );
    } catch (e: any) {
      return { error: e.message };
    }
  },
);

// ═══════════════════════════════════════════════════════════════════════════
// 30. gc_criar_evento – create event in Google Calendar
// ═══════════════════════════════════════════════════════════════════════════

registerTool(
  "gc_criar_evento",
  "Cria um novo evento no Google Calendar.",
  {
    type: "object",
    properties: {
      titulo: {
        type: "string",
        description: "Título do evento (ex: 'Consulta - Nome Paciente')",
      },
      descricao: {
        type: "string",
        description: "Descrição do evento",
      },
      inicio: {
        type: "string",
        description: "Data/hora de início (ISO datetime)",
      },
      fim: {
        type: "string",
        description: "Data/hora de término (ISO datetime)",
      },
      email_paciente: {
        type: "string",
        description: "E-mail do paciente para convite (opcional)",
      },
    },
    required: ["titulo", "descricao", "inicio", "fim"],
  },
  async (args, ctx) => {
    const gcConfig = ctx.agentConfig.integrations?.google_calendar;
    if (!gcConfig?.calendar_id) {
      return { error: "Google Calendar não configurado" };
    }

    const body: Record<string, any> = {
      summary: args.titulo,
      description: args.descricao,
      start: { dateTime: args.inicio, timeZone: "America/Sao_Paulo" },
      end: { dateTime: args.fim, timeZone: "America/Sao_Paulo" },
    };
    if (args.email_paciente) {
      body.attendees = [{ email: args.email_paciente }];
    }

    try {
      const accessToken = await getGoogleAccessToken(gcConfig, ctx.agentConfig.accountId);
      return await googleCalendarRequest(
        "POST",
        `/calendars/${encodeURIComponent(gcConfig.calendar_id)}/events`,
        accessToken,
        body,
      );
    } catch (e: any) {
      return { error: e.message };
    }
  },
);

// ═══════════════════════════════════════════════════════════════════════════
// 31. gc_cancelar_evento – delete event from Google Calendar
// ═══════════════════════════════════════════════════════════════════════════

registerTool(
  "gc_cancelar_evento",
  "Cancela/remove um evento do Google Calendar.",
  {
    type: "object",
    properties: {
      evento_id: {
        type: "string",
        description: "ID do evento no Google Calendar",
      },
    },
    required: ["evento_id"],
  },
  async (args, ctx) => {
    const gcConfig = ctx.agentConfig.integrations?.google_calendar;
    if (!gcConfig?.calendar_id) {
      return { error: "Google Calendar não configurado" };
    }

    try {
      const accessToken = await getGoogleAccessToken(gcConfig, ctx.agentConfig.accountId);
      return await googleCalendarRequest(
        "DELETE",
        `/calendars/${encodeURIComponent(gcConfig.calendar_id)}/events/${encodeURIComponent(args.evento_id)}`,
        accessToken,
      );
    } catch (e: any) {
      return { error: e.message };
    }
  },
);

// ═══════════════════════════════════════════════════════════════════════════
// 32. gc_buscar_horarios_livres – check free/busy in Google Calendar
// ═══════════════════════════════════════════════════════════════════════════

registerTool(
  "gc_buscar_horarios_livres",
  "Consulta períodos ocupados no Google Calendar para inferir horários livres.",
  {
    type: "object",
    properties: {
      data_inicio: {
        type: "string",
        description: "Data/hora início (ISO datetime)",
      },
      data_fim: {
        type: "string",
        description: "Data/hora fim (ISO datetime)",
      },
    },
    required: ["data_inicio", "data_fim"],
  },
  async (args, ctx) => {
    const gcConfig = ctx.agentConfig.integrations?.google_calendar;
    if (!gcConfig?.calendar_id) {
      return { error: "Google Calendar não configurado" };
    }

    try {
      const accessToken = await getGoogleAccessToken(gcConfig, ctx.agentConfig.accountId);
      return await googleCalendarRequest(
        "POST",
        "/freeBusy",
        accessToken,
        {
          timeMin: args.data_inicio,
          timeMax: args.data_fim,
          items: [{ id: gcConfig.calendar_id }],
        },
      );
    } catch (e: any) {
      return { error: e.message };
    }
  },
);

// ═══════════════════════════════════════════════════════════════════════════
// Public API
// ═══════════════════════════════════════════════════════════════════════════

export function getToolDefinitions(enabledTools: string[]): LlmToolDef[] {
  return enabledTools
    .filter((name) => TOOL_REGISTRY[name])
    .map((name) => TOOL_REGISTRY[name].definition);
}

export function getAllToolNames(): string[] {
  return Object.keys(TOOL_REGISTRY);
}

export async function executeTool(
  name: string,
  args: Record<string, any>,
  ctx: ToolContext,
): Promise<any> {
  const tool = TOOL_REGISTRY[name];
  if (!tool) {
    logger.warn({ name }, "unknown tool called");
    return { error: `Tool '${name}' not found` };
  }

  try {
    logger.info({ tool: name, args }, "executing tool");
    const result = await tool.handler(args, ctx);
    logger.info({ tool: name }, "tool executed successfully");
    return result;
  } catch (e: any) {
    logger.error({ tool: name, err: e.message }, "tool execution failed");
    return { error: e.message };
  }
}
