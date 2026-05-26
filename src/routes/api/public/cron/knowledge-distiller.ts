// POST /api/public/cron/knowledge-distiller
//
// Tick diário 03:00 BRT. Decide quais agentes processar baseado em:
//   - distillation_enabled = true
//   - distillation_schedule != 'manual'
//   - última run em (knowledge_distillation_runs) respeita o intervalo
//     do schedule ('daily' = 23h, 'weekly' = 6 dias)
//
// Para cada agente elegível, chama runDistillationForAgent.
// Log de cada execução vai pra knowledge_distillation_runs.

import { createFileRoute } from "@tanstack/react-router";
import { getSelfhost } from "@/integrations/selfhost/client.server";
import { runDistillationForAgent, loadOrKey } from "@/lib/knowledge/distiller.server";

function validateCronSecret(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  return request.headers.get("x-cron-secret") === secret;
}

interface AgentRow {
  id: string;
  account_id: string;
  ativo: boolean;
  distillation_enabled: boolean;
  distillation_min_frequency: number;
  distillation_min_confidence: number;
  distillation_quarantine_hours: number;
  distillation_max_auto_approve_per_run: number;
  distillation_schedule: "weekly" | "daily" | "manual";
}

export const Route = createFileRoute("/api/public/cron/knowledge-distiller")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        if (!validateCronSecret(request)) {
          return new Response("Unauthorized", { status: 401 });
        }

        const sb = getSelfhost();
        const now = new Date();

        // 1. Carrega agentes com distillation habilitado
        const { data: agents, error: agErr } = await sb
          .from("agents")
          .select(
            "id, account_id, ativo, distillation_enabled, distillation_min_frequency, " +
              "distillation_min_confidence, distillation_quarantine_hours, " +
              "distillation_max_auto_approve_per_run, distillation_schedule",
          )
          .eq("distillation_enabled", true)
          .eq("ativo", true)
          .neq("distillation_schedule", "manual");
        if (agErr) {
          return Response.json({ ok: false, error: agErr.message }, { status: 500 });
        }
        if (!agents?.length) {
          return Response.json({ ok: true, processed: 0, reason: "no eligible agents" });
        }

        const summaries: Array<Record<string, unknown>> = [];

        for (const a of agents as AgentRow[]) {
          // 2. Verifica se está na janela do schedule
          const lastRun = await sb
            .from("knowledge_distillation_runs")
            .select("started_at, status")
            .eq("agent_id", a.id)
            .order("started_at", { ascending: false })
            .limit(1)
            .maybeSingle();
          if (lastRun.data) {
            const last = new Date(lastRun.data.started_at as string);
            const hoursSince = (now.getTime() - last.getTime()) / 3_600_000;
            const minHours = a.distillation_schedule === "daily" ? 23 : 144; // 6 dias para weekly
            if (hoursSince < minHours) {
              summaries.push({
                agent_id: a.id,
                skipped: `ultima run ha ${hoursSince.toFixed(1)}h (< ${minHours}h)`,
              });
              continue;
            }
          }

          // 3. OpenRouter key
          const orKey = await loadOrKey(a.account_id);
          if (!orKey) {
            summaries.push({ agent_id: a.id, skipped: "sem openrouter key" });
            continue;
          }

          // 4. Modelo: usa rag_gate_model (já é barato — Gemini Flash)
          const llmCfg = await sb
            .from("account_llm_config")
            .select("rag_gate_model")
            .eq("account_id", a.account_id)
            .single();
          const model =
            (llmCfg.data?.rag_gate_model as string | undefined) ?? "google/gemini-2.5-flash";

          // 5. Janela de tempo: 7 dias atrás (weekly) ou 1 dia (daily)
          const sinceHours = a.distillation_schedule === "daily" ? 24 : 7 * 24;
          const sinceISO = new Date(now.getTime() - sinceHours * 3_600_000).toISOString();

          // 6. Cria run record
          const runIns = await sb
            .from("knowledge_distillation_runs")
            .insert({
              agent_id: a.id,
              account_id: a.account_id,
              started_at: now.toISOString(),
              status: "running",
            })
            .select("id")
            .single();
          const runId = runIns.data?.id as string | undefined;

          // 7. Executa distillation
          try {
            const result = await runDistillationForAgent({
              accountId: a.account_id,
              agentId: a.id,
              orKey,
              model,
              config: {
                min_frequency: a.distillation_min_frequency,
                min_confidence: a.distillation_min_confidence,
                quarantine_hours: a.distillation_quarantine_hours,
                max_auto_approve_per_run: a.distillation_max_auto_approve_per_run,
              },
              sinceISO,
            });

            if (runId) {
              await sb
                .from("knowledge_distillation_runs")
                .update({
                  finished_at: new Date().toISOString(),
                  conversations_scanned: result.conversations_scanned,
                  q_and_a_pairs: result.q_and_a_pairs,
                  clusters_found: result.clusters_found,
                  faqs_extracted: result.faqs_extracted,
                  faqs_auto_approved: result.faqs_auto_approved,
                  faqs_pending: result.faqs_pending,
                  faqs_duplicates: result.faqs_duplicates,
                  faqs_pii_blocked: result.faqs_pii_blocked,
                  cost_usd: result.cost_usd,
                  tokens_in: result.tokens_in,
                  tokens_out: result.tokens_out,
                  status: "success",
                })
                .eq("id", runId);
            }

            summaries.push({ agent_id: a.id, ...result });
            console.log(`[distiller] agent=${a.id}`, result);
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            console.error(`[distiller] agent=${a.id} falhou:`, msg);
            if (runId) {
              await sb
                .from("knowledge_distillation_runs")
                .update({
                  finished_at: new Date().toISOString(),
                  status: "failed",
                  error: msg.slice(0, 500),
                })
                .eq("id", runId);
            }
            summaries.push({ agent_id: a.id, error: msg.slice(0, 200) });
          }
        }

        return Response.json({ ok: true, processed: summaries.length, summaries });
      },
    },
  },
});
