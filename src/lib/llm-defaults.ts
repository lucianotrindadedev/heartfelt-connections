/** Modelo padrão OpenRouter para agentes, RAG gate, splitter e jobs auxiliares. */
export const DEFAULT_LLM_MODEL = "google/gemini-2.5-flash";

/** Modelo para tool calling (scheduler: listar_horarios, criar_agendamento, etc.). */
export const DEFAULT_TOOL_MODEL = "openai/gpt-4.1-mini";

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

/** Slugs legados migrados automaticamente para {@link DEFAULT_LLM_MODEL}. */
export const LEGACY_GEMINI_FLASH_MODELS = [
  "google/gemini-2.5-flash-lite",
  "google/gemini-3.1-flash-lite",
  "google/gemini-3.1-flash-lite-preview",
] as const;
