// Read-only: o que a Helena devolve para a sessao/contato gravados na conversa
// que junta 161 numeros (Odonto Sorrisos, e7787ba7).
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
const OUT = path.resolve(process.cwd(), "scripts", "diag", "last-report-sorrisos-helena.txt");
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
const helenaMod = await import("@/lib/helena.server");
const sb = getSelfhost();
const ACC = "ba2a7d4d-7ff9-4eca-9378-8bc8ebb8412b";
const AGENT = "30ca896b-1754-4292-a255-aa0871272e11";
const CONV = "e7787ba7-0753-4e7c-a8dd-9ce6e932b3fc";

function resumo(o: unknown) {
  const s = JSON.stringify(o, (k, v) => (/token|key|secret/i.test(k) ? "<oculto>" : v));
  return s && s.length > 900 ? s.slice(0, 900) + "…" : s;
}

describe("helena", () => {
  it("sessao e contato", async () => {
    const { data: c } = await sb.from("conversations").select("helena_session_id, helena_contact_id, phone").eq("id", CONV).single();
    log(`conversa: phone=${c?.phone} session=${c?.helena_session_id} contact=${c?.helena_contact_id}`);
    const helena = await helenaMod.loadHelenaAccount(ACC);

    const sess = await helenaMod.loadHelenaSession(helena, c!.helena_session_id as string);
    log(`\n### loadHelenaSession(${c?.helena_session_id})\n${resumo(sess)}`);
    const contato = await helenaMod.loadHelenaContactFromSession(helena, c!.helena_session_id as string);
    log(`\n### loadHelenaContactFromSession -> ${resumo(contato)}`);

    // Quantas conversas DESTE agente tem phone = numero do proprio canal?
    const { data: mesmas } = await sb.from("conversations").select("id, phone, helena_session_id, atualizado_em")
      .eq("agent_id", AGENT).eq("phone", c!.phone as string);
    log(`\n### conversas do agente com phone=${c?.phone}: ${mesmas?.length}`);

    // Conversas que usam o numero do canal so como channel_identifier (phone diferente)
    const { data: ident } = await sb.from("conversations").select("id, phone, lead_phone, atualizado_em")
      .eq("agent_id", AGENT).eq("channel_identifier", c!.phone as string);
    log(`### conversas do agente com channel_identifier=${c?.phone}: ${ident?.length}`);
    for (const r of (ident ?? []).slice(0, 8)) log(`   id=${r.id} phone=${r.phone} lead=${r.lead_phone}`);
    expect(true).toBe(true);
  }, 600_000);
});
