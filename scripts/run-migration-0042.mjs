/**
 * Aplica a migration 0042_clinic_experts.sql (tabela clinic_experts_config +
 * libera integration_type='clinic_experts' em prompt_templates) via
 * Supabase REST (execute_sql RPC) com fallback para /pg/query.
 * Uso: node scripts/run-migration-0042.mjs
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
const statements = [
  `create table if not exists public.clinic_experts_config (
    account_id       text primary key references public.accounts(id) on delete cascade,
    api_token_enc    text,
    procedure_id     integer,
    procedure_name   text,
    duracao_consulta int not null default 40,
    professionals    jsonb not null default '[]'::jsonb,
    ativo            boolean not null default false,
    atualizado_em    timestamptz not null default now()
  )`,
  `drop trigger if exists trg_clinic_experts_touch on public.clinic_experts_config`,
  `create trigger trg_clinic_experts_touch before update on public.clinic_experts_config
    for each row execute function public.touch_updated_at()`,
  `alter table public.prompt_templates drop constraint if exists prompt_templates_integration_type_check`,
  `alter table public.prompt_templates add constraint prompt_templates_integration_type_check
    check (integration_type in ('clinicorp', 'google_calendar', 'clinup', 'clinic_experts'))`,
];
const verifySql = `select table_name from information_schema.tables where table_name = 'clinic_experts_config'`;
console.log("🔄  Aplicando migration 0042_clinic_experts…\n");
for (const sql of statements) {
  console.log(`  → ${sql.trim().slice(0, 80).replace(/\s+/g, " ")}…`);
  try { await execSql(sql); console.log("    ✅  ok (execute_sql RPC)"); }
  catch (e1) {
    try { await execSqlFallback(sql); console.log("    ✅  ok (pg/query fallback)"); }
    catch (e2) { console.error(`    ❌  falhou: ${e1.message}\n       fallback: ${e2.message}`); process.exit(1); }
  }
}
console.log("\n🔎  Verificando tabela…");
try { let out; try { out = await execSql(verifySql); } catch { out = await execSqlFallback(verifySql); } console.log("    resultado:", out); }
catch (e) { console.log("    (não foi possível verificar:", e.message, ")"); }
console.log("\n✅  Migration 0042 aplicada.");
