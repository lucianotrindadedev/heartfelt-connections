/**
 * Aplica a migration 0006_multi_account.sql via Supabase REST (execute_sql RPC).
 * Uso: node scripts/run-migration-0006.mjs
 */
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dir = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dir, "..");
const envPath = resolve(root, ".env");

// Lê .env
const env = Object.fromEntries(
  readFileSync(envPath, "utf8")
    .split("\n")
    .filter((l) => l && !l.startsWith("#") && l.includes("="))
    .map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")];
    }),
);

const SUPABASE_URL = env.SELFHOST_SUPABASE_URL;
const SERVICE_KEY = env.SELFHOST_SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error("❌  SELFHOST_SUPABASE_URL / SELFHOST_SUPABASE_SERVICE_ROLE_KEY não encontrados em .env");
  process.exit(1);
}

// Executa SQL via query direto à API REST do Supabase
async function execSql(sql) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/execute_sql`, {
    method: "POST",
    headers: {
      "apikey": SERVICE_KEY,
      "Authorization": `Bearer ${SERVICE_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ sql }),
  });
  const body = await res.text();
  if (!res.ok) {
    // Se a função execute_sql não existir, tenta via pg endpoint direto
    throw new Error(`HTTP ${res.status}: ${body}`);
  }
  return body;
}

// Fallback: usa o endpoint /pg/query se disponível
async function execSqlFallback(sql) {
  const res = await fetch(`${SUPABASE_URL}/pg/query`, {
    method: "POST",
    headers: {
      "apikey": SERVICE_KEY,
      "Authorization": `Bearer ${SERVICE_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query: sql }),
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${body}`);
  return body;
}

const statements = [
  `ALTER TABLE public.accounts ADD COLUMN IF NOT EXISTS helena_account_id text`,
  `UPDATE public.accounts SET helena_account_id = id WHERE helena_account_id IS NULL`,
  `CREATE INDEX IF NOT EXISTS idx_accounts_helena_account_id ON public.accounts (helena_account_id)`,
];

console.log("🔄  Aplicando migration 0006_multi_account…\n");

for (const sql of statements) {
  console.log(`  → ${sql.slice(0, 80)}…`);
  try {
    await execSql(sql);
    console.log("    ✅  ok (execute_sql RPC)");
  } catch (e1) {
    try {
      await execSqlFallback(sql);
      console.log("    ✅  ok (pg/query fallback)");
    } catch (e2) {
      console.error(`    ❌  falhou: ${e1.message}`);
      console.error(`       fallback: ${e2.message}`);
      console.log("\n⚠️   Execute manualmente no Supabase Studio SQL Editor:");
      console.log("------------------------------------------------------------");
      for (const s of statements) console.log(s + ";");
      console.log("------------------------------------------------------------");
      process.exit(1);
    }
  }
}

console.log("\n✅  Migration 0006 aplicada com sucesso!");
