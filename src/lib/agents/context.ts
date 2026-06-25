// Contexto que cada sub-agente recebe ao rodar. É um snapshot read-only
// montado pelo orchestrator. Sub-agentes nunca alteram o contexto diretamente
// — eles propõem mudanças via AgentResult.lead_data_patch / next_stage.

import type { ConversationChannel } from "@/lib/conversation-channel.server";
import type { HelenaContact } from "@/lib/helena.server";
import type { LeadData, Stage } from "./stage";

export interface AgentContext {
  /** IDs. */
  accountId: string;
  agentId: string;
  conversationId: string;
  sessionId?: string;

  /** Estado atual. */
  stage: Stage;
  leadData: LeadData;

  /** Identidade do lead. */
  conversationPhone: string;
  effectivePhone: string | null;
  channel: ConversationChannel;
  helenaContact: HelenaContact | null;

  /** Configuração textual da conta (preenchida pelo template). */
  agentSettings: Record<string, string>;
  /** Prompt customizado do usuário (system_prompt da tabela agents). */
  basePrompt: string;

  /** LLM. */
  model: string;
  /** Modelo do qualifier (responde RECEPTION/QUALIFICATION + decisoes de
   *  roteamento e tools de tag/midia). Por padrão = default_model configurado
   *  na conta; pode ser sobrescrito por account_llm_config.qualifier_model. */
  qualifierModel: string;
  /** Fallback do qualifier quando o modelo principal falha. Por padrão =
   *  fallback_models configurado na conta. */
  qualifierFallbackModels: string[];
  /** Modelo para tool calling no scheduler (separado do model de conversa/JSON). */
  toolModel: string;
  /** Fallback do tool loop do scheduler. */
  toolFallbackModels: string[];
  /** Cadeia de fallback: tentada em ordem se o `model` principal falhar
   *  (5xx, timeout, content vazio). Pode ser []. */
  fallbackModels: string[];
  /** Modelo barato usado pelo RAG Gate pra decidir se a msg precisa de busca. */
  ragGateModel: string;
  maxTokens: number;
  temperature: number;
  /** Chave OpenRouter já descriptografada. */
  orKey: string;

  /** Integrações disponíveis (true = habilitado). */
  integrations: {
    clinicorp: boolean;
    clinup: boolean;
    googleCalendar: boolean;
    escalation: boolean;
  };

  /** Agendas Google selecionadas (vazio = agenda única via calendar_id padrão).
   *  Com 2+ entradas, o scheduler injeta o parâmetro `agenda` (enum dos labels)
   *  e o agente escolhe qual usar conforme as regras do prompt. */
  googleAgendas: {
    label: string;
    calendarId: string;
    descricao?: string;
    duracaoMinutos?: number;
    businessHoursJson?: string;
    umaPorDia?: boolean;
    diasUmaPorDia?: string[];
    granularidadeMinutos?: number;
    bufferMinutos?: number;
    bufferDias?: string[];
    tituloTemplate?: string;
    descricaoTemplate?: string;
  }[];

  /** Histórico de mensagens já filtrado (sem fallbacks determinísticos). */
  history: { role: "user" | "assistant"; content: string }[];

  /** Modo treinador: pula efeitos colaterais (não aplica tags Helena, não
   *  cria eventos no GCal/Clinicorp). Usado para simular o agente sem tocar
   *  em nada externo. */
  dryRun?: boolean;

  /** Modo teste (settings.test_mode): desabilita SOMENTE a escrita de tags no
   *  CRM (interesse, status, "IA Desligada"). As ferramentas continuam vivas
   *  (agenda, mídia) — o objetivo é testar conversa + tools sem sujar o CRM.
   *  Diferente de dryRun, que também bloqueia tools/eventos. */
  disableTags?: boolean;
}

/** Resultado padronizado de um sub-agente. */
export interface AgentResult {
  /** Texto a ser entregue ao usuário. */
  reply: string;
  /** Próximo stage proposto (orchestrator valida e pode bloquear). */
  next_stage: Stage;
  /** Patch parcial em lead_data — campos undefined são preservados. */
  lead_data_patch?: Partial<LeadData>;
  /** Diagnóstico (não enviado ao usuário; só logging). */
  reasoning?: string;
  /** Marca esta reply como fallback determinístico (não vai para histórico da LLM). */
  is_fallback?: boolean;
  /** Tools executadas neste turn (para logging). */
  tools_called?: string[];
  /** Total de tokens de entrada consumidos em todas as chamadas LLM deste turn. */
  tokens_in?: number;
  /** Total de tokens de saída gerados em todas as chamadas LLM deste turn. */
  tokens_out?: number;
  /** Custo total em USD de todas as chamadas LLM deste turn (via usage.cost da OpenRouter). */
  cost_usd?: number;
  /**
   * Telemetria estruturada do turn (intervenções determinísticas, blocos,
   * sanitizers etc). Propagada do sub-agente até `messages.meta` no
   * orchestrator. Exemplos:
   *  - { preflight_blocked: true, dirty_fields: ["child_name"] }
   */
  telemetry?: Record<string, unknown>;
}
