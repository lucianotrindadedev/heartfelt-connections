// Constrói o array de tool definitions OpenAI-compatible para uma conta/agente.
// Inclui somente as ferramentas ativas para a conta.
import { getSelfhost } from "@/integrations/selfhost/client.server";

export interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

// ============================================================
// GOOGLE CALENDAR
// ============================================================

const GCAL_TOOLS: ToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "listar_horarios_google_calendar",
      description:
        "Lista horários disponíveis no Google Calendar do consultório. Use antes de sugerir qualquer horário. Ofereça no máximo 2 opções.",
      parameters: {
        type: "object",
        properties: {
          de: { type: "string", description: "Data/hora inicial ISO 8601 (ex: 2024-03-15T08:00:00-03:00)" },
          ate: { type: "string", description: "Data/hora final ISO 8601 (ex: 2024-03-15T18:00:00-03:00)" },
        },
        required: ["de", "ate"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "agendar_google_calendar",
      description:
        "Cria agendamento no Google Calendar. Só use após confirmar o horário com o paciente.",
      parameters: {
        type: "object",
        properties: {
          titulo: { type: "string", description: "Título do evento (ex: Avaliação - João)" },
          inicio: { type: "string", description: "Início ISO 8601" },
          fim: { type: "string", description: "Fim ISO 8601" },
          descricao: { type: "string", description: "Detalhes adicionais (opcional)" },
        },
        required: ["titulo", "inicio", "fim"],
      },
    },
  },
];

// ============================================================
// CLINICORP
// ============================================================

const CLINICORP_TOOLS: ToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "buscar_paciente_clinicorp",
      description:
        "Verifica se o lead já tem cadastro no Clinicorp pelo telefone. Chame SEMPRE antes de agendar para saber se o paciente existe. Retorna nome e ID do paciente se encontrado, ou indica que não tem cadastro.",
      parameters: {
        type: "object",
        properties: {
          telefone: { type: "string", description: "Telefone do lead com DDD (ex: 21999990000 ou +5521999990000)" },
        },
        required: ["telefone"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "listar_horarios_clinicorp",
      description:
        "Lista horários disponíveis no Clinicorp para agendamento de consulta. Sempre consulte antes de oferecer horários. Ofereça no máximo 2 opções ao paciente.",
      parameters: {
        type: "object",
        properties: {
          de: { type: "string", description: "Data inicial (YYYY-MM-DD)" },
          ate: { type: "string", description: "Data final (YYYY-MM-DD)" },
        },
        required: ["de", "ate"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "agendar_clinicorp",
      description:
        "Cria consulta no Clinicorp. Se o paciente não tiver cadastro, ele será criado automaticamente. Só use após: (1) buscar_paciente_clinicorp, (2) listar_horarios_clinicorp, (3) confirmar nome, telefone e horário com o paciente. Nunca confirme ao paciente antes do retorno de sucesso.",
      parameters: {
        type: "object",
        properties: {
          nome: { type: "string", description: "Nome completo do paciente" },
          telefone: { type: "string", description: "Telefone do paciente com DDD" },
          horario: { type: "string", description: "Data/hora ISO 8601 do slot escolhido (ex: 2024-03-15T10:00:00-03:00)" },
          dentist_person_id: { type: "string", description: "ID do profissional do slot escolhido — obtido via listar_horarios_clinicorp (campo dentist_person_id=XXXX). Obrigatório quando disponível." },
        },
        required: ["nome", "telefone", "horario"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "buscar_agendamentos_clinicorp",
      description:
        "Busca os agendamentos existentes do paciente no Clinicorp pelo telefone. Use para confirmar se o agendamento foi criado com sucesso, ou quando o paciente quiser cancelar/remarcar.",
      parameters: {
        type: "object",
        properties: {
          telefone: { type: "string", description: "Telefone do paciente com DDD" },
        },
        required: ["telefone"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "cancelar_agendamento_clinicorp",
      description:
        "Cancela um agendamento no Clinicorp. Obtenha o agendamento_id via buscar_agendamentos_clinicorp antes de cancelar. Confirme com o paciente antes de executar.",
      parameters: {
        type: "object",
        properties: {
          agendamento_id: { type: "string", description: "ID do agendamento retornado por buscar_agendamentos_clinicorp" },
          motivo: { type: "string", description: "Motivo do cancelamento informado pelo paciente" },
        },
        required: ["agendamento_id"],
      },
    },
  },
];

// ============================================================
// CLINUP (https://app.sistemaclinup.com.br/api/open)
// ============================================================

const CLINUP_TOOLS: ToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "clinup_buscar_horarios",
      description:
        "Busca datas e horários disponíveis no Clinup. Sempre consulte antes de oferecer horários ao paciente. Ofereça no máximo 2 opções.",
      parameters: {
        type: "object",
        properties: {
          de: { type: "string", description: "Data inicial (YYYY-MM-DD)" },
          ate: { type: "string", description: "Data final (YYYY-MM-DD)" },
        },
        required: ["de", "ate"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "clinup_agendar",
      description:
        "Cria uma consulta no Clinup. Só use após confirmar nome, telefone e horário com o paciente E após consultar disponibilidade real. Nunca confirme ao paciente sem retorno de sucesso real da tool.",
      parameters: {
        type: "object",
        properties: {
          nome: { type: "string", description: "Nome completo do paciente" },
          telefone: { type: "string", description: "Telefone do paciente com DDD" },
          horario: { type: "string", description: "Data/hora da consulta ISO 8601 (ex: 2024-03-15T10:00:00)" },
          observacao: { type: "string", description: "Resumo da conversa / interesse principal do paciente" },
        },
        required: ["nome", "telefone", "horario"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "clinup_buscar_consultas",
      description:
        "Busca consultas agendadas do paciente no Clinup pelo telefone. Use para verificar se já existe agendamento ou para obter consultaId.",
      parameters: {
        type: "object",
        properties: {
          telefone: { type: "string", description: "Telefone do paciente com DDD" },
        },
        required: ["telefone"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "clinup_gerir_consulta",
      description:
        "Confirma, cancela ou remarca uma consulta no Clinup. Obtenha consultaId via clinup_buscar_consultas. Use confirmada=false para cancelar/remarcar.",
      parameters: {
        type: "object",
        properties: {
          consultaId: { type: "number", description: "ID numérico da consulta" },
          confirmada: { type: "boolean", description: "true = confirmar, false = cancelar/desmarcar" },
          motivo: { type: "string", description: "Motivo do cancelamento ou remarcação" },
        },
        required: ["consultaId", "confirmada"],
      },
    },
  },
];

// ============================================================
// HELENA CRM TAGS
// ============================================================

const HELENA_TAG_TOOLS: ToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "helena_listar_tags",
      description:
        "Lista todas as tags/etiquetas disponíveis no CRM Helena. Sempre chame antes de adicionar tags para obter os nomes exatos. Nunca invente nomes de tags.",
      parameters: {
        type: "object",
        properties: {},
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "helena_add_tags",
      description:
        "Adiciona ou atualiza tags do contato atual no CRM Helena. Use apenas nomes retornados por helena_listar_tags. Envie TODAS as tags que o contato deve ter. Só use a partir do 2º ciclo de atendimento.",
      parameters: {
        type: "object",
        properties: {
          tagNames: {
            type: "array",
            items: { type: "string" },
            description: "Lista completa de tags que o contato deve ter após a operação",
          },
          operation: {
            type: "string",
            enum: ["InsertIfNotExists", "DeleteIfExists", "ReplaceAll"],
            description: "InsertIfNotExists = adiciona sem remover; DeleteIfExists = remove; ReplaceAll = substitui todas",
          },
        },
        required: ["tagNames", "operation"],
      },
    },
  },
];

// ============================================================
// TELEFONE COLETADO (Instagram / Messenger)
// ============================================================

export const SALVAR_TELEFONE_TOOL: ToolDefinition = {
  type: "function",
  function: {
    name: "salvar_telefone_lead",
    description:
      "Salva o WhatsApp informado pelo lead durante a conversa. Use quando o paciente passar nome e telefone (Instagram/Messenger) ou quando atualizar o número. Obrigatório antes de agendar no Clinicorp se ainda não houver telefone no contexto.",
    parameters: {
      type: "object",
      properties: {
        telefone: {
          type: "string",
          description: "Telefone com DDD, 10 ou 11 dígitos (ex: 11988776655)",
        },
        nome: {
          type: "string",
          description: "Nome completo do paciente (opcional, para atualizar no CRM)",
        },
      },
      required: ["telefone"],
    },
  },
};

// ============================================================
// ESCALAÇÃO HUMANA
// ============================================================

const ESCALATION_TOOL: ToolDefinition = {
  type: "function",
  function: {
    name: "escalar_humano",
    description:
      "Transfere o atendimento para um humano. Use quando: paciente pedir explicitamente, situação delicada, reclamação grave, falha técnica persistente ou dúvida clínica complexa.",
    parameters: {
      type: "object",
      properties: {
        motivo: { type: "string", description: "Motivo da escalada (breve resumo da situação)" },
        resumo_conversa: { type: "string", description: "Resumo dos pontos-chave da conversa para o atendente humano" },
      },
      required: ["motivo"],
    },
  },
};

// ============================================================
// BUILD TOOLS FOR ACCOUNT
// ============================================================

export async function buildToolsForAccount(
  accountId: string,
  agentId: string,
): Promise<ToolDefinition[]> {
  const sb = getSelfhost();

  const [gcal, clinicorp, clinup, escalation] = await Promise.all([
    sb.from("google_calendar_tokens").select("ativo").eq("account_id", accountId).maybeSingle(),
    sb.from("clinicorp_config").select("ativo").eq("account_id", accountId).maybeSingle(),
    sb.from("clinup_config").select("ativo").eq("account_id", accountId).maybeSingle(),
    sb.from("agent_escalation").select("ativo").eq("agent_id", agentId).maybeSingle(),
  ]);

  const tools: ToolDefinition[] = [];

  if (gcal.data?.ativo) tools.push(...GCAL_TOOLS);
  if (clinicorp.data?.ativo) {
    tools.push(...CLINICORP_TOOLS);
    tools.push(SALVAR_TELEFONE_TOOL);
  }
  if (clinup.data?.ativo) {
    tools.push(...CLINUP_TOOLS);
    tools.push(SALVAR_TELEFONE_TOOL);
    tools.push(...HELENA_TAG_TOOLS);
  }
  if (escalation.data?.ativo) tools.push(ESCALATION_TOOL);

  // Se tiver qualquer integração ativa, adiciona tag tools (sem duplicar)
  if (tools.length > 0 && !tools.find((t) => t.function.name === "helena_listar_tags")) {
    tools.push(...HELENA_TAG_TOOLS);
  }

  return tools;
}
