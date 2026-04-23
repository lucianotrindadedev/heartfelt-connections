/**
 * Mock do backend para desenvolvimento do frontend sem servidor rodando.
 * Ativado por VITE_MOCK_API=true (default em DEV).
 *
 * Cobre todos os endpoints consumidos pelas abas do embed
 * (overview, agentes, follow-up, warm-up, integrações, mídias,
 *  automações, conversas, logs) com dados realistas.
 */

import type {
  Account,
  Agent,
  AgentRun,
  AgentWebhook,
  AutomationRule,
  Conversation,
  DashboardStats,
  FollowupConfig,
  Integration,
  MediaAsset,
  Message,
  WarmupConfig,
} from "./types";

export const MOCK_API_ENABLED =
  (import.meta.env.VITE_MOCK_API as string | undefined) === "false"
    ? false
    : ((import.meta.env.VITE_MOCK_API as string | undefined) === "true" ||
        import.meta.env.DEV);

// ─── Estado em memória ────────────────────────────────────────────────────

const account: Account = {
  id: "demo-account",
  name: "Clínica Sorriso Demo",
  crm_base_api: "https://api.helena.com.br/v1",
  crm_token_set: true,
  created_at: "2025-01-15T10:00:00.000Z",
};

let agents: Agent[] = [
  {
    id: "agent-main",
    account_id: account.id,
    name: "Atendimento Principal",
    kind: "main",
    template: "clinicorp_dental",
    enabled: true,
    llm_provider: "openrouter",
    llm_model: "anthropic/claude-3.5-sonnet",
    system_prompt:
      "Você é a Sofia, atendente virtual da Clínica Sorriso. Seja cordial, objetiva e use no máximo 2 mensagens curtas por turno. Sempre confirme nome, telefone e procedimento desejado antes de agendar.",
    voice_settings: { provider: "elevenlabs", voice_id: "EXAVITQu4vr4xnSDxMaL" },
    tools: ["check_calendar", "create_appointment", "list_services", "send_media"],
    created_at: "2025-01-15T10:05:00.000Z",
  },
  {
    id: "agent-followup",
    account_id: account.id,
    name: "Recuperação de leads",
    kind: "followup",
    template: "custom",
    enabled: true,
    llm_provider: "openrouter",
    llm_model: "openai/gpt-4o-mini",
    system_prompt:
      "Você reativa pacientes que não responderam. Seja breve (1 mensagem), simpática e ofereça horários disponíveis.",
    voice_settings: null,
    tools: ["check_calendar"],
    created_at: "2025-01-16T09:00:00.000Z",
  },
  {
    id: "agent-warmup",
    account_id: account.id,
    name: "Aquecimento de chip",
    kind: "warmup",
    template: "custom",
    enabled: false,
    llm_provider: "groq",
    llm_model: "llama-3.1-8b-instant",
    system_prompt: "Conversa casual para aquecer número novo no WhatsApp.",
    voice_settings: null,
    tools: [],
    created_at: "2025-01-17T14:30:00.000Z",
  },
];

const integrations: Integration[] = [
  {
    id: "int-helena",
    account_id: account.id,
    type: "helena_crm",
    config_preview: { base_url: "https://api.helena.com.br/v1", account_slug: "sorriso" },
    has_secrets: true,
    updated_at: "2025-02-01T12:00:00.000Z",
  },
  {
    id: "int-clinicorp",
    account_id: account.id,
    type: "clinicorp",
    config_preview: { subscriber_id: "12345", business_id: "67890" },
    has_secrets: true,
    updated_at: "2025-02-02T15:20:00.000Z",
  },
  {
    id: "int-gcal",
    account_id: account.id,
    type: "google_calendar",
    config_preview: { calendar_id: "agenda@clinica.com" },
    has_secrets: true,
    updated_at: "2025-02-03T11:10:00.000Z",
  },
  {
    id: "int-evo",
    account_id: account.id,
    type: "evolution_api",
    config_preview: { instance: "sorriso-prod", base_url: "https://evo.helena.com.br" },
    has_secrets: true,
    updated_at: "2025-02-04T08:45:00.000Z",
  },
  {
    id: "int-eleven",
    account_id: account.id,
    type: "elevenlabs",
    config_preview: { voice_id: "EXAVITQu4vr4xnSDxMaL" },
    has_secrets: true,
    updated_at: "2025-02-05T16:00:00.000Z",
  },
  {
    id: "int-router",
    account_id: account.id,
    type: "openrouter",
    config_preview: { default_model: "anthropic/claude-3.5-sonnet" },
    has_secrets: true,
    updated_at: "2025-02-06T10:00:00.000Z",
  },
];

const followupCfg: Record<string, FollowupConfig> = {
  "agent-followup": {
    agent_id: "agent-followup",
    enabled: true,
    cron_expression: "0 10,15 * * 1-5",
    max_followups: 3,
    prompts: [
      "Oi {nome}, tudo bem? Vi que ficou de me retornar sobre seu agendamento. Posso te ajudar a escolher um horário?",
      "Oi {nome}! Ainda dá tempo de marcar essa semana — temos vagas amanhã às 14h e 16h. Qual prefere?",
      "{nome}, vou deixar sua ficha em standby. Quando quiser retomar é só me chamar :)",
    ],
  },
};

const warmupCfg: Record<string, WarmupConfig> = {
  "agent-warmup": {
    agent_id: "agent-warmup",
    enabled: false,
    tempo_wu1: 30,
    tempo_wu2: 60,
    tempo_wu3: 120,
    tempo_wu4: 240,
    tempo_wu5: 480,
    prompts: {
      wu1: "Oi! Tudo certo por aí?",
      wu2: "Vi sua mensagem, já te respondo já já.",
      wu3: "Perfeito, anotado aqui.",
      wu4: "Qualquer coisa me chama de novo.",
      wu5: "Bom dia! Tudo bem com você hoje?",
    },
    subscriber_id: "12345",
    business_id: "67890",
  },
};

let media: Record<string, MediaAsset[]> = {
  "agent-main": [
    {
      id: "med-1",
      agent_id: "agent-main",
      name: "Tabela de preços",
      description: "PDF com valores atualizados de procedimentos.",
      source: "gdrive",
      external_id: "1AbCdEfGhIjKlMnOp",
      mime_type: "application/pdf",
    },
    {
      id: "med-2",
      agent_id: "agent-main",
      name: "Endereço da clínica",
      description: "Imagem com mapa e foto da fachada.",
      source: "supabase_storage",
      external_id: "media/endereco.jpg",
      mime_type: "image/jpeg",
    },
  ],
};

let automations: Record<string, AutomationRule[]> = {
  "agent-main": [
    {
      id: "auto-1",
      agent_id: "agent-main",
      trigger: "tag_changed",
      conditions: { tag: "lead-quente" },
      actions: [{ type: "notify_human", channel: "whatsapp" }],
      enabled: true,
    },
    {
      id: "auto-2",
      agent_id: "agent-main",
      trigger: "appointment_status",
      conditions: { status: "confirmed" },
      actions: [{ type: "send_template", template: "lembrete_24h" }],
      enabled: true,
    },
  ],
};

const webhooks: Record<string, AgentWebhook> = {
  "agent-main": {
    agent_id: "agent-main",
    inbound_url: "https://api.demo.helena.com.br/webhooks/agent-main",
    webhook_secret: "whsec_demo_a1b2c3d4e5f6g7h8i9j0",
  },
  "agent-followup": {
    agent_id: "agent-followup",
    inbound_url: "https://api.demo.helena.com.br/webhooks/agent-followup",
    webhook_secret: "whsec_demo_z9y8x7w6v5u4t3s2r1q0",
  },
};

const conversations: Conversation[] = [
  {
    id: "conv-1",
    agent_id: "agent-main",
    phone: "+5511988887777",
    helena_session_id: "sess_001",
    helena_contact_id: "ctc_001",
    status: "active",
    updated_at: new Date(Date.now() - 1000 * 60 * 5).toISOString(),
  },
  {
    id: "conv-2",
    agent_id: "agent-main",
    phone: "+5511977776666",
    helena_session_id: "sess_002",
    helena_contact_id: "ctc_002",
    status: "waiting_human",
    updated_at: new Date(Date.now() - 1000 * 60 * 32).toISOString(),
  },
  {
    id: "conv-3",
    agent_id: "agent-main",
    phone: "+5511966665555",
    helena_session_id: "sess_003",
    helena_contact_id: "ctc_003",
    status: "closed",
    updated_at: new Date(Date.now() - 1000 * 60 * 60 * 3).toISOString(),
  },
];

const messages: Record<string, Message[]> = {
  "conv-1": [
    {
      id: "m1",
      conversation_id: "conv-1",
      role: "user",
      content: "Oi, queria marcar uma limpeza",
      tool_calls: null,
      created_at: new Date(Date.now() - 1000 * 60 * 7).toISOString(),
    },
    {
      id: "m2",
      conversation_id: "conv-1",
      role: "assistant",
      content: "Oi! Claro 😊 Pode me passar seu nome completo?",
      tool_calls: null,
      created_at: new Date(Date.now() - 1000 * 60 * 6).toISOString(),
    },
    {
      id: "m3",
      conversation_id: "conv-1",
      role: "user",
      content: "Mariana Souza",
      tool_calls: null,
      created_at: new Date(Date.now() - 1000 * 60 * 5).toISOString(),
    },
  ],
  "conv-2": [
    {
      id: "m4",
      conversation_id: "conv-2",
      role: "user",
      content: "Vocês fazem clareamento?",
      tool_calls: null,
      created_at: new Date(Date.now() - 1000 * 60 * 35).toISOString(),
    },
    {
      id: "m5",
      conversation_id: "conv-2",
      role: "assistant",
      content: "Fazemos sim! Temos clareamento a laser e caseiro. Quer que eu te passe valores?",
      tool_calls: [{ name: "list_services", args: { category: "clareamento" } }],
      created_at: new Date(Date.now() - 1000 * 60 * 33).toISOString(),
    },
  ],
  "conv-3": [
    {
      id: "m6",
      conversation_id: "conv-3",
      role: "user",
      content: "Confirmado, obrigada!",
      tool_calls: null,
      created_at: new Date(Date.now() - 1000 * 60 * 60 * 3).toISOString(),
    },
  ],
};

const runs: AgentRun[] = Array.from({ length: 12 }).map((_, i) => ({
  id: `run-${i + 1}`,
  agent_id: i % 3 === 0 ? "agent-followup" : "agent-main",
  conversation_id: `conv-${(i % 3) + 1}`,
  phone: ["+5511988887777", "+5511977776666", "+5511966665555"][i % 3],
  status: i === 4 ? "error" : i === 9 ? "skipped" : "ok",
  latency_ms: 800 + Math.floor(Math.random() * 2200),
  cost_usd: Number((0.0008 + Math.random() * 0.004).toFixed(5)),
  tokens_in: 200 + Math.floor(Math.random() * 800),
  tokens_out: 80 + Math.floor(Math.random() * 300),
  tools_called: i % 2 === 0 ? ["check_calendar"] : [],
  error: i === 4 ? "Timeout chamando Clinicorp /appointments" : null,
  created_at: new Date(Date.now() - 1000 * 60 * 15 * i).toISOString(),
}));

const stats: DashboardStats = {
  agents_active: agents.filter((a) => a.enabled).length,
  messages_24h: 184,
  estimated_cost_24h_usd: 0.42,
  queue_size: 3,
};

// ─── Roteador ─────────────────────────────────────────────────────────────

interface MockReq {
  method: string;
  body: unknown;
}

function uid(prefix: string) {
  return `${prefix}-${Math.random().toString(36).slice(2, 9)}`;
}

export async function handleMock(path: string, req: MockReq): Promise<unknown> {
  // pequena latência para parecer real
  await new Promise((r) => setTimeout(r, 120));

  const url = path.split("?")[0];
  const method = req.method.toUpperCase();

  // Auth exchange
  if (url === "/api/auth/exchange" && method === "POST") {
    return { token: "mock-jwt-token", account: { id: account.id, name: account.name } };
  }

  // Account/agents
  const accAgentsMatch = url.match(/^\/api\/accounts\/([^/]+)\/agents$/);
  if (accAgentsMatch && method === "GET") return agents;

  const accStatsMatch = url.match(/^\/api\/accounts\/([^/]+)\/stats$/);
  if (accStatsMatch && method === "GET") return stats;

  const accIntsMatch = url.match(/^\/api\/accounts\/([^/]+)\/integrations$/);
  if (accIntsMatch && method === "GET") return integrations;
  if (accIntsMatch && method === "POST") {
    const body = req.body as Partial<Integration> & { type?: Integration["type"] };
    const idx = integrations.findIndex((i) => i.type === body.type);
    if (idx >= 0) {
      integrations[idx] = {
        ...integrations[idx],
        config_preview: body.config_preview ?? integrations[idx].config_preview,
        has_secrets: true,
        updated_at: new Date().toISOString(),
      };
      return integrations[idx];
    }
    const created: Integration = {
      id: uid("int"),
      account_id: account.id,
      type: body.type ?? "helena_crm",
      config_preview: body.config_preview ?? {},
      has_secrets: true,
      updated_at: new Date().toISOString(),
    };
    integrations.push(created);
    return created;
  }

  const accConvMatch = url.match(/^\/api\/accounts\/([^/]+)\/conversations$/);
  if (accConvMatch && method === "GET") return conversations;

  const accRunsMatch = url.match(/^\/api\/accounts\/([^/]+)\/runs$/);
  if (accRunsMatch && method === "GET") return runs;

  // Agente individual
  const agentMatch = url.match(/^\/api\/agents\/([^/]+)$/);
  if (agentMatch && method === "PATCH") {
    const id = agentMatch[1];
    const body = req.body as Partial<Agent>;
    agents = agents.map((a) => (a.id === id ? { ...a, ...body } : a));
    return agents.find((a) => a.id === id);
  }

  const agentWebhookMatch = url.match(/^\/api\/agents\/([^/]+)\/webhook$/);
  if (agentWebhookMatch && method === "GET") {
    const id = agentWebhookMatch[1];
    return webhooks[id] ?? {
      agent_id: id,
      inbound_url: `https://api.demo.helena.com.br/webhooks/${id}`,
      webhook_secret: `whsec_demo_${id}`,
    };
  }

  const followupMatch = url.match(/^\/api\/agents\/([^/]+)\/followup$/);
  if (followupMatch) {
    const id = followupMatch[1];
    if (method === "GET") {
      return (
        followupCfg[id] ?? {
          agent_id: id,
          enabled: false,
          cron_expression: "0 10 * * *",
          max_followups: 2,
          prompts: [],
        }
      );
    }
    if (method === "PATCH") {
      const body = req.body as Partial<FollowupConfig>;
      followupCfg[id] = {
        ...(followupCfg[id] ?? {
          agent_id: id,
          enabled: false,
          cron_expression: "0 10 * * *",
          max_followups: 2,
          prompts: [],
        }),
        ...body,
      };
      return followupCfg[id];
    }
  }

  const warmupMatch = url.match(/^\/api\/agents\/([^/]+)\/warmup$/);
  if (warmupMatch) {
    const id = warmupMatch[1];
    if (method === "GET") {
      return (
        warmupCfg[id] ?? {
          agent_id: id,
          enabled: false,
          tempo_wu1: 30,
          tempo_wu2: 60,
          tempo_wu3: 120,
          tempo_wu4: 240,
          tempo_wu5: 480,
          prompts: { wu1: "", wu2: "", wu3: "", wu4: "", wu5: "" },
          subscriber_id: null,
          business_id: null,
        }
      );
    }
    if (method === "PATCH") {
      const body = req.body as Partial<WarmupConfig>;
      warmupCfg[id] = { ...(warmupCfg[id] ?? ({} as WarmupConfig)), ...body, agent_id: id };
      return warmupCfg[id];
    }
  }

  const mediaMatch = url.match(/^\/api\/agents\/([^/]+)\/media$/);
  if (mediaMatch) {
    const id = mediaMatch[1];
    if (method === "GET") return media[id] ?? [];
    if (method === "POST") {
      const body = req.body as Partial<MediaAsset>;
      const created: MediaAsset = {
        id: uid("med"),
        agent_id: id,
        name: body.name ?? "Sem nome",
        description: body.description ?? "",
        source: body.source ?? "gdrive",
        external_id: body.external_id ?? "",
        mime_type: body.mime_type ?? "application/octet-stream",
      };
      media[id] = [...(media[id] ?? []), created];
      return created;
    }
  }
  const mediaDelMatch = url.match(/^\/api\/agents\/([^/]+)\/media\/([^/]+)$/);
  if (mediaDelMatch && method === "DELETE") {
    const [, agentId, mediaId] = mediaDelMatch;
    media[agentId] = (media[agentId] ?? []).filter((m) => m.id !== mediaId);
    return { ok: true };
  }

  const autoMatch = url.match(/^\/api\/agents\/([^/]+)\/automations$/);
  if (autoMatch) {
    const id = autoMatch[1];
    if (method === "GET") return automations[id] ?? [];
    if (method === "POST") {
      const body = req.body as Partial<AutomationRule>;
      const created: AutomationRule = {
        id: uid("auto"),
        agent_id: id,
        trigger: body.trigger ?? "tag_changed",
        conditions: body.conditions ?? {},
        actions: body.actions ?? [],
        enabled: body.enabled ?? true,
      };
      automations[id] = [...(automations[id] ?? []), created];
      return created;
    }
  }
  const autoDelMatch = url.match(/^\/api\/agents\/([^/]+)\/automations\/([^/]+)$/);
  if (autoDelMatch && method === "DELETE") {
    const [, agentId, autoId] = autoDelMatch;
    automations[agentId] = (automations[agentId] ?? []).filter((a) => a.id !== autoId);
    return { ok: true };
  }

  const convMsgsMatch = url.match(/^\/api\/conversations\/([^/]+)\/messages$/);
  if (convMsgsMatch && method === "GET") {
    return messages[convMsgsMatch[1]] ?? [];
  }

  // Test integration
  const testMatch = url.match(/^\/api\/test\/([^/]+)$/);
  if (testMatch && method === "POST") {
    return { ok: true, details: `Mock: integração ${testMatch[1]} OK.` };
  }

  // Fallback
  console.warn(`[mockApi] sem handler para ${method} ${url}`);
  return null;
}
