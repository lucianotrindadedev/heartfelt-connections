// Read-only: descobre em qual campo a Helena manda a mensagem CITADA num reply.
// Mensagem real: "Muito obgd" (Odonto Sorrisos, 16/09 09:38), respondendo ao
// "Feliz aniversario, RODRIGO!". GET apenas.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
const OUT = path.resolve(process.cwd(), "scripts", "diag", "last-report-citacao.txt");
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
const { loadHelenaAccount } = await import("@/lib/helena.server");
const ACC = "ba2a7d4d-7ff9-4eca-9378-8bc8ebb8412b";
const MSG_REPLY = "b4fed55a-9d60-46c6-ad18-f579f78fa53a"; // "Muito obgd"
const MSG_BOMDIA = "61c6f24f-3996-4490-b011-3fffb4fe2975"; // "Bom dia" (sem citacao)

describe("citacao", () => {
  it("sonda", async () => {
    const h = await loadHelenaAccount(ACC);
    const base = h.baseUrl.replace(/\/$/, "");
    const headers = { Authorization: h.token, accept: "application/json" };
    for (const id of [MSG_REPLY, MSG_BOMDIA]) {
      for (const p of [`/chat/v1/message/${id}`, `/chat/v2/message/${id}`]) {
        const r = await fetch(base + p, { headers });
        const txt = await r.text();
        log(`\nGET ${p} -> ${r.status}`);
        log(txt.slice(0, 2500));
      }
    }
    expect(true).toBe(true);
  }, 300_000);
});
