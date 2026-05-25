// Server functions da sequência de Follow-up.
//
// Cada agente tem N steps numerados (ordem 1, 2, 3, ...). Cada step define:
//   - quanto tempo após a interação anterior dispara
//   - se é mensagem fixa ou contextual (gerada por LLM)
//   - janela de horário e dias permitidos para envio

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { getSelfhost } from "@/integrations/selfhost/client.server";

const stepInputSchema = z.object({
  ordem: z.number().int().min(1).max(20),
  enabled: z.boolean().default(true),
  delay_value: z.number().int().min(1).max(10000),
  delay_unit: z.enum(["minutes", "hours", "days"]),
  mode: z.enum(["message", "contextual"]),
  message_text: z.string().max(2000).nullable().optional(),
  contextual_instruction: z.string().max(2000).nullable().optional(),
  window_start_hour: z.number().int().min(0).max(23).nullable().optional(),
  window_end_hour: z.number().int().min(0).max(23).nullable().optional(),
  allowed_days: z.array(z.string()).nullable().optional(),
});

// ── List ──────────────────────────────────────────────────────────────────

export const listFollowupSteps = createServerFn({ method: "GET" })
  .inputValidator((d) => z.object({ agentId: z.string().uuid() }).parse(d))
  .handler(async ({ data }) => {
    const sb = getSelfhost();
    const res = await sb
      .from("followup_steps")
      .select("*")
      .eq("agent_id", data.agentId)
      .order("ordem", { ascending: true });
    if (res.error) throw new Error(res.error.message);
    return { steps: res.data ?? [] };
  });

// ── Create ────────────────────────────────────────────────────────────────

export const createFollowupStep = createServerFn({ method: "POST" })
  .inputValidator((d) =>
    z
      .object({ agentId: z.string().uuid() })
      .merge(stepInputSchema)
      .parse(d),
  )
  .handler(async ({ data }) => {
    const sb = getSelfhost();
    const { agentId, ...payload } = data;
    const res = await sb
      .from("followup_steps")
      .insert({
        agent_id: agentId,
        ...payload,
      })
      .select("id")
      .single();
    if (res.error) throw new Error(res.error.message);
    return { id: res.data.id as string };
  });

// ── Update ────────────────────────────────────────────────────────────────

export const updateFollowupStep = createServerFn({ method: "POST" })
  .inputValidator((d) =>
    z
      .object({ id: z.string().uuid() })
      .merge(stepInputSchema.partial())
      .parse(d),
  )
  .handler(async ({ data }) => {
    const sb = getSelfhost();
    const { id, ...patch } = data;
    const res = await sb.from("followup_steps").update(patch).eq("id", id);
    if (res.error) throw new Error(res.error.message);
    return { ok: true };
  });

// ── Delete ────────────────────────────────────────────────────────────────

export const deleteFollowupStep = createServerFn({ method: "POST" })
  .inputValidator((d) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data }) => {
    const sb = getSelfhost();
    const res = await sb.from("followup_steps").delete().eq("id", data.id);
    if (res.error) throw new Error(res.error.message);
    return { ok: true };
  });

// ── Reorder (em lote) ─────────────────────────────────────────────────────

export const reorderFollowupSteps = createServerFn({ method: "POST" })
  .inputValidator((d) =>
    z
      .object({
        agentId: z.string().uuid(),
        order: z.array(z.object({ id: z.string().uuid(), ordem: z.number().int().min(1) })),
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    const sb = getSelfhost();
    // Atualiza um por um — a ordem é única por agente, então precisa cuidado.
    // Estratégia: primeiro joga todos para ordem negativa (temp), depois aplica final.
    for (const item of data.order) {
      const r1 = await sb
        .from("followup_steps")
        .update({ ordem: -item.ordem })
        .eq("id", item.id)
        .eq("agent_id", data.agentId);
      if (r1.error) throw new Error(r1.error.message);
    }
    for (const item of data.order) {
      const r2 = await sb
        .from("followup_steps")
        .update({ ordem: item.ordem })
        .eq("id", item.id)
        .eq("agent_id", data.agentId);
      if (r2.error) throw new Error(r2.error.message);
    }
    return { ok: true };
  });
