// DIAGNÓSTICO (somente leitura) do warm-up com fonte Clinup.
//
//   npx vitest run --config scripts/diag/vitest.diag.config.ts scripts/diag/warmup-clinup.diag.ts
//
// Lista as consultas da conta pela fonte nova (GET /consultas/pesquisa),
// calcula para cada step do agente quando o lembrete sairia (já com o horário
// de envio 06:00–20:00) e tenta achar a conversa/sessão como o cron faria.
// NÃO envia nada e NÃO grava warmup_sends.

import fs from "node:fs";
import path from "node:path";
import { it } from "vitest";

function loadEnv() {
  const txt = fs.readFileSync(path.resolve(process.cwd(), ".env.production"), "utf8");
  for (const l of txt.split(/\r?\n/)) {
    if (!l || l.startsWith("#") || !l.includes("=")) continue;
    const i = l.indexOf("=");
    const k = l.slice(0, i).trim();
    if (!process.env[k]) process.env[k] = l.slice(i + 1).trim().replace(/^["']|["']$/g, "");
  }
}
loadEnv();

const OUT: string[] = [];
const log = (l = "") => { OUT.push(l); console.log(l); };
const REPORT = path.resolve(process.cwd(), "scripts", "diag", "last-report-warmup-clinup.txt");

const ACCOUNT = process.env.DIAG_ACCOUNT ?? "6dabbad9-32f9-415f-8003-9eacac9634f3"; // Implanto Master VN

it("warm-up Clinup — ensaio seco", async () => {
  const { getSelfhost } = await import("@/integrations/selfhost/client.server");
  const { listAllUpcomingAppointments } = await import("@/lib/warmup/sources.server");
  const { effectiveWarmupSendAt } = await import("@/lib/warmup/send-window");
  const sb = getSelfhost();

  const { data: agent } = await sb.from("agents").select("id").eq("account_id", ACCOUNT).single();
  const { data: steps } = await sb
    .from("warmup_steps")
    .select("ordem, time_before_value, time_before_unit, helena_template_name, enabled")
    .eq("agent_id", agent!.id)
    .eq("enabled", true)
    .order("ordem");

  const now = new Date();
  const appts = (await listAllUpcomingAppointments(ACCOUNT, now, new Date(now.getTime() + 7 * 86_400_000)))
    .filter((a) => a.source === "clinup")
    .sort((a, b) => a.start.getTime() - b.start.getTime());
  const br = (d: Date) =>
    d.toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
  const unitMs: Record<string, number> = { minutes: 60_000, hours: 3_600_000, days: 86_400_000 };

  log(`\nconsultas Clinup nos próximos 7 dias (situação 3/4/5): ${appts.length}`);
  let comConversa = 0, semConversa = 0, semTelefone = 0;
  for (const a of appts) {
    // conversa: por appointment_id; senão pelo telefone (buscado sob demanda)
    let via = "";
    const byAppt = await sb.from("conversations").select("id").eq("agent_id", agent!.id)
      .eq("meta->lead_data->>appointment_id", a.externalId).not("helena_session_id", "is", null).limit(1).maybeSingle();
    if (byAppt.data) via = "appointment_id";
    else {
      const phone = a.resolvePhone ? await a.resolvePhone() : a.patientPhone;
      if (!phone) { via = "SEM TELEFONE no Clinup"; semTelefone++; }
      else {
        const v = new Set([phone]);
        if (phone.length === 11 && phone[2] === "9") v.add(phone.slice(0, 2) + phone.slice(3));
        const byPhone = await sb.from("conversations").select("id").eq("agent_id", agent!.id)
          .in("phone", [...v]).not("helena_session_id", "is", null).limit(1).maybeSingle();
        via = byPhone.data ? "telefone" : "sem conversa conosco (n8n criaria o contato)";
      }
    }
    if (via === "appointment_id" || via === "telefone") comConversa++; else if (!via.startsWith("SEM")) semConversa++;
    const plano = (steps ?? []).map((s) => {
      const raw = new Date(a.start.getTime() - s.time_before_value * (unitMs[s.time_before_unit] ?? 3_600_000));
      const eff = effectiveWarmupSendAt(raw, a.start);
      const tag = !eff ? "não sai" : eff.getTime() !== raw.getTime() ? `${br(eff)} (adiado de ${br(raw)})` : br(eff);
      return `${s.helena_template_name}: ${tag}`;
    });
    log(`  ${br(a.start)} consulta ${a.externalId} sit=${a.status} | conversa: ${via}\n      ${plano.join(" | ")}`);
  }
  log(`\nresumo: com conversa ${comConversa} | sem conversa ${semConversa} | sem telefone ${semTelefone}`);
  fs.writeFileSync(REPORT, OUT.join("\n"));
});
