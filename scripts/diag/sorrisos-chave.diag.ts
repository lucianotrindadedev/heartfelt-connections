// Read-only: reexecuta buildConversationKey com os dados reais — contato LID sem
// telefone, mensagem de SAIDA (from = numero da clinica) e de ENTRADA (from = lead).
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
const OUT = path.resolve(process.cwd(), "scripts", "diag", "last-report-sorrisos-chave.txt");
const R: string[] = [];
const log = (l = "") => { R.push(l); fs.writeFileSync(OUT, `${R.join("\n")}\n`, "utf8"); };
const { buildConversationKey } = await import("@/lib/conversation-channel.server");

describe("chave", () => {
  it("reexecuta", () => {
    const contatoLid = { contactPhone: "", instagram: null, messengerId: null };
    const saida = buildConversationKey({ channel: "whatsapp", fromDetails: "+5587996030402", ...contatoLid });
    const entrada = buildConversationKey({ channel: "whatsapp", fromDetails: "+5538998810514", ...contatoLid });
    const saidaComTelefone = buildConversationKey({ channel: "whatsapp", fromDetails: "+5587996030402", contactPhone: "5538998810514" });
    log(`contato da sessao: "[NOVO] 213988256301059@lid", phoneNumber=""`);
    log(`\nSAIDA da clinica (from=+5587996030402), contato sem telefone -> chave = ${saida}`);
    log(`ENTRADA do lead  (from=+5538998810514), contato sem telefone -> chave = ${entrada}`);
    log(`SAIDA da clinica, contato COM telefone                         -> chave = ${saidaComTelefone}`);
    log(`\n=> para contato sem telefone, TODA mensagem enviada pela clinica vira a chave ${saida}`);
    log(`   (o numero do proprio canal) — a mesma para qualquer destinatario.`);
    expect(true).toBe(true);
  });
});
