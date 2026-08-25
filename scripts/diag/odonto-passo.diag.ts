import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
const OUT = path.resolve(process.cwd(), "scripts", "diag", "last-report-passo.txt");
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
const bt = await import("@/lib/booking-template");
const sb = getSelfhost();
const CONV = "144aa7f0-b7eb-49d9-be8e-d10ee896dc36";

describe("passo", () => {
  it("prova do decline", async () => {
    const { data: c } = await sb.from("conversations").select("meta").eq("id", CONV).single();
    const ld = ((c?.meta as Record<string, unknown>)?.lead_data ?? {}) as Record<string, unknown>;
    const { data: raw } = await sb.from("messages").select("role, content, meta")
      .eq("conversation_id", CONV).order("criado_em", { ascending: true }).order("id", { ascending: true });
    const hist: { role: "user" | "assistant"; content: string }[] = [];
    let cut = -1;
    (raw ?? []).forEach((m, idx) => {
      const mm = (m.meta ?? {}) as Record<string, unknown>;
      if (idx === 54) cut = hist.length;
      if (mm.fallback === true || mm.is_echo === true || !(m.content ?? "").trim()) return;
      hist.push({ role: m.role as "user" | "assistant", content: m.content as string });
    });
    const antes = hist.slice(0, cut);
    const ld054 = { ...ld, selected_slot_iso: "" } as never;

    log(`=== TURNO [054] — a lead escreveu, em rajada: "Ótima as 13: horas" / "Obrigada" / "As 13h" ===`);
    log(`rajada que o codigo enxerga: ${JSON.stringify(bt.lastUserBurst(antes as never))}`);
    log(`\nREAL       -> tryAutoSelectOfferedSlot = ${JSON.stringify(bt.tryAutoSelectOfferedSlot("SLOT_OFFER", ld054, antes as never))}`);
    log(`   ANTES da correcao vinha {}: looksLikeDecline("Obrigada") = ${bt.looksLikeDecline("Obrigada")} vetava a rajada inteira.`);
    log(`   AGORA isBareGratitude("Obrigada") = ${bt.isBareGratitude("Obrigada")} isenta o agradecimento seco quando ha hora explicita.`);

    // CONTRAFACTUAL 1: a mesma rajada, sem o "Obrigada" no meio.
    const semObrigada = antes.filter((m) => m.content.trim() !== "Obrigada");
    log(`\nSEM "Obrigada" -> tryAutoSelectOfferedSlot = ${JSON.stringify(bt.tryAutoSelectOfferedSlot("SLOT_OFFER", ld054, semObrigada as never))}`);

    // CONTRAFACTUAL 2: so "As 13h" como ultima mensagem.
    const soEscolha = [...antes.slice(0, -3), { role: "user" as const, content: "As 13h" }];
    log(`SO "As 13h"    -> tryAutoSelectOfferedSlot = ${JSON.stringify(bt.tryAutoSelectOfferedSlot("SLOT_OFFER", ld054, soEscolha as never))}`);

    // Outras formas de agradecimento vetam igual?
    for (const g of ["Obrigada", "Obrigado", "obrigada!", "Muito obrigada", "Vlw", "Ok obrigada"]) {
      log(`   looksLikeDecline(${JSON.stringify(g)}) = ${bt.looksLikeDecline(g)}`);
    }
    expect(true).toBe(true);
  }, 600_000);
});
