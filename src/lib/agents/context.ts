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

  /** Histórico de mensagens já filtrado (sem fallbacks determinísticos). */
  history: { role: "user" | "assistant"; content: string }[];
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
}
