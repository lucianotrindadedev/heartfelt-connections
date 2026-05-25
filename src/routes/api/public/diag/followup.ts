// GET /api/public/diag/followup?secret=...&agent_id=<uuid>
//
// Diagnóstico da sequência de follow-up:
// - Lista pg_cron jobs com nome 'followup-sequence-tick'
// - Lista followup_steps do agente
// - Para cada conversa do agente, retorna o porquê de o próximo step
//   não estar disparando (ou se está pronto para disparar).
//
// Útil quando o usuário diz: "ativei follow-up, fiquei inativo, nada chegou".

import { createFileRoute } from "@tanstack/react-router";
import { getSelfhost } from "@/integrations/selfhost/client.server";

function validateSecret(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const url = new URL(request.url);
  return (
    request.headers.get("x-cron-secret") === secret ||
    url.searchParams.get("secret") === secret
  );
}

function delayToMs(value: number, unit: string): number {
  switch (unit) {
    case "minutes":
      return value * 60_000;
    case "hours":
      return value * 3_600_000;
    case "days":
      return value * 86_400_000;
    default:
      return value * 60_000;
  }
}

const WEEKDAY_MAP: Record<string, string> = {
  Sun: "dom", Mon: "seg", Tue: "ter", Wed: "qua",
  Thu: "qui", Fri: "sex", Sat: "sab",
};

function windowCheck(
  startH: number | null,
  endH: number | null,
  allowedDays: string[] | null,
  now: Date,
): { ok: boolean; reason?: string; hour: number; day: string } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Sao_Paulo",
    hour: "numeric",
    weekday: "short",
    hour12: false,
  }).formatToParts(now);
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
  const day = WEEKDAY_MAP[parts.find((p) => p.type === "weekday")?.value ?? ""] ?? "?";
  if (startH !== null && endH !== null && (hour < startH || hour >= endH)) {
    return { ok: false, reason: `fora da janela (${startH}h–${endH}h, agora ${hour}h)`, hour, day };
  }
  if (Array.isArray(allowedDays) && allowedDays.length > 0 && !allowedDays.includes(day)) {
    return { ok: false, reason: `dia ${day} não permitido (${allowedDays.join(",")})`, hour, day };
  }
  return { ok: true, hour, day };
}

export const Route = createFileRoute("/api/public/diag/followup")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        if (!validateSecret(request)) {
          return new Response("Unauthorized", { status: 401 });
        }
        const url = new URL(request.url);
        const agentId = url.searchParams.get("agent_id");
        const sb = getSelfhost();
        const now = new Date();

        // 1. pg_cron job
        type CronJob = { jobname: string; schedule: string; active: boolean; command: string };
        let cronJobs: CronJob[] = [];
        let cronErr: string | null = null;
        try {
          // Tenta via PostgREST RPC genérico; cron está em outro schema, geralmente exige RPC custom.
          // Fallback: consulta direta via supabase-js raw query através de from().select() não funciona
          // para cron.job. Tentamos via uma view se existir.
          const r = await sb.from("cron_jobs_view").select("*").limit(50);
          if (r.error) cronErr = r.error.message;
          else cronJobs = (r.data ?? []) as CronJob[];
        } catch (e) {
          cronErr = e instanceof Error ? e.message : String(e);
        }

        // 2. Steps
        let stepsQuery = sb
          .from("followup_steps")
          .select("*")
          .order("agent_id")
          .order("ordem", { ascending: true });
        if (agentId) stepsQuery = stepsQuery.eq("agent_id", agentId);
        const stepsRes = await stepsQuery;
        const steps = (stepsRes.data ?? []) as any[];

        if (!agentId) {
          return Response.json({
            ok: true,
            now: now.toISOString(),
            cron: { jobs: cronJobs, error: cronErr, hint: cronJobs.length === 0 ? "Crie view cron_jobs_view ou rode SELECT no cron.job manualmente no Supabase SQL Editor para confirmar." : null },
            steps_count: steps.length,
            steps_summary: steps.map((s) => ({
              id: s.id, agent_id: s.agent_id, ordem: s.ordem,
              enabled: s.enabled, mode: s.mode,
              delay: `${s.delay_value} ${s.delay_unit}`,
            })),
            hint: "Passe ?agent_id=<uuid> para análise por conversa.",
          });
        }

        // 3. Conversas do agente
        const convsRes = await sb
          .from("conversations")
          .select("id, phone, helena_session_id, channel")
          .eq("agent_id", agentId)
          .limit(200);
        const convs = (convsRes.data ?? []) as any[];

        const agentSteps = steps.filter((s) => s.enabled === true);
        if (agentSteps.length === 0) {
          return Response.json({
            ok: true, now: now.toISOString(), agent_id: agentId,
            verdict: "NENHUM step com enabled=true para este agente.",
            steps_all: steps,
          });
        }

        const analysis = [];
        for (const conv of convs) {
          const { data: lastMsg } = await sb
            .from("messages")
            .select("role, criado_em, content")
            .eq("conversation_id", conv.id)
            .order("criado_em", { ascending: false })
            .limit(1)
            .maybeSingle();
          if (!lastMsg) {
            analysis.push({ conv_id: conv.id, phone: conv.phone, skip: "sem mensagens" });
            continue;
          }
          if (lastMsg.role === "user") {
            analysis.push({
              conv_id: conv.id, phone: conv.phone,
              skip: "última msg é do user (lead ainda ativo, IA é quem responde)",
              last_msg_at: lastMsg.criado_em,
            });
            continue;
          }

          const lastMsgAt = new Date(lastMsg.criado_em as string);

          // Ciclo atual: começa após a última msg do lead (role=user)
          const { data: lastUserMsg } = await sb
            .from("messages")
            .select("criado_em")
            .eq("conversation_id", conv.id)
            .eq("role", "user")
            .order("criado_em", { ascending: false })
            .limit(1)
            .maybeSingle();
          const cycleStartAt = lastUserMsg
            ? new Date(lastUserMsg.criado_em as string)
            : new Date(0);

          const { data: alreadySent } = await sb
            .from("followup_step_runs")
            .select("step_id, sent_at, status")
            .eq("conversation_id", conv.id)
            .eq("status", "sent")
            .gt("sent_at", cycleStartAt.toISOString());
          const sentIds = new Set((alreadySent ?? []).map((r: any) => r.step_id));
          const pending = agentSteps.filter((s) => !sentIds.has(s.id));
          if (pending.length === 0) {
            analysis.push({
              conv_id: conv.id, phone: conv.phone,
              skip: "todos steps já enviados",
              already_sent: alreadySent,
            });
            continue;
          }
          const nextStep = pending[0];

          let anchorAt = lastMsgAt;
          if (alreadySent && alreadySent.length > 0) {
            const latest = (alreadySent as any[])
              .map((r) => new Date(r.sent_at))
              .sort((a, b) => b.getTime() - a.getTime())[0];
            if (latest > lastMsgAt) anchorAt = latest;
          }
          const delayMs = delayToMs(nextStep.delay_value, nextStep.delay_unit);
          const earliestSendAt = new Date(anchorAt.getTime() + delayMs);
          const win = windowCheck(
            nextStep.window_start_hour,
            nextStep.window_end_hour,
            nextStep.allowed_days,
            now,
          );

          const verdict: any = {
            conv_id: conv.id,
            phone: conv.phone,
            last_msg_at: lastMsgAt.toISOString(),
            anchor_at: anchorAt.toISOString(),
            next_step: {
              id: nextStep.id, ordem: nextStep.ordem, mode: nextStep.mode,
              delay: `${nextStep.delay_value} ${nextStep.delay_unit}`,
            },
            earliest_send_at: earliestSendAt.toISOString(),
            now: now.toISOString(),
            window: win,
          };
          if (now < earliestSendAt) {
            const minutesLeft = Math.ceil(
              (earliestSendAt.getTime() - now.getTime()) / 60_000,
            );
            verdict.status = `aguardando (faltam ~${minutesLeft} min)`;
          } else if (!win.ok) {
            verdict.status = `bloqueado: ${win.reason}`;
          } else {
            verdict.status = "PRONTO PARA ENVIAR — próximo tick do cron deve disparar.";
          }
          analysis.push(verdict);
        }

        return Response.json({
          ok: true,
          now: now.toISOString(),
          agent_id: agentId,
          cron: { jobs: cronJobs, error: cronErr },
          enabled_steps_count: agentSteps.length,
          conversations_count: convs.length,
          analysis,
        });
      },
    },
  },
});
