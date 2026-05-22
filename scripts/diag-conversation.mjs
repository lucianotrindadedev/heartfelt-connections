/**
 * Diagnóstico rápido de conversa travada.
 * Uso: node scripts/diag-conversation.mjs [conversation_id]
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

const url = env.SELFHOST_SUPABASE_URL;
const key = env.SELFHOST_SUPABASE_SERVICE_ROLE_KEY;
const convId =
  process.argv[2] || "6fa302c4-a8ad-41da-ad8a-e4bdca328dac";

if (!url || !key) {
  console.error("Faltam SELFHOST_SUPABASE_URL ou SERVICE_ROLE_KEY no .env");
  process.exit(1);
}

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

console.log("=== Conversa", convId, "===\n");

const [conv] = await q(
  "conversations",
  `?id=eq.${convId}&select=id,phone,lead_phone,channel,channel_identifier,helena_session_id,agent_id,meta,criado_em,atualizado_em`,
);
if (!conv) {
  console.log("Conversa não encontrada");
  process.exit(1);
}
console.log("Conversa:", JSON.stringify(conv, null, 2));

const [agent] = await q(
  "agents",
  `?id=eq.${conv.agent_id}&select=id,ativo,debounce_segundos,account_id`,
);
console.log("\nAgente:", agent);

const state = await q(
  "conversation_state",
  `?conversation_id=eq.${convId}&select=*`,
);
console.log("\nEstado (lock):", state[0] ?? "sem linha");

const msgs = await q(
  "messages",
  `?conversation_id=eq.${convId}&select=role,content,meta,criado_em&order=criado_em.desc&limit=8`,
);
console.log("\nÚltimas mensagens:");
for (const m of msgs) {
  const preview = (m.content ?? "").slice(0, 100).replace(/\n/g, " ");
  const meta = m.meta ? JSON.stringify(m.meta).slice(0, 120) : "";
  console.log(`  ${m.criado_em} [${m.role}] ${preview}${preview.length >= 100 ? "…" : ""}`);
  if (meta) console.log(`    meta: ${meta}`);
}

const queue = await q(
  "message_queue",
  `?conversation_id=eq.${convId}&select=id,execute_at,processed,created_at&order=execute_at.desc&limit=5`,
);
console.log("\nFila message_queue:", queue.length ? queue : "vazia");

const runs = await q(
  "agent_runs",
  `?conversation_id=eq.${convId}&select=id,model,latency_ms,criado_em&order=criado_em.desc&limit=5`,
);
console.log("\nAgent runs:", runs.length ? runs : "nenhum");

const needsReply =
  msgs.length > 0 && msgs[0].role === "user";
console.log("\n→ conversationNeedsAgentReply:", needsReply);
console.log("→ lock_conversa:", state[0]?.lock_conversa ?? false);
