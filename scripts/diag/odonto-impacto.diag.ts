// Read-only: quantas leads perdem a escolha de horario porque disseram
// "obrigada" na mesma rajada (looksLikeDecline veta a rajada inteira).
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
const OUT = path.resolve(process.cwd(), "scripts", "diag", "last-report-impacto.txt");
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

// Mensagem que carrega uma HORA explicita ("13h", "12:30", "16:00hs").
const HORA = /(?<![\d.,])\d{1,2}(?:\s*[:h.,]\s*[0-5]\d(?!\d)|\s*,?\s*h(?:s|rs?|oras?)?\b)/i;

describe("impacto", () => {
  it("mede", async () => {
    const SINCE = "2026-07-25T00:00:00Z";
    const { data } = await sb.from("messages")
      .select("conversation_id, content")
      .gte("criado_em", SINCE).eq("role", "user").ilike("content", "obrigad%")
      .order("criado_em", { ascending: true }).range(0, 999);
    const msgs = (data ?? []) as { conversation_id: string; content: string }[];
    const bare = msgs.filter((m) => bt.looksLikeDecline(m.content ?? ""));
    const convs = [...new Set(bare.map((m) => m.conversation_id))];
    log(`### janela ${SINCE.slice(0, 10)} -> 24/08 (1 pagina, ate 1000 linhas)`);
    log(`mensagens de lead comecando com "obrigad": ${msgs.length}`);
    log(`  classificadas como RECUSA por looksLikeDecline: ${bare.length}`);
    log(`  em ${convs.length} conversas distintas`);

    let n = 0;
    const ex: string[] = [];
    for (const cid of convs) {
      const { data: all } = await sb.from("messages").select("role, content, meta")
        .eq("conversation_id", cid).order("criado_em", { ascending: true }).order("id", { ascending: true });
      const hist: { role: "user" | "assistant"; content: string }[] = [];
      for (const m of (all ?? [])) {
        const mm = (m.meta ?? {}) as Record<string, unknown>;
        if (mm.fallback === true || mm.is_echo === true || !(m.content ?? "").trim()) continue;
        hist.push({ role: m.role as "user" | "assistant", content: m.content as string });
      }
      for (let i = 0; i < hist.length; i++) {
        if (hist[i]!.role !== "user" || hist[i + 1]?.role === "user") continue;
        const burst = bt.lastUserBurst(hist.slice(0, i + 1) as never) as string[];
        if (burst.length < 2) continue;
        if (!burst.some((b) => bt.looksLikeDecline(b))) continue;
        if (!burst.some((b) => bt.isSlotAcceptanceMessage(b) && HORA.test(b))) continue;
        n++;
        if (ex.length < 15) ex.push(`${cid.slice(0, 8)} :: ${JSON.stringify(burst.filter((b) => b.length < 60))}`);
        break;
      }
    }
    log(`\nrajadas em que o lead deu HORA EXPLICITA e disse "obrigad*" na mesma leva: ${n}`);
    log(`(a rajada inteira e descartada -> criar_agendamento devolve "selected_slot_iso ausente")`);
    log(`\nexemplos (mensagens curtas da rajada):`);
    for (const e of ex) log(`  ${e}`);
    expect(true).toBe(true);
  }, 900_000);
});
