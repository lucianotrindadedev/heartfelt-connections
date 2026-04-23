import { logger } from "@sarai/shared";

/**
 * Fluxo 07 — Warm-up.
 * Para cada agente warmup ativo, busca appointment/list no Clinicorp
 * dos próximos 4 dias, calcula janela com tempo_wu1..5, dedupe via warmup_sent.
 */
export async function runWarmupTick() {
  logger.info("warmup tick (stub)");
  // TODO: implementar
}
