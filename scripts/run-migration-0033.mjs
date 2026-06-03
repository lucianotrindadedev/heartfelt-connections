/**
 * Aplica a migration 0033_gcal_multi_agenda.sql (coluna agendas jsonb) via
 * Supabase REST (execute_sql RPC) com fallback para /pg/query.
 * Uso: node scripts/run-migration-0033.mjs
 */
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dir = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dir, "..");
const envPath = resolve(root, ".env");

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

async function execSql(sql) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/execute_sql`, {
    method: "POST",
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ sql }),
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${body}`);
  return body;
}

async function execSqlFallback(sql) {
  const res = await fetch(`${SUPABASE_URL}/pg/query`, {
    method: "POST",
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query: sql }),
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${body}`);
  return body;
}

const statements = [
  `alter table public.google_calendar_tokens add column if not exists agendas jsonb not null default '[]'::jsonb`,
  `comment on column public.google_calendar_tokens.agendas is 'Lista de agendas selecionadas [{label, calendar_id, descricao}]. Vazio = usa calendar_id (agenda unica). 2+ = agente escolhe via parametro agenda conforme o prompt.'`,
];

// Verificação: confere se a coluna existe após aplicar.
const verifySql = `select column_name, data_type from information_schema.columns where table_schema='public' and table_name='google_calendar_tokens' and column_name='agendas'`;

console.log("🔄  Aplicando migration 0033_gcal_multi_agenda…\n");

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
      console.log("\n⚠️   Execute manualmente no SQL Editor:");
      console.log("------------------------------------------------------------");
      for (const s of statements) console.log(s + ";");
      console.log("------------------------------------------------------------");
      process.exit(1);
    }
  }
}

console.log("\n🔎  Verificando coluna…");
try {
  let out;
  try {
    out = await execSql(verifySql);
  } catch {
    out = await execSqlFallback(verifySql);
  }
  console.log("    resultado:", out);
} catch (e) {
  console.log("    (não foi possível verificar automaticamente:", e.message, ")");
}

console.log("\n✅  Migration 0033 aplicada.");
