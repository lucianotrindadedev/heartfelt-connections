/** Modelo padrão OpenRouter para agentes, RAG gate, splitter e jobs auxiliares. */
export const DEFAULT_LLM_MODEL = "google/gemini-3.1-flash-lite";

/** Slugs legados migrados automaticamente para {@link DEFAULT_LLM_MODEL}. */
export const LEGACY_GEMINI_FLASH_MODELS = [
  "google/gemini-2.5-flash",
  "google/gemini-2.5-flash-lite",
  "google/gemini-3.1-flash-lite-preview",
] as const;
