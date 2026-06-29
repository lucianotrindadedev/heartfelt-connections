// Server functions das automações de etiqueta (tag → ação).
//
// Cada agente tem N regras: "quando a etiqueta X estiver no contato, adicionar
// (ou remover) o contato na sequência Y". O disparo vem do webhook dedicado
// /api/public/webhook/helena-automation/$accountId. Ver tag-automations.server.ts.

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { getSelfhost } from "@/integrations/selfhost/client.server";
import {
  loadHelenaAccount,
  listHelenaTags,
  listHelenaSequences,
} from "@/lib/helena.server";

const ruleInputSchema = z.object({
  enabled: z.boolean().default(true),
  trigger_tag: z.string().min(1).max(200),
  action_type: z.enum(["add_to_sequence", "remove_from_sequence"]).default("add_to_sequence"),
  sequence_id: z.string().max(200).nullable().optional(),
  sequence_name: z.string().max(300).nullable().optional(),
});

// ── List ──────────────────────────────────────────────────────────────────

export const listTagAutomations = createServerFn({ method: "GET" })
  .inputValidator((d) => z.object({ agentId: z.string().uuid() }).parse(d))
  .handler(async ({ data }) => {
    const sb = getSelfhost();
    const res = await sb
      .from("agent_tag_automations")
      .select("id, enabled, trigger_tag, action_type, sequence_id, sequence_name")
      .eq("agent_id", data.agentId)
      .order("criado_em", { ascending: true });
    if (res.error) throw new Error(res.error.message);
    return { rules: res.data ?? [] };
  });

// ── Create ────────────────────────────────────────────────────────────────

export const createTagAutomation = createServerFn({ method: "POST" })
  .inputValidator((d) =>
    z.object({ agentId: z.string().uuid() }).merge(ruleInputSchema).parse(d),
  )
  .handler(async ({ data }) => {
    const sb = getSelfhost();
    const { agentId, ...payload } = data;
    const res = await sb
      .from("agent_tag_automations")
      .insert({ agent_id: agentId, ...payload })
      .select("id")
      .single();
    if (res.error) throw new Error(res.error.message);
    return { id: res.data.id as string };
  });

// ── Update ────────────────────────────────────────────────────────────────

export const updateTagAutomation = createServerFn({ method: "POST" })
  .inputValidator((d) =>
    z
      .object({ id: z.string().uuid() })
      .merge(ruleInputSchema.partial())
      .parse(d),
  )
  .handler(async ({ data }) => {
    const sb = getSelfhost();
    const { id, ...patch } = data;
    const res = await sb
      .from("agent_tag_automations")
      .update({ ...patch, atualizado_em: new Date().toISOString() })
      .eq("id", id);
    if (res.error) throw new Error(res.error.message);
    return { ok: true };
  });

// ── Delete ────────────────────────────────────────────────────────────────

export const deleteTagAutomation = createServerFn({ method: "POST" })
  .inputValidator((d) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data }) => {
    const sb = getSelfhost();
    const res = await sb.from("agent_tag_automations").delete().eq("id", data.id);
    if (res.error) throw new Error(res.error.message);
    return { ok: true };
  });

// ── Opções (tags + sequências) para os dropdowns da UI ────────────────────

export const listTagAutomationOptions = createServerFn({ method: "GET" })
  .inputValidator((d) => z.object({ accountId: z.string() }).parse(d))
  .handler(async ({ data }) => {
    const helena = await loadHelenaAccount(data.accountId).catch(() => null);
    if (!helena) {
      return {
        ok: false as const,
        error: "Conta do CRM Helena não configurada para essa account.",
        tags: [] as { id: string; name: string }[],
        sequences: [] as { id: string; name: string }[],
      };
    }

    const [tags, sequences] = await Promise.all([
      listHelenaTags(helena).catch(() => []),
      listHelenaSequences(helena).catch(() => []),
    ]);

    return { ok: true as const, tags, sequences };
  });
