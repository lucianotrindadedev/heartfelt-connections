// Read-only: (21) 98746-4703 / Odonto Carioca Campo Grande, 24/08/2026.
// Reexecuta as funcoes PURAS do codigo de origin/main (o que esta em producao)
// contra o historico real, nos turnos exatos em que a IA re-ofertou horario.
//   npx vitest run --config scripts/diag/vitest.diag.config.ts scripts/diag/odonto-carioca-horarios.diag.ts
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const OUT = path.resolve(process.cwd(), "scripts", "diag", "last-report-odonto.txt");
const REPORT: string[] = [];
function log(line = "") {
  REPORT.push(line);
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

const CONV = "144aa7f0-b7eb-49d9-be8e-d10ee896dc36";

type Row = { role: string; content: string; meta: Record<string, unknown> };

describe("odonto-carioca", () => {
  it("por que re-ofertou", async () => {
    const { data: c } = await sb.from("conversations").select("meta").eq("id", CONV).single();
    const leadData = ((c?.meta as Record<string, unknown>)?.lead_data ?? {}) as Record<string, unknown>;
    const slots = leadData.offered_slots as { iso: string; date_label: string; time_label: string }[];

    const { data: raw } = await sb
      .from("messages").select("role, content, meta")
      .eq("conversation_id", CONV)
      .order("criado_em", { ascending: true }).order("id", { ascending: true });

    // Historico EXATAMENTE como o orquestrador monta (orchestrator.server.ts:435):
    // descarta fallback, descarta is_echo, descarta vazio. NAO descarta origem=humano.
    const rows = (raw ?? []) as unknown as Row[];
    const hist: { role: "user" | "assistant"; content: string; origem: string; idx: number }[] = [];
    rows.forEach((m, idx) => {
      const mm = m.meta ?? {};
      if (mm.fallback === true) return;
      if (mm.is_echo === true) return;
      if (!(m.content ?? "").trim()) return;
      hist.push({ role: m.role as "user" | "assistant", content: m.content, origem: String(mm.origem ?? "?"), idx });
    });

    log(`offered_slots finais (${slots.length}):`);
    for (const s of slots) log(`   ${s.date_label} ${s.time_label}  ${s.iso}`);
    log(`selected_slot_iso final: ${JSON.stringify(leadData.selected_slot_iso)}`);
    log(`name final: ${JSON.stringify(leadData.name)}  hasSurname=${bt.hasSurname(String(leadData.name ?? ""))}`);

    // ── TURNO [054]: lead disse "As 13h" depois da oferta 25/08 12:30 ou 13:00 ──
    const cut = hist.findIndex((h) => h.idx === 54);
    const antes = hist.slice(0, cut).map((h) => ({ role: h.role, content: h.content }));
    log(`\n${"=".repeat(78)}`);
    log(`TURNO [054] — o agente respondeu "Pra fechar certinho: 12:30 ou 12:45"`);
    log(`booking_error registrado: "selected_slot_iso ausente"`);
    log(`\nultimas 8 entradas do historico que o agente enxergou:`);
    for (const h of hist.slice(cut - 8, cut)) {
      log(`  [${h.idx}] ${h.role}/${h.origem}: ${JSON.stringify(h.content.slice(0, 110))}`);
    }
    const ld054 = { ...leadData, selected_slot_iso: "" } as never;
    log(`\n-- reexecucao (codigo origin/main = producao) --`);
    log(`isSlotAcceptanceMessage("As 13h")  = ${bt.isSlotAcceptanceMessage("As 13h")}`);
    log(`slotsOfferedInLastTurn(...)        = ${JSON.stringify(bt.slotsOfferedInLastTurn(ld054, antes as never).map((s: {date_label:string;time_label:string}) => `${s.date_label} ${s.time_label}`))}`);
    log(`tryAutoSelectOfferedSlot(SLOT_OFFER) = ${JSON.stringify(bt.tryAutoSelectOfferedSlot("SLOT_OFFER", ld054, antes as never))}`);

    // CONTRAFACTUAL: sem as mensagens digitadas pela RECEPCAO humana entre a
    // oferta do agente e a resposta da lead (indices 48,49,50).
    const semHumano = hist
      .slice(0, cut)
      .filter((h) => !(h.role === "assistant" && h.origem === "humano"))
      .map((h) => ({ role: h.role, content: h.content }));
    log(`\n-- contrafactual: mesmo turno SEM as msgs da recepcao humana --`);
    log(`slotsOfferedInLastTurn(...)          = ${JSON.stringify(bt.slotsOfferedInLastTurn(ld054, semHumano as never).map((s: {date_label:string;time_label:string}) => `${s.date_label} ${s.time_label}`))}`);
    log(`tryAutoSelectOfferedSlot(SLOT_OFFER) = ${JSON.stringify(bt.tryAutoSelectOfferedSlot("SLOT_OFFER", ld054, semHumano as never))}`);

    // ── A re-oferta que o lead recebeu vem de buildReofferReply ──
    log(`\n-- de onde saiu o texto da re-oferta --`);
    log(`buildReofferReply(offered_slots) = ${JSON.stringify(bf.buildReofferReply(slots as never))}`);

    // ── TURNO [026]: pergunta do sobrenome ──
    log(`\n${"=".repeat(78)}`);
    log(`TURNO [026] — "Desculpa insistir! So me confirma o sobrenome do Adriana"`);
    log(`A lead ja tinha mandado "Adriana Amazonas de Araujo" em [015], 10 min antes.`);
    log(`hasSurname("Adriana Amazonas de Araújo") = ${bt.hasSurname("Adriana Amazonas de Araújo")}`);
    log(`looksLikeSentenceNotName(...)            = ${bt.looksLikeSentenceNotName("Adriana Amazonas de Araújo")}`);
    expect(true).toBe(true);
  }, 600_000);
});
