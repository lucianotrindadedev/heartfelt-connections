/** Modelo padrão OpenRouter para agentes, RAG gate, splitter e jobs auxiliares. */
export const DEFAULT_LLM_MODEL = "google/gemini-3.1-flash-lite";

/** Modelo para tool calling (scheduler: listar_horarios, criar_agendamento, etc.). */
export const DEFAULT_TOOL_MODEL = "openai/gpt-4.1-mini";

/** Fallback do tool loop quando o modelo de tools falha. */
export const DEFAULT_TOOL_FALLBACK_MODELS = [
  "openai/gpt-4o-mini",
  DEFAULT_LLM_MODEL,
] as const;

/** Slugs legados migrados automaticamente para {@link DEFAULT_LLM_MODEL}. */
export const LEGACY_GEMINI_FLASH_MODELS = [
  "google/gemini-2.5-flash",
  "google/gemini-2.5-flash-lite",
  "google/gemini-3.1-flash-lite-preview",
] as const;
