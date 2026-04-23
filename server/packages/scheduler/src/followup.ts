import { logger } from "@sarai/shared";

/**
 * Fluxo 06 — Follow-up.
 * Query no índice parcial WHERE aguardando_followup = TRUE,
 * para cada conversa: chama agente followup → envia → incrementa contador.
 */
export async function runFollowupTick() {
  logger.info("followup tick (stub)");
  // TODO: implementar
}
