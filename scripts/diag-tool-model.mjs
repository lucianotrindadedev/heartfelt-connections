/**
 * Lista o tool_model (e modelos relacionados) de cada conta.
 * Mostra o valor efetivo: se a coluna estiver null, cai no DEFAULT_TOOL_MODEL.
 * Uso: node scripts/diag-tool-model.mjs
 */
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dir = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dir, "..");
const env = Object.fromEntries(
  readFileSync(resolve(root, ".env"), "utf8")
    .split("\n")
    .filter((l) => l && !l.startsWith("#") && l.includes("="))
    .map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")];
    }),
);

const url = env.SELFHOST_SUPABASE_URL;
const key = env.SELFHOST_SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("Faltam SELFHOST_SUPABASE_URL ou SERVICE_ROLE_KEY no .env");
  process.exit(1);
}

const DEFAULT_TOOL_MODEL = "openai/gpt-4.1-mini";

const headers = {
  apikey: key,
  Authorization: `Bearer ${key}`,
  "Content-Type": "application/json",
};

async function q(path, params = "") {
  const res = await fetch(`${url}/rest/v1/${path}${params}`, { headers });
  const text = await res.text();
  if (!res.ok) throw new Error(`${res.status} ${path}: ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

const accounts = await q("accounts", "?select=id,nome&order=id");
const cfgs = await q("account_llm_config", "?select=account_id,default_model,tool_model");
const cfgByAccount = new Map(cfgs.map((c) => [c.account_id, c]));

console.log(`\nContas: ${accounts.length}\n`);
console.log(
  ["NOME".padEnd(28), "tool_model (efetivo)".padEnd(26), "fonte".padEnd(8), "default_model"].join(" | "),
);
console.log("-".repeat(100));

const tally = {};
for (const a of accounts) {
  const cfg = cfgByAccount.get(a.id);
  const raw = cfg?.tool_model ?? null;
  const effective = raw ?? DEFAULT_TOOL_MODEL;
  const source = cfg == null ? "sem-cfg" : raw == null ? "default" : "conta";
  const nome = (a.nome ?? a.id).toString().slice(0, 27);
  tally[effective] = (tally[effective] ?? 0) + 1;
  console.log(
    [
      nome.padEnd(28),
      effective.padEnd(26),
      source.padEnd(8),
      cfg?.default_model ?? "(default)",
    ].join(" | "),
  );
}

console.log("\nResumo por tool_model efetivo:");
for (const [m, n] of Object.entries(tally).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${n.toString().padStart(3)}  ${m}`);
}
