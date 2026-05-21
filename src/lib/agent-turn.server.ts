// Shim de compatibilidade. A lógica real do turn vive em
// src/lib/agents/orchestrator.server.ts (arquitetura multi-agente).
//
// Mantemos este arquivo apenas para que imports antigos
// (`import { runAgentTurn, ConversationLockedError } from "@/lib/agent-turn.server"`)
// continuem funcionando sem precisar refatorar message-queue, schedule-agent-turn,
// drain-conversation, etc.
export { runAgentTurn, ConversationLockedError } from "@/lib/agents/orchestrator.server";
