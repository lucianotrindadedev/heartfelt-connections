// Server functions para gerenciar o auto-distillation de FAQs:
// listar pending/quarantine, aprovar/rejeitar/editar, toggle config.

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { getSelfhost } from "@/integrations/selfhost/client.server";

// ── Lista FAQs auto-distilled (pending, quarantine, recém-aprovadas) ──

export const listDistilledFaqs = createServerFn({ method: "GET" })
  .inputValidator((d) =>
    z
      .object({
        agentId: z.string().uuid(),
        status: z.enum(["all", "auto_pending", "quarantine", "approved", "rejected"]).default("all"),
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    const sb = getSelfhost();
    let q = sb
      .from("knowledge_documents")
      .select(
        "id, title, distilled_question, content_preview, confidence, frequency, " +
          "pii_detected, review_status, quarantine_until, criado_em",
      )
      .eq("agent_id", data.agentId)
      .eq("source_type", "auto_distilled")
      .order("criado_em", { ascending: false })
      .limit(100);
    if (data.status !== "all") q = q.eq("review_status", data.status);
    const res = await q;
    if (res.error) throw new Error(res.error.message);
    return { faqs: res.data ?? [] };
  });

// ── Aprovar (mover de pending/quarantine pra approved) ────────────────

export const approveDistilledFaq = createServerFn({ method: "POST" })
  .inputValidator((d) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data }) => {
    const sb = getSelfhost();
    const res = await sb
      .from("knowledge_documents")
      .update({ review_status: "approved", quarantine_until: null })
      .eq("id", data.id);
    if (res.error) throw new Error(res.error.message);
    return { ok: true };
  });

// ── Rejeitar (mantém o registro pro audit, mas não retorna na busca) ──

export const rejectDistilledFaq = createServerFn({ method: "POST" })
  .inputValidator((d) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data }) => {
    const sb = getSelfhost();
    const res = await sb
      .from("knowledge_documents")
      .update({ review_status: "rejected", quarantine_until: null })
      .eq("id", data.id);
    if (res.error) throw new Error(res.error.message);
    return { ok: true };
  });

// ── Editar a resposta antes de aprovar ────────────────────────────────

export const editDistilledFaq = createServerFn({ method: "POST" })
  .inputValidator((d) =>
    z
      .object({
        id: z.string().uuid(),
        title: z.string().min(1).max(200).optional(),
        chunk_text: z.string().min(10).max(10000),
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    const sb = getSelfhost();
    // Atualiza chunk_text (1 chunk por FAQ)
    const upd1 = await sb
      .from("knowledge_chunks")
      .update({ chunk_text: data.chunk_text })
      .eq("document_id", data.id);
    if (upd1.error) throw new Error(upd1.error.message);

    const updDoc: Record<string, unknown> = {
      content_preview: data.chunk_text.slice(0, 500),
      total_chars: data.chunk_text.length,
    };
    if (data.title) updDoc.title = data.title;

    const upd2 = await sb
      .from("knowledge_documents")
      .update(updDoc)
      .eq("id", data.id);
    if (upd2.error) throw new Error(upd2.error.message);

    return { ok: true };
  });

// ── Toggle distillation_enabled e atualizar config por agente ──────────

export const updateDistillationConfig = createServerFn({ method: "POST" })
  .inputValidator((d) =>
    z
      .object({
        agentId: z.string().uuid(),
        distillation_enabled: z.boolean().optional(),
        distillation_min_frequency: z.number().int().min(1).max(100).optional(),
        distillation_min_confidence: z.number().min(0).max(1).optional(),
        distillation_quarantine_hours: z.number().int().min(0).max(168).optional(),
        distillation_max_auto_approve_per_run: z.number().int().min(0).max(50).optional(),
        distillation_schedule: z.enum(["weekly", "daily", "manual"]).optional(),
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    const sb = getSelfhost();
    const { agentId, ...patch } = data;
    if (Object.keys(patch).length === 0) return { ok: true };
    const res = await sb.from("agents").update(patch).eq("id", agentId);
    if (res.error) throw new Error(res.error.message);
    return { ok: true };
  });

// ── Lê config atual ──────────────────────────────────────────────────

export const getDistillationConfig = createServerFn({ method: "GET" })
  .inputValidator((d) => z.object({ agentId: z.string().uuid() }).parse(d))
  .handler(async ({ data }) => {
    const sb = getSelfhost();
    const res = await sb
      .from("agents")
      .select(
        "distillation_enabled, distillation_min_frequency, distillation_min_confidence, " +
          "distillation_quarantine_hours, distillation_max_auto_approve_per_run, distillation_schedule",
      )
      .eq("id", data.agentId)
      .single();
    if (res.error) throw new Error(res.error.message);
    return res.data;
  });

// ── Histórico de runs ─────────────────────────────────────────────────

export const listDistillationRuns = createServerFn({ method: "GET" })
  .inputValidator((d) => z.object({ agentId: z.string().uuid() }).parse(d))
  .handler(async ({ data }) => {
    const sb = getSelfhost();
    const res = await sb
      .from("knowledge_distillation_runs")
      .select("*")
      .eq("agent_id", data.agentId)
      .order("started_at", { ascending: false })
      .limit(20);
    if (res.error) throw new Error(res.error.message);
    return { runs: res.data ?? [] };
  });
