/**
 * Ajuste cirúrgico no prompt da conta Liber Odontologia:
 *  - Remove a seção "# RESTRIÇÃO DE IDADE" (estava quebrada — "acima de anos" —
 *    e a clínica atende todas as idades).
 *  - Remove o rótulo vazio "Ponto de referência:" nos DADOS DA CLÍNICA.
 *
 * Preserva todo o resto do prompt (já alinhado ao template validado).
 * Registra a alteração em ai_magic_requests (applied=true) para rollback pela UI.
 *
 * Uso: node scripts/fix-liber-prompt.mjs        (dry-run: mostra o diff)
 *      node scripts/fix-liber-prompt.mjs --apply (grava no banco)
 */
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dir = dirname(fileURLToPath(import.meta.url));
const env = Object.fromEntries(
  readFileSync(resolve(__dir, "..", ".env"), "utf8")
    .split("\n").filter((l) => l && !l.startsWith("#") && l.includes("="))
    .map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")]; }),
);
const URL = env.SELFHOST_SUPABASE_URL, KEY = env.SELFHOST_SUPABASE_SERVICE_ROLE_KEY;
const HEADERS = { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };

const ACCOUNT_ID = "f9165605-d6c4-40da-b220-e5d2c10efd1d";
const AGENT_ID = "88b045b9-1775-423a-aaa6-48c2ba2e83d3";
const APPLY = process.argv.includes("--apply");

async function rest(path, opts = {}) {
  const r = await fetch(`${URL}/rest/v1/${path}`, { headers: HEADERS, ...opts });
  const t = await r.text();
  if (!r.ok) throw new Error(`${r.status}: ${t}`);
  return t ? JSON.parse(t) : null;
}

const [agent] = await rest(`agents?id=eq.${AGENT_ID}&select=system_prompt,nome`);
const before = agent.system_prompt || "";

if (!before.includes("# RESTRIÇÃO DE IDADE")) {
  console.log("⚠️  Seção '# RESTRIÇÃO DE IDADE' não encontrada — nada a fazer (já removida?).");
  process.exit(0);
}
if (!before.includes("# FLUXO PRINCIPAL")) {
  console.error("❌  Âncora '# FLUXO PRINCIPAL' não encontrada — abortando por segurança.");
  process.exit(1);
}

// Remove a seção de idade (da heading até a próxima heading "# FLUXO PRINCIPAL").
let after = before.replace(/\n*# RESTRIÇÃO DE IDADE[\s\S]*?\n+(?=# FLUXO PRINCIPAL)/, "\n\n");
// Remove o rótulo vazio "Ponto de referência:" (sem valor) na linha de dados.
after = after.replace(/Ponto de referência:\s*(?=Horários de funcionamento:)/, "");
// Normaliza 3+ linhas em branco.
after = after.replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";

console.log(`Prompt antes: ${before.length} chars`);
console.log(`Prompt depois: ${after.length} chars (removidos ${before.length - after.length})`);

// Mostra a "costura" onde a seção foi removida.
const idx = after.indexOf("# CONVÊNIO E FORMAS DE PAGAMENTO");
console.log("\n--- trecho ao redor da remoção (após CONVÊNIO/PREÇOS → FLUXO) ---");
const seamStart = after.indexOf("# REGRA ABSOLUTA DE PREÇOS");
console.log(after.slice(seamStart, seamStart + 700));
console.log("--- fim do trecho ---\n");

if (!APPLY) {
  console.log("DRY-RUN. Rode com --apply para gravar.");
  process.exit(0);
}

// 1. Atualiza o prompt do agente.
await rest(`agents?id=eq.${AGENT_ID}`, {
  method: "PATCH",
  headers: { ...HEADERS, Prefer: "return=minimal" },
  body: JSON.stringify({ system_prompt: after }),
});

// 2. Registra auditoria (permite restaurar pela UI de versões).
await rest(`ai_magic_requests`, {
  method: "POST",
  headers: { ...HEADERS, Prefer: "return=minimal" },
  body: JSON.stringify({
    account_id: ACCOUNT_ID,
    agent_id: AGENT_ID,
    user_message: "[MANUAL] Remoção da seção de restrição de idade (Liber atende todas as idades) + limpeza do rótulo de ponto de referência.",
    prompt_before: before,
    proposed_prompt: after,
    summary: "Removida a seção '# RESTRIÇÃO DE IDADE' (estava quebrada: 'acima de anos'). Liber atende todas as idades. Demais seções preservadas.",
    sections_changed: ["RESTRIÇÃO DE IDADE", "DADOS DA CLÍNICA"],
    applied: true,
    applied_at: new Date().toISOString(),
    model: "system",
  }),
});

console.log("✅  Prompt da Liber atualizado e registrado no histórico (restaurável pela UI).");
