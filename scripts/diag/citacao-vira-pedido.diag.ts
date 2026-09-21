// Read-only: o bloco de citação do WhatsApp ("[Em resposta à mensagem: ...]")
// entra na leitura de data/dia como se fosse fala do lead.
//
// Achado ao reproduzir a conversa da Milene (Clinica Bomfim, 21 99004-9579):
// ela respondeu citando uma pergunta DO AGENTE que continha a palavra "hoje"
// — e a âncora da busca virou "hoje". Na conversa dela o efeito foi só um
// aviso_data enganoso, mas uma citação com "quinta" ou "dia 30" ancoraria a
// busca no dia errado.

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const OUT = path.resolve(process.cwd(), "scripts", "diag", "last-report-citacao-pedido.txt");
const R: string[] = [];
const log = (l = "") => {
  R.push(l);
  fs.writeFileSync(OUT, `${R.join("\n")}\n`, "utf8");
};

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
const { requestedDateFromText, requestedWeekdayFromText } = await import("@/lib/booking-template");
const sb = getSelfhost();

/** Remove o bloco de citação — o que o lead REALMENTE escreveu. */
const semCitacao = (t: string) =>
  t.replace(/\[Em resposta à mensagem:[\s\S]*?\]/gi, " ").trim();

describe("citação lida como pedido", () => {
  it("varre", async () => {
    const desde = new Date(Date.now() - 120 * 86400_000).toISOString();
    const { data } = await sb
      .from("messages")
      .select("id, conversation_id, content, criado_em")
      .eq("role", "user")
      .ilike("content", "%Em resposta à mensagem%")
      .gte("criado_em", desde)
      .limit(2000);
    const rows = (data ?? []) as Record<string, unknown>[];
    log(`mensagens de lead com bloco de citação (120d): ${rows.length}\n`);

    const afetadas: string[] = [];
    for (const m of rows) {
      const inteiro = String(m.content ?? "");
      const limpo = semCitacao(inteiro);
      const comCitacao = {
        d: requestedDateFromText(inteiro),
        w: requestedWeekdayFromText(inteiro),
      };
      const semCit = { d: requestedDateFromText(limpo), w: requestedWeekdayFromText(limpo) };
      if (comCitacao.d === semCit.d && comCitacao.w === semCit.w) continue;
      afetadas.push(
        `   [com citação: date=${comCitacao.d} dia=${comCitacao.w}] [só a fala: date=${semCit.d} dia=${semCit.w}]\n      ${inteiro.replace(/\s+/g, " ").slice(0, 160)}`,
      );
    }
    log(`mensagens em que a CITAÇÃO muda a leitura: ${afetadas.length}`);
    log(`conversas distintas: ${new Set(rows.map((m) => m.conversation_id)).size} varridas\n`);
    for (const a of afetadas.slice(0, 30)) log(a);
    expect(true).toBe(true);
  }, 600_000);
});
