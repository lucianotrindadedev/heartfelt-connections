// Telemetria de custo de chamadas LLM AUXILIARES que rodam FORA do ciclo de meta
// da mensagem — resumos de escalação/notificação (pós-turn) e o resumo de Notes
// do Clinicorp (side-channel). Essas não pertencem ao cost_usd_estimate de uma
// mensagem específica; atribuí-las a uma seria mentira. Em vez disso viram uma
// linha [cost:telemetry] observável nos logs, para o custo real por conta não
// ficar invisível (o rag-gate e o splitter, que rodam DENTRO do turn, já são
// somados ao cost_usd_estimate).

export interface OpenRouterUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  cost?: number;
}

/** Emite uma linha [cost:telemetry] para uma chamada LLM auxiliar. No-op quando
 *  não houve usage (chamada falhou antes de cobrar). */
export function logAuxLlmCost(
  kind: string,
  model: string,
  usage: OpenRouterUsage | undefined,
): void {
  if (!usage) return;
  console.log(
    `[cost:telemetry] ${JSON.stringify({
      event: "aux_llm_cost",
      kind,
      model,
      cost_usd: usage.cost ?? 0,
      tokens_in: usage.prompt_tokens ?? 0,
      tokens_out: usage.completion_tokens ?? 0,
    })}`,
  );
}
