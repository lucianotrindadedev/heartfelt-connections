// Read-only: por que a IA pediu o WhatsApp de novo (@wallaceblacklima, Clinica Bomfim).
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
const OUT = path.resolve(process.cwd(), "scripts", "diag", "last-report-wallace-passo.txt");
const R: string[] = [];
const log = (l = "") => { R.push(l); fs.writeFileSync(OUT, `${R.join("\n")}\n`, "utf8"); };
function loadEnv() {
  const txt = fs.readFileSync(path.resolve(process.cwd(), ".env.production"), "utf8");
  for (const line of txt.split(/\r?\n/)) {
    if (!line || line.startsWith("#") || !line.includes("=")) continue;
    const i = line.indexOf("="); const k = line.slice(0, i).trim();
    if (!process.env[k]) process.env[k] = line.slice(i + 1).trim().replace(/^["']|["']$/g, "");
  }
}
loadEnv();
const { getSelfhost } = await import("@/integrations/selfhost/client.server");
const { normalizeBrazilPhone } = await import("@/lib/conversation-channel.server");
const bt = await import("@/lib/booking-template");
const sb = getSelfhost();
const CONV = "885c504a-6788-4692-89a6-682bada476fd";
const AGENT = "7abeb085-b000-41ef-a12b-9604e30b4a6c";

describe("wallace-passo", () => {
  it("qual porta fechou", async () => {
    const { data: ag } = await sb.from("agents").select("configuracoes").eq("id", AGENT).maybeSingle();
    const settings = (ag?.configuracoes ?? {}) as Record<string, string>;
    const { data: raw } = await sb.from("messages").select("role, content, meta")
      .eq("conversation_id", CONV).order("criado_em", { ascending: true }).order("id", { ascending: true });

    // Historico como o orquestrador monta.
    const hist: { role: "user" | "assistant"; content: string }[] = [];
    let cut = -1;
    (raw ?? []).forEach((m, idx) => {
      const mm = (m.meta ?? {}) as Record<string, unknown>;
      if (idx === 9) cut = hist.length; // ANTES da entrega da resposta do turno [010]
      if (mm.fallback === true || mm.is_echo === true || !(m.content ?? "").trim()) return;
      hist.push({ role: m.role as "user" | "assistant", content: m.content as string });
    });
    const antes = hist.slice(0, cut);
    log(`### historico que o agente tinha no turno [010] (${antes.length} entradas)`);
    for (const h of antes) log(`  ${h.role}: ${JSON.stringify(h.content.slice(0, 90))}`);

    const ld = {} as never; // custom_fields vazio nesse ponto
    const channelCtx = { channel: "instagram" as const, effectivePhone: null };

    log(`\n### booking_fields configurados nesse agente`);
    log(`getBookingFields(settings) = ${JSON.stringify(bt.getBookingFields(settings))}`);
    log(`algum campo de telefone? ${bt.getBookingFields(settings).some((f: never) => bt.isPhoneRelatedBookingField(f))}`);

    log(`\n### bloco de prompt injetado no canal instagram`);
    log(JSON.stringify(bt.buildChannelPhonePromptBlock("instagram" as never, null)));

    log(`\n### captura deterministica do telefone`);
    log(`PORTA 1 — gate de estagio (so SLOT_OFFER/NAME_COLLECT/BOOKING). CORRIGIDO: roda em todo estagio.`);
    log(`   stage no turno [010] era RECEPTION, entao a captura nem chegava a ser chamada.`);
    const patchReal = bt.captureLeadPhoneFromHistory(ld, antes as never, settings, channelCtx as never, normalizeBrazilPhone);
    log(`PORTA 2 — leitura so da ultima msg do lead. CORRIGIDO: varre a rajada.`);
    log(`   captureLeadPhoneFromHistory com o historico REAL -> ${JSON.stringify(patchReal)}`);
    const ultimaLead = [...antes].reverse().find((m) => m.role === "user")!;
    log(`   ultima msg do LEAD que ela le: ${JSON.stringify(ultimaLead.content)}`);
    log(`   extrai telefone dela? ${JSON.stringify(normalizeBrazilPhone(ultimaLead.content))}`);

    // Contrafactual: sem a mensagem de ruido do WhatsApp/Helena.
    const semRuido = antes.filter((m) => !m.content.startsWith("*Atenção:*"));
    log(`\nCONTRAFACTUAL sem a msg "*Atenção:* o tipo da mensagem ... nao e suportado":`);
    log(`   ultima msg do lead = ${JSON.stringify([...semRuido].reverse().find((m) => m.role === "user")!.content)}`);
    log(`   captureLeadPhoneFromHistory -> ${JSON.stringify(bt.captureLeadPhoneFromHistory(ld, semRuido as never, settings, channelCtx as never, normalizeBrazilPhone))}`);

    log(`\n### checagens auxiliares`);
    log(`normalizeBrazilPhone("2198264-4836") = ${JSON.stringify(normalizeBrazilPhone("2198264-4836"))}`);
    log(`assistantAskedForPhone("...Seu telefone,...") = ${bt.assistantAskedForPhone("Oi! Que legal receber sua mensagem!! Para iniciarmos seu atendimento informe por favor: Seu nome, Seu telefone, E o que está acontecendo com o seu sorriso no momento?")}`);
    expect(true).toBe(true);
  }, 300_000);
});
