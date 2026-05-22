// Normaliza JSON estruturado dos sub-agentes antes do Zod.
// Modelos frequentemente enviam lead_data_patch com campos null em vez de omitir.

export function stripNullishFields(
  obj: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  if (!obj || typeof obj !== "object") return {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== null && v !== undefined) out[k] = v;
  }
  return out;
}

/** Remove nulls de lead_data_patch no payload { reply, next_stage, lead_data_patch }. */
export function sanitizeStructuredAgentJson(raw: unknown): unknown {
  if (!raw || typeof raw !== "object") return raw;
  const o = raw as Record<string, unknown>;
  if (!o.lead_data_patch || typeof o.lead_data_patch !== "object") return raw;
  return {
    ...o,
    lead_data_patch: stripNullishFields(o.lead_data_patch as Record<string, unknown>),
  };
}
