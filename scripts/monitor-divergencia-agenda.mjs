/**
 * Monitor de DIVERGÊNCIA de agendamento.
 *
 * Varre as conversas com agendamento e compara a data que o AGENTE afirmou ao
 * lead no texto (DD/MM) com a data que foi de fato AGENDADA (booked_slot_iso).
 * Quando a data agendada nunca apareceu no texto → agendamento fantasma: o lead
 * acha que vai num dia, o CRM tem outro (caso Costa Lima Recreio, Melissa).
 *
 * NÃO altera nada — só lê e reporta. Espelha a lógica de mitigação já embutida
 * no scheduler (affirmedDatesFromAssistant + ddmmInBrt em booking-template.ts).
 *
 * Uso:
 *   node scripts/monitor-divergencia-agenda.mjs            # todas
 *   node scripts/monitor-divergencia-agenda.mjs --dias 14  # só as N últimas dias
 *   node scripts/monitor-divergencia-agenda.mjs --csv out.csv
 */
import { readFileSync, writeFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { createClient } from "@supabase/supabase-js";

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

const url = env.SUPABASE_URL;
const key = env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("Faltam SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY no .env");
  process.exit(1);
}
const db = createClient(url, key, { auth: { persistSession: false } });

const args = process.argv.slice(2);
const diasArg = args.includes("--dias") ? Number(args[args.indexOf("--dias") + 1]) : null;
const csvArg = args.includes("--csv") ? args[args.indexOf("--csv") + 1] : null;

// ── helpers (espelham src/lib/booking-template.ts) ─────────────────────────

/** DD/MM (zero-padded, fuso BRT) de um instante ISO. "" se inválido. */
function ddmmInBrt(iso) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  return new Intl.DateTimeFormat("pt-BR", {
    timeZone: "America/Sao_Paulo",
    day: "2-digit",
    month: "2-digit",
  }).format(d);
}

/** Rótulo curto "qua 15/07" p/ leitura no relatório. */
function labelBrt(iso) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  const wd = new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo", weekday: "short" })
    .format(d)
    .replace(".", "");
  const hm = new Intl.DateTimeFormat("pt-BR", {
    timeZone: "America/Sao_Paulo",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(d);
  return `${wd} ${ddmmInBrt(iso)} ${hm}`;
}

/** Datas DD/MM (zero-padded) afirmadas pelo agente nos textos dados. */
function affirmedDatesFromAssistant(texts) {
  const out = new Set();
  for (const raw of texts) {
    const matches = (raw ?? "").matchAll(/\b(\d{1,2})\/(\d{1,2})(?:\/\d{2,4})?\b/g);
    for (const m of matches) {
      const dd = Number(m[1]);
      const mm = Number(m[2]);
      if (dd >= 1 && dd <= 31 && mm >= 1 && mm <= 12) {
        out.add(`${String(dd).padStart(2, "0")}/${String(mm).padStart(2, "0")}`);
      }
    }
  }
  return out;
}

// ── coleta ─────────────────────────────────────────────────────────────────

async function fetchAll(builder) {
  const pageSize = 1000;
  let from = 0;
  const rows = [];
  for (;;) {
    const { data, error } = await builder.range(from, from + pageSize - 1);
    if (error) throw new Error(error.message);
    rows.push(...data);
    if (data.length < pageSize) break;
    from += pageSize;
  }
  return rows;
}

console.log("Buscando conversas com agendamento…");
let convBuilder = db
  .from("conversations")
  .select("id, agent_id, phone, lead_phone, meta, atualizado_em")
  .not("meta->lead_data->>booked_slot_iso", "is", null)
  .order("atualizado_em", { ascending: false });
if (diasArg) {
  const since = new Date(Date.now() - diasArg * 86_400_000).toISOString();
  convBuilder = convBuilder.gte("atualizado_em", since);
}
const convs = await fetchAll(convBuilder);
console.log(`  ${convs.length} conversas com booked_slot_iso.\n`);

// agentes → contas (para agrupar por clínica)
const agentIds = [...new Set(convs.map((c) => c.agent_id).filter(Boolean))];
const agentToAccount = {};
for (let i = 0; i < agentIds.length; i += 200) {
  const { data } = await db
    .from("agents")
    .select("id, account_id")
    .in("id", agentIds.slice(i, i + 200));
  for (const a of data ?? []) agentToAccount[a.id] = a.account_id;
}
const accountIds = [...new Set(Object.values(agentToAccount).filter(Boolean))];
const accountName = {};
for (let i = 0; i < accountIds.length; i += 200) {
  const { data } = await db
    .from("accounts")
    .select("id, nome")
    .in("id", accountIds.slice(i, i + 200));
  for (const a of data ?? []) accountName[a.id] = a.nome;
}

// mensagens do agente, em lote — PAGINADO: um lote de N conversas rende
// facilmente >1000 linhas de mensagens e o Supabase corta em 1000 por página,
// truncando silenciosamente (foi o que escondeu a conversa da Melissa). Por
// isso cada lote é lido até esgotar via range().
const convIds = convs.map((c) => c.id);
const msgsByConv = new Map();
const CHUNK = 50;
for (let i = 0; i < convIds.length; i += CHUNK) {
  const ids = convIds.slice(i, i + CHUNK);
  const rows = await fetchAll(
    db.from("messages").select("conversation_id, content").eq("role", "assistant").in("conversation_id", ids),
  );
  for (const m of rows) {
    if (!msgsByConv.has(m.conversation_id)) msgsByConv.set(m.conversation_id, []);
    msgsByConv.get(m.conversation_id).push(m.content ?? "");
  }
}

// ── análise ──────────────────────────────────────────────────────────────

const buckets = { DIVERGENTE: [], OK: [], SEM_DATA_NO_TEXTO: [], SEM_ISO: [] };

for (const c of convs) {
  const ld = c.meta?.lead_data ?? {};
  const booked = (ld.booked_slot_iso ?? ld.selected_slot_iso ?? "").trim();
  const conta = accountName[agentToAccount[c.agent_id]] ?? "(conta?)";
  const fone = c.lead_phone || c.phone || "(sem fone)";
  const base = { conv: c.id, conta, fone, atualizado: c.atualizado_em };

  if (!booked) {
    buckets.SEM_ISO.push(base);
    continue;
  }
  const bookedDdmm = ddmmInBrt(booked);
  const affirmed = affirmedDatesFromAssistant(msgsByConv.get(c.id) ?? []);

  if (affirmed.size === 0) {
    buckets.SEM_DATA_NO_TEXTO.push({ ...base, agendado: labelBrt(booked) });
  } else if (affirmed.has(bookedDdmm)) {
    buckets.OK.push(base);
  } else {
    // acha a mensagem que mostrou a(s) data(s) divergente(s), p/ evidência
    const snippet = (msgsByConv.get(c.id) ?? [])
      .find((t) => [...affirmed].some((d) => t.includes(d)))
      ?.replace(/\s+/g, " ")
      .slice(0, 120);
    buckets.DIVERGENTE.push({
      ...base,
      agendado: labelBrt(booked),
      afirmado: [...affirmed].sort().join(", "),
      evidencia: snippet ?? "",
    });
  }
}

// ── relatório ──────────────────────────────────────────────────────────────

const total = convs.length;
const pct = (n) => (total ? ((n * 100) / total).toFixed(1) : "0") + "%";
console.log("══════════════ RESUMO ══════════════");
console.log(`  Total analisadas .............. ${total}`);
console.log(`  ✅ OK (data agendada foi mostrada) ... ${buckets.OK.length} (${pct(buckets.OK.length)})`);
console.log(`  🔴 DIVERGENTE (fantasma) ............. ${buckets.DIVERGENTE.length} (${pct(buckets.DIVERGENTE.length)})`);
console.log(`  ⚪ Sem data no texto (não dá p/ aferir) ${buckets.SEM_DATA_NO_TEXTO.length} (${pct(buckets.SEM_DATA_NO_TEXTO.length)})`);
console.log(`  ⚪ Sem ISO agendado .................. ${buckets.SEM_ISO.length}`);

if (buckets.DIVERGENTE.length) {
  // agrupa por conta
  const porConta = {};
  for (const d of buckets.DIVERGENTE) porConta[d.conta] = (porConta[d.conta] ?? 0) + 1;
  console.log("\n── divergências por conta ──");
  for (const [k, v] of Object.entries(porConta).sort((a, b) => b[1] - a[1]))
    console.log(`  ${String(v).padStart(3)}  ${k}`);

  console.log("\n══════════════ DIVERGÊNCIAS ══════════════");
  for (const d of buckets.DIVERGENTE) {
    console.log(`\n🔴 ${d.conta} — ${d.fone}`);
    console.log(`   agendado no CRM : ${d.agendado}`);
    console.log(`   afirmado ao lead: ${d.afirmado}`);
    if (d.evidencia) console.log(`   evidência       : "${d.evidencia}"`);
    console.log(`   conv=${d.conv}  (${d.atualizado})`);
  }
}

if (csvArg) {
  const esc = (s) => `"${String(s ?? "").replace(/"/g, '""')}"`;
  const lines = [
    "categoria,conta,fone,agendado,afirmado,conv,atualizado_em,evidencia",
    ...buckets.DIVERGENTE.map((d) =>
      ["DIVERGENTE", d.conta, d.fone, d.agendado, d.afirmado, d.conv, d.atualizado, d.evidencia]
        .map(esc)
        .join(","),
    ),
    ...buckets.SEM_DATA_NO_TEXTO.map((d) =>
      ["SEM_DATA_NO_TEXTO", d.conta, d.fone, d.agendado ?? "", "", d.conv, d.atualizado, ""]
        .map(esc)
        .join(","),
    ),
  ];
  writeFileSync(resolve(root, csvArg), lines.join("\n"), "utf8");
  console.log(`\nCSV salvo em ${csvArg} (${buckets.DIVERGENTE.length} divergências).`);
}
