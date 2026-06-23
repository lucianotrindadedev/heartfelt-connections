/**
 * Limpeza da poluição causada pelo eco/loopback do webhook Helena (via SQL).
 *
 * MARCA com meta.is_echo=true as mensagens-eco já gravadas: role=assistant,
 * meta.origem="humano", cujo texto normalizado (>=25 chars) está CONTIDO numa
 * mensagem que a plataforma gerou (origem agente/followup/warmup) NA MESMA
 * conversa. O orquestrador ignora is_echo no histórico → descontamina conversas
 * ativas SEM apagar nada. Mensagens reais de atendente humano (texto livre, e as
 * com prefixo "*Nome:*") NÃO casam com nossos envios e são preservadas.
 *
 * Usa o endpoint /pg/query (SQL server-side) — instantâneo, sem varrer conversa
 * a conversa. DRY-RUN por padrão (só conta + amostra); --apply executa o UPDATE.
 *
 * Uso:
 *   node scripts/cleanup-echo-pollution.mjs            # dry-run
 *   node scripts/cleanup-echo-pollution.mjs --apply    # aplica
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

const APPLY = process.argv.includes("--apply");
const h = { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" };

async function sql(query) {
  const r = await fetch(`${url}/pg/query`, { method: "POST", headers: h, body: JSON.stringify({ query }) });
  const t = await r.text();
  if (r.status !== 200) throw new Error(`pg/query ${r.status}: ${t.slice(0, 300)}`);
  return JSON.parse(t);
}

// Texto normalizado (lowercase, espaços colapsados, sem bordas).
const N = `btrim(regexp_replace(lower(coalesce(e.content,'')),'\\s+',' ','g'))`;
const NO = `btrim(regexp_replace(lower(coalesce(o.content,'')),'\\s+',' ','g'))`;
// É eco: msg gravada como "humano" (assistant, vinda da linha da clínica via
// TO_HUB) cujo texto (>=25) está CONTIDO num envio nosso (origem agente/
// followup/warmup) da MESMA conversa. Critério SEGURO: só mexe em mensagens da
// linha da clínica — nunca em mensagens de lead.
//
// NÃO ampliar para role='user': testes mostraram falso positivo (o bot repete o
// nome/pedido do lead, então a msg real do lead fica "contida" no envio nosso, e
// o número da clínica também aparece contaminado no conjunto TO_HUB). Marcar
// esconderia mensagens reais do lead. Os ecos role='user' restantes são
// impedidos de reincidir pelo fix do webhook e saem rápido da janela de 50 msgs.
const OURS = `('agente','followup','warmup','warm-up')`;
const WHERE = `e.role='assistant' and e.meta->>'origem'='humano'
  and coalesce((e.meta->>'is_echo')::boolean,false)=false
  and length(${N}) >= 25
  and exists (select 1 from public.messages o
      where o.conversation_id=e.conversation_id and o.id <> e.id
        and o.meta->>'origem' in ${OURS}
        and position(${N} in ${NO}) > 0)`;

console.log(`=== Limpeza de eco (SQL) — ${APPLY ? "APLICANDO ✍️" : "DRY-RUN"} ===\n`);

const [{ n }] = await sql(`select count(*)::int n from public.messages e where ${WHERE}`);
console.log(`Mensagens-eco a marcar (is_echo): ${n}`);

const samples = await sql(`select left(e.content,80) c, e.meta->>'channel_from' f from public.messages e where ${WHERE} limit 5`);
console.log("Amostras:");
for (const s of samples) console.log(`  [${s.f}] ${(s.c ?? "").replace(/\n/g, " ")}`);

if (APPLY) {
  await sql(`update public.messages e
    set meta = jsonb_set(coalesce(e.meta,'{}'::jsonb), '{is_echo}', 'true'::jsonb)
    where ${WHERE}`);
  const [{ n: rest }] = await sql(`select count(*)::int n from public.messages e where ${WHERE}`);
  console.log(`\n✅ Aplicado. Restantes a marcar (esperado 0): ${rest}`);
} else {
  console.log("\nDRY-RUN: rode com --apply para marcar.");
}
