/** Modelo padrão OpenRouter para agentes, RAG gate, splitter e jobs auxiliares. */
export const DEFAULT_LLM_MODEL = "google/gemini-2.5-flash";

/** Modelo para tool calling (scheduler: listar_horarios, criar_agendamento, etc.). */
export const DEFAULT_TOOL_MODEL = "openai/gpt-4.1-mini";

/**
 * Configuração de LLM padrão de NOVOS agentes/contas (account_llm_config).
 * Mantida em sincronia com a migração 0034. Usada no insert da criação do
 * agente para garantir os defaults mesmo sem depender do default da coluna.
 */
export const DEFAULT_ACCOUNT_LLM_CONFIG = {
  default_model: "google/gemini-3.5-flash",
  splitter_model: "openai/gpt-4.1-mini",
  formatter_model: "openai/gpt-4.1-mini",
  rag_gate_model: "openai/gpt-4.1-mini",
  tool_model: "openai/gpt-4.1-mini",
  fallback_models: ["openai/gpt-4.1-mini"],
} as const;

/**
 * Modelo dedicado ao qualifier. O qualifier toma decisoes de roteamento
 * (next_stage, aplicar_tag_interesse, enviar_midia) e segue regras nuance
 * — por isso precisa de um modelo mais robusto em instructions-following
 * que o reply genérico. Pode ser sobrescrito por conta via
 * `account_llm_config.qualifier_model`.
 */
export const DEFAULT_QUALIFIER_MODEL = "openai/gpt-4o-mini";

/** Fallback do qualifier quando o modelo principal falha. */
export const DEFAULT_QUALIFIER_FALLBACK_MODELS = [
  "anthropic/claude-haiku-4.5",
  DEFAULT_LLM_MODEL,
] as const;

/** Fallback do tool loop quando o modelo de tools falha. */
export const DEFAULT_TOOL_FALLBACK_MODELS = [
  "openai/gpt-4o-mini",
  DEFAULT_LLM_MODEL,
] as const;

/** Modelo padrão do splitter de mensagens (divide a resposta em bolhas).
 *  GPT-4.1-mini é rápido e estável em JSON curto — o gemini-flash travava aqui
 *  (gastava o output em "pensamento" e estourava o timeout). Pode ser
 *  sobrescrito por conta via account_llm_config.splitter_model. */
export const DEFAULT_SPLITTER_MODEL = "openai/gpt-4.1-mini";

/** Fallback rápido para chamadas auxiliares (RAG-gate, splitter). Quando o
 *  modelo principal dessas tarefas trava/timeout, tenta um modelo rápido antes
 *  de cair no comportamento degradado (RAG: need=true; splitter: regras). */
export const DEFAULT_AUX_FALLBACK_MODEL = "openai/gpt-4o-mini";

/** Slugs legados migrados automaticamente para {@link DEFAULT_LLM_MODEL}. */
export const LEGACY_GEMINI_FLASH_MODELS = [
  "google/gemini-2.5-flash-lite",
  "google/gemini-3.1-flash-lite",
  "google/gemini-3.1-flash-lite-preview",
] as const;
