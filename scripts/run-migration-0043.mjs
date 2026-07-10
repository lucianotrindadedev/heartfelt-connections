/**
 * Aplica a migration 0043_template_clinica_estetica.sql (insere o template
 * "Clínica de Estética (Clinic Experts)" em prompt_templates) via
 * Supabase REST (execute_sql RPC) com fallback para /pg/query.
 * Depende da 0042 já ter sido aplicada (libera integration_type='clinic_experts').
 * Uso: node scripts/run-migration-0043.mjs
 */
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dir = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dir, "..");
const env = Object.fromEntries(
  readFileSync(resolve(root, ".env"), "utf8")
    .split("\n").filter((l) => l && !l.startsWith("#") && l.includes("="))
    .map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")]; }),
);
const SUPABASE_URL = env.SELFHOST_SUPABASE_URL;
const SERVICE_KEY = env.SELFHOST_SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error("❌  SELFHOST_SUPABASE_URL / SELFHOST_SUPABASE_SERVICE_ROLE_KEY não encontrados em .env");
  process.exit(1);
}
async function execSql(sql) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/execute_sql`, {
    method: "POST",
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ sql }),
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${body}`);
  return body;
}
async function execSqlFallback(sql) {
  const res = await fetch(`${SUPABASE_URL}/pg/query`, {
    method: "POST",
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query: sql }),
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${body}`);
  return body;
}

const sql = readFileSync(resolve(root, "migrations/0043_template_clinica_estetica.sql"), "utf8");
const verifySql = `select id, nome, integration_type, ativo from prompt_templates where nome = 'Clínica de Estética (Clinic Experts)'`;

console.log("🔄  Aplicando migration 0043_template_clinica_estetica…\n");
try {
  await execSql(sql);
  console.log("  ✅  ok (execute_sql RPC)");
} catch (e1) {
  try {
    await execSqlFallback(sql);
    console.log("  ✅  ok (pg/query fallback)");
  } catch (e2) {
    console.error(`  ❌  falhou: ${e1.message}\n     fallback: ${e2.message}`);
    process.exit(1);
  }
}

console.log("\n🔎  Verificando template…");
try {
  let out;
  try { out = await execSql(verifySql); } catch { out = await execSqlFallback(verifySql); }
  console.log("    resultado:", out);
} catch (e) {
  console.log("    (não foi possível verificar:", e.message, ")");
}
console.log("\n✅  Migration 0043 aplicada.");
