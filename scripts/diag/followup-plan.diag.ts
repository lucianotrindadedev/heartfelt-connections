// Read-only: simula o novo planejamento do cron de follow-up contra produção.
//   npx vitest run --config scripts/diag/vitest.diag.config.ts scripts/diag/followup-plan.diag.ts
// Opcional: DIAG_AGENT=<uuid> limita a um agente.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

function loadEnv() {
  const txt = fs.readFileSync(path.resolve(process.cwd(), ".env.production"), "utf8");
  for (const line of txt.split(/\r?\n/)) {
    if (!line || line.startsWith("#") || !line.includes("=")) continue;
    const i = line.indexOf("=");
    const k = line.slice(0, i).trim();
    if (!process.env[k]) process.env[k] = line.slice(i + 1).trim().replace(/^["']|["']$/g, "");
  }
}
loadEnv();

const { getSelfhost } = await import("@/integrations/selfhost/client.server");
const plan = await import("@/lib/followup-plan");
const sb = getSelfhost();

describe("followup-plan", () => {
  it("simula um tick", async () => {
    const now = new Date();
    let q = sb.from("followup_steps").select("*").eq("enabled", true).order("ordem");
    if (process.env.DIAG_AGENT) q = q.eq("agent_id", process.env.DIAG_AGENT);
    const { data: steps } = await q;
    const byAgent = new Map<string, plan.PlanStep[]>();
    for (const s of steps ?? []) {
      const arr = byAgent.get(s.agent_id as string) ?? [];
      arr.push(s as unknown as plan.PlanStep);
      byAgent.set(s.agent_id as string, arr);
    }
    for (const [agentId, agentSteps] of byAgent) {
      const cutoff = plan.agentNeedsStaleConversations(agentSteps)
        ? null
        : new Date(now.getTime() - plan.WHATSAPP_WINDOW_MS).toISOString();
      let cq = sb.from("conversations").select("id, meta").eq("agent_id", agentId);
      if (cutoff) cq = cq.gte("atualizado_em", cutoff);
      const { data: convs } = await cq.order("criado_em", { ascending: false }).range(0, 999);
      const count: Record<string, number> = {};
      for (const c of convs ?? []) {
        const meta = (c.meta ?? {}) as { stage?: string; lead_data?: { appointment_id?: unknown } };
        if (meta.lead_data?.appointment_id != null || ["CONFIRMED", "ESCALATED"].includes(meta.stage ?? "")) continue;
        const { data: last } = await sb.from("messages").select("role, criado_em").eq("conversation_id", c.id).order("criado_em", { ascending: false }).limit(1).maybeSingle();
        if (!last || last.role === "user") continue;
        const { data: lu } = await sb.from("messages").select("criado_em").eq("conversation_id", c.id).eq("role", "user").order("criado_em", { ascending: false }).limit(1).maybeSingle();
        const cycleStartAt = lu ? new Date(lu.criado_em as string) : new Date(0);
        const { data: sent } = await sb.from("followup_step_runs").select("step_id, sent_at").eq("conversation_id", c.id).eq("status", "sent").gt("sent_at", cycleStartAt.toISOString());
        const d = plan.planFollowupStep({
          steps: agentSteps,
          sentInCycle: (sent ?? []) as plan.PlanSentRun[],
          lastMsgAt: new Date(last.criado_em as string),
          cycleStartAt,
          now,
        });
        count[d.kind] = (count[d.kind] ?? 0) + 1;
      }
      fs.appendFileSync(
        path.resolve(process.cwd(), "scripts", "diag", "last-report-followup-plan.txt"),
        `${agentId} conversas lidas=${convs?.length ?? 0} ${JSON.stringify(count)}\n`,
      );
    }
    expect(true).toBe(true);
  }, 600_000);
});
