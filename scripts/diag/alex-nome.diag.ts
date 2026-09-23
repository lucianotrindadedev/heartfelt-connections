// Read-only: reproduz, com a função de produção, de onde veio
// lead_data.name="Eu sofri um acidente" do Alex (21) 97394-6031.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
const OUT = path.resolve(process.cwd(), "scripts", "diag", "last-report-alex-nome.txt");
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
const BT = await import("@/lib/booking-template");
const sb = getSelfhost();
const CONV = "7648bfca-0817-4226-82aa-d00aa6e84a09";

describe("alex-nome", () => {
  it("reproduz", async () => {
    const { data: conv } = await sb.from("conversations").select("agent_id").eq("id", CONV).single();
    const { data: ag } = await sb.from("agents").select("settings").eq("id", conv!.agent_id).single();
    const settings = (ag!.settings ?? {}) as Record<string, string>;
    const fields = BT.getBookingFieldsForChannel(settings, { channel: "whatsapp", effectivePhone: "21973946031" } as never);
    log(`fields=${JSON.stringify(fields.map((f) => ({ key: f.key, maps_to: f.maps_to, q: f.question })))}`);
    const { data: msgs } = await sb.from("messages").select("role, content, meta, criado_em")
      .eq("conversation_id", CONV).order("criado_em", { ascending: true });
    const history = ((msgs ?? []) as { role: string; content: string; meta: Record<string, unknown> | null }[])
      .filter((m) => m.meta?.is_echo !== true && m.meta?.origem !== "humano")
      .map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));
    for (let n = 1; n <= history.length; n++) {
      const h = history.slice(0, n);
      if (h[n - 1]!.role !== "user") continue;
      const p = BT.backfillBookingFieldsFromHistory({} as never, h, settings, { channel: "whatsapp", effectivePhone: "21973946031" } as never);
      log(`após "${h[n - 1]!.content}" -> backfill=${JSON.stringify(p)}`);
    }
    for (const t of ["Alex", "Eu sofri um acidente", "E quebrei 2 dente e perdi um e está me incomodando", "É muito longe dá minha casa", "Em Japeri"]) {
      log(`looksLikeSentenceNotName(${JSON.stringify(t)})=${BT.looksLikeSentenceNotName(t)}`);
    }
    expect(true).toBe(true);
  }, 300_000);
});
