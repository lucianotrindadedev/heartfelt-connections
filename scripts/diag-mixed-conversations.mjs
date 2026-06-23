/**
 * Detector de MISTURA DE MENSAGENS.
 *
 * Procura conversas que contêm mensagens de MAIS DE UM remetente — o sintoma
 * clássico de "agente misturando conversas". Cada mensagem inbound guarda o
 * telefone do remetente em meta.channel_from; se uma mesma conversa tem 2+
 * channel_from distintos (ou 2+ helena_msg de origens diferentes), houve
 * colapso de leads numa única conversation row.
 *
 * Uso:
 *   node scripts/diag-mixed-conversations.mjs [agent_id] [horas]
 *   - agent_id (opcional): limita a um agente. Sem isso, varre todas.
 *   - horas (opcional): janela de tempo (default 168 = 7 dias).
 *
 * Somente LEITURA — não altera nada.
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

const agentId = process.argv[2] && process.argv[2] !== "-" ? process.argv[2] : null;
const horas = Number(process.argv[3] || 168);
const since = new Date(Date.now() - horas * 3600_000).toISOString();

const headers = {
  apikey: key,
  Authorization: `Bearer ${key}`,
  "Content-Type": "application/json",
};

async function q(path, params = "") {
  const res = await fetch(`${url}/rest/v1/${path}${params}`, { headers });
  const text = await res.text();
  if (!res.ok) throw new Error(`${path} ${res.status}: ${text.slice(0, 400)}`);
  return JSON.parse(text);
}

// Só dígitos, para comparar telefones de formatos diferentes.
const digits = (s) => (s ?? "").toString().replace(/\D/g, "");

console.log(
  `=== Detector de mistura de mensagens — últimas ${horas}h${agentId ? ` (agente ${agentId})` : " (todos os agentes)"} ===\n`,
);

// 1) Conversas atualizadas na janela.
const convFilter =
  `?select=id,phone,lead_phone,agent_id,helena_session_id,atualizado_em` +
  `&atualizado_em=gte.${since}` +
  (agentId ? `&agent_id=eq.${agentId}` : "") +
  `&order=atualizado_em.desc&limit=2000`;
const convs = await q("conversations", convFilter);
console.log(`Conversas na janela: ${convs.length}\n`);

let mixed = 0;
for (const conv of convs) {
  // Mensagens inbound (do lead) desta conversa.
  const msgs = await q(
    "messages",
    `?conversation_id=eq.${conv.id}&role=eq.user&select=content,meta,criado_em&order=criado_em.asc&limit=200`,
  );
  if (msgs.length < 2) continue;

  // Coleta remetentes distintos (telefone do meta.channel_from).
  const senders = new Set();
  for (const m of msgs) {
    const from = digits(m.meta?.channel_from);
    if (from) senders.add(from);
  }
  if (senders.size <= 1) continue;

  mixed++;
  console.log(`⚠️  CONVERSA COM ${senders.size} REMETENTES — ${conv.id}`);
  console.log(`    phone(key)=${conv.phone} lead_phone=${conv.lead_phone} session=${conv.helena_session_id}`);
  console.log(`    remetentes: ${[...senders].join(", ")}`);
  // Amostra das mensagens mostrando a alternância.
  for (const m of msgs.slice(-8)) {
    const from = digits(m.meta?.channel_from) || "(sem channel_from)";
    const prev = (m.content ?? "").slice(0, 60).replace(/\n/g, " ");
    console.log(`      ${m.criado_em} [${from}] ${prev}`);
  }
  console.log("");
}

console.log(`\n=== Resultado: ${mixed} conversa(s) com mistura de remetentes ===`);
if (mixed === 0) {
  console.log(
    "Nenhuma conversa com 2+ remetentes. Se o agente ainda 'mistura', a causa\n" +
      "provavelmente NÃO é colapso de conversas — investigar RAG/base de\n" +
      "conhecimento (busca trazendo outro contexto) ou JSON truncado/recuperado.",
  );
}
