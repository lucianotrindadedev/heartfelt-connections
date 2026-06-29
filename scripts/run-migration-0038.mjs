/**
 * Aplica a migration 0038_tag_automations.sql (automações de etiqueta) via
 * Supabase REST (execute_sql RPC) com fallback para /pg/query.
 * Uso: node scripts/run-migration-0038.mjs
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
  `create table if not exists agent_tag_automations (
    id uuid primary key default gen_random_uuid(),
    agent_id uuid not null references agents(id) on delete cascade,
    enabled boolean not null default true,
    trigger_tag text not null,
    action_type text not null default 'add_to_sequence'
      check (action_type in ('add_to_sequence', 'remove_from_sequence')),
    sequence_id text,
    sequence_name text,
    criado_em timestamptz default now(),
    atualizado_em timestamptz default now()
  )`,
  `create index if not exists agent_tag_automations_agent on agent_tag_automations(agent_id)`,
  `create index if not exists agent_tag_automations_enabled on agent_tag_automations(agent_id) where enabled = true`,
  `create table if not exists tag_automation_runs (
    id uuid primary key default gen_random_uuid(),
    automation_id uuid not null references agent_tag_automations(id) on delete cascade,
    agent_id uuid not null,
    contact_id text not null,
    trigger_tag text,
    status text not null,
    error text,
    executed_at timestamptz default now()
  )`,
  `create unique index if not exists tag_automation_runs_dedupe on tag_automation_runs(automation_id, contact_id) where status = 'done'`,
  `create index if not exists tag_automation_runs_agent_time on tag_automation_runs(agent_id, executed_at desc)`,
];

const verifySql = `select table_name from information_schema.tables where table_schema='public' and table_name in ('agent_tag_automations','tag_automation_runs')`;

console.log("🔄  Aplicando migration 0038_tag_automations…\n");

for (const sql of statements) {
  console.log(`  → ${sql.replace(/\s+/g, " ").slice(0, 80)}…`);
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
      console.log("\n⚠️   Execute manualmente o arquivo migrations/0038_tag_automations.sql no SQL Editor.");
      process.exit(1);
    }
  }
}

console.log("\n🔎  Verificando tabelas…");
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

console.log("\n✅  Migration 0038 aplicada.");
