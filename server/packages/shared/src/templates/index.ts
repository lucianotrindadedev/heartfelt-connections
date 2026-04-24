// Templates are now stored in the database (agent_templates table).
// This module provides a fallback for code that still references static templates.

export { agentTemplates } from "../db/schema";

// Legacy compatibility - will be removed once all code uses DB templates
export const templates = {} as Record<string, any>;
