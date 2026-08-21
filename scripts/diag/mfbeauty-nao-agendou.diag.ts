// Read-only: por que os agendamentos de 21979968794 e 21971971008 (Central MF
// Beauty) nunca viraram evento na agenda. Reexecuta as funções PURAS de
// auto-seleção/travas contra o histórico real, no turno exato da confirmação.
//   npx vitest run --config scripts/diag/vitest.diag.config.ts scripts/diag/mfbeauty-nao-agendou.diag.ts
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const OUT = path.resolve(process.cwd(), "scripts", "diag", "last-report-mfbeauty.txt");
const REPORT: string[] = [];
function log(line = "") {
  REPORT.push(line);
  console.log(line);
  fs.writeFileSync(OUT, `${REPORT.join("\n")}\n`, "utf8");
}
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
const bt = await import("@/lib/booking-template");
const bf = await import("@/lib/agents/booking-failure");
const sb = getSelfhost();

const TELS = ["21979968794", "21971971008"];

describe("mf-beauty", () => {
  it("por que nao agendou", async () => {
    for (const TEL of TELS) {
      const { data: convs } = await sb
        .from("conversations")
        .select("id, agent_id, phone, meta")
        .or(`phone.like.%${TEL}%,lead_phone.like.%${TEL}%`)
        .order("atualizado_em", { ascending: false })
        .limit(1);
      const c = convs?.[0];
      if (!c) { log(`\n### ${TEL}: conversa nao encontrada`); continue; }
      const meta = c.meta as Record<string, unknown>;
      const leadData = (meta?.lead_data ?? {}) as Record<string, unknown>;

      const { data: agent } = await sb
        .from("agents").select("id, nome, configuracoes, account_id").eq("id", c.agent_id as string).maybeSingle();
      const settings = (agent?.configuracoes ?? {}) as Record<string, unknown>;

      const { data: msgs } = await sb
        .from("messages").select("role, content, criado_em, meta")
        .eq("conversation_id", c.id as string).order("criado_em", { ascending: true });

      // Histórico como o agente vê: só mensagens do lead + respostas do AGENTE
      // (origem=agente). Ecos/humano fora.
      const hist = (msgs ?? []).filter((m) => {
        const mm = (m.meta ?? {}) as Record<string, unknown>;
        return mm.origem === "lead" || mm.origem === "agente";
      }).map((m) => ({ role: m.role as "user" | "assistant", content: String(m.content ?? ""), meta: (m.meta ?? {}) as Record<string, unknown> }));

      // Turno da confirmação = resposta do AGENTE que afirma agendamento e tem tools=[]
      const idxConfirm = hist.findIndex((m) =>
        m.role === "assistant" && /ficou para/i.test(m.content) && Array.isArray(m.meta.tools_called) && (m.meta.tools_called as string[]).length === 0);

      log(`\n${"=".repeat(78)}`);
      log(`### ${TEL} — conv=${c.id} agente=${agent?.nome}`);
      log(`appointment_id no lead_data: ${JSON.stringify(leadData.appointment_id ?? null)}`);
      log(`selected_slot_iso final    : ${JSON.stringify(leadData.selected_slot_iso ?? null)}`);
      log(`booked_slot_iso final      : ${JSON.stringify(leadData.booked_slot_iso ?? null)}`);
      log(`booking_fields configurados: ${JSON.stringify(settings.booking_fields ?? settings.campos_agendamento ?? null)}`);

      if (idxConfirm < 0) { log("!! turno de confirmacao nao localizado"); continue; }
      const confirmMsg = hist[idxConfirm]!;
      const histAte = hist.slice(0, idxConfirm).map((m) => ({ role: m.role, content: m.content }));
      const lastUser = [...histAte].reverse().find((m) => m.role === "user")?.content ?? "";

      log(`\n-- turno da confirmacao --`);
      log(`ultima msg do LEAD que o auto-select enxerga: ${JSON.stringify(lastUser)}`);
      log(`resposta do agente: ${JSON.stringify(confirmMsg.content.slice(0, 200))}`);
      log(`tools_called: ${JSON.stringify(confirmMsg.meta.tools_called)}`);
      log(`telemetria de booking no meta: ${JSON.stringify(Object.fromEntries(Object.entries(confirmMsg.meta).filter(([k]) => /booking|confirmation|guard|preflight|escalat/.test(k))))}`);

      log(`\n-- reexecucao das funcoes puras --`);
      log(`isSlotAcceptanceMessage(lastUser) = ${bt.isSlotAcceptanceMessage(lastUser)}`);
      const det = bt.tryAutoSelectOfferedSlot("SLOT_OFFER", leadData as never, histAte as never);
      log(`tryAutoSelectOfferedSlot(...)     = ${JSON.stringify(det)}`);
      log(`claimsBookingConfirmed(resposta)  = ${bf.claimsBookingConfirmed(confirmMsg.content)}  <-- trava de confirmacao falsa`);

      // Mesma pergunta, mas com a mensagem de ESCOLHA do lead (não a última)
      const userMsgs = histAte.filter((m) => m.role === "user");
      const penult = userMsgs[userMsgs.length - 2]?.content ?? "";
      if (penult) {
        log(`\n-- e se o auto-select olhasse a penultima msg do lead? --`);
        log(`penultima = ${JSON.stringify(penult)}`);
        const hist2 = [...histAte];
        // remove a última msg do lead p/ simular "escolha foi a ultima"
        const li = hist2.map((m) => m.role).lastIndexOf("user");
        hist2.splice(li, 1);
        log(`tryAutoSelectOfferedSlot(sem a pergunta final) = ${JSON.stringify(bt.tryAutoSelectOfferedSlot("SLOT_OFFER", leadData as never, hist2 as never))}`);
      }
    }
    expect(true).toBe(true);
  }, 300_000);
});
