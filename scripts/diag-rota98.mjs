/**
 * Diagnóstico: por que o agente da Rota98 responde diferente a cada mensagem.
 * Acha a conversa pelo telefone e mostra mensagens + config LLM do agente.
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
const ACCOUNT = "7c262941-b617-44b4-82d6-be2c54560f5e"; // Rota98 Tour
const PHONE = process.argv[2] || "3291607088";

const headers = { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" };
async function q(path, params = "") {
  const res = await fetch(`${url}/rest/v1/${path}${params}`, { headers });
  const text = await res.text();
  if (!res.ok) throw new Error(`${path} ${res.status}: ${text.slice(0, 400)}`);
  return JSON.parse(text);
}

// 0) Config LLM da conta
const llm = await q(
  "account_llm_config",
  `?account_id=eq.${ACCOUNT}&select=default_model,max_tokens,temperature,fallback_models,rag_gate_model,tool_model`,
);
console.log("=== LLM CONFIG Rota98 ===");
console.log(JSON.stringify(llm, null, 2));

// 1) Agentes da conta
const agents = await q(
  "agents",
  `?account_id=eq.${ACCOUNT}&select=id,nome,ativo`,
);
console.log("\n=== AGENTES Rota98 ===");
for (const a of agents) {
  console.log(JSON.stringify(a, null, 2));
}
const agentIds = agents.map((a) => `"${a.id}"`).join(",");

// 2) Conversa pelo telefone (busca flexível, últimos 7 dígitos)
const tail = PHONE.slice(-7);
let convs = await q(
  "conversations",
  `?agent_id=in.(${agentIds})&or=(phone.ilike.*${tail}*,lead_phone.ilike.*${tail}*,channel_identifier.ilike.*${tail}*)&select=id,phone,lead_phone,channel_identifier,helena_session_id,agent_id,criado_em,atualizado_em&order=atualizado_em.desc`,
);
console.log(`\n=== CONVERSAS com final ${tail} ===`);
if (!convs.length) {
  console.log("nenhuma pelo telefone — listando 8 conversas mais recentes do agente:");
  convs = await q(
    "conversations",
    `?agent_id=in.(${agentIds})&select=id,phone,lead_phone,channel_identifier,agent_id,atualizado_em&order=atualizado_em.desc&limit=8`,
  );
}
console.log(JSON.stringify(convs, null, 2));
if (!convs.length) process.exit(0);

for (const conv of convs.slice(0, 2)) {
  console.log(`\n========== Conversa ${conv.id} ==========`);
  const msgs = await q(
    "messages",
    `?conversation_id=eq.${conv.id}&select=role,content,meta,criado_em&order=criado_em.asc&limit=60`,
  );
  for (const m of msgs) {
    const preview = (m.content ?? "").slice(0, 240).replace(/\n/g, " ");
    const flags = [];
    const meta = m.meta || {};
    if (meta.is_echo) flags.push("ECHO");
    if (meta.fallback) flags.push("FALLBACK");
    if (meta.tipo) flags.push(meta.tipo);
    if (meta.origem) flags.push(`origem:${meta.origem}`);
    if (meta.stage) flags.push(`stage:${meta.stage}`);
    console.log(`${m.criado_em} [${m.role}]${flags.length ? " {" + flags.join(",") + "}" : ""} ${preview}`);
  }

  const runs = await q(
    "agent_runs",
    `?conversation_id=eq.${conv.id}&select=*&order=criado_em.desc&limit=6`,
  );
  console.log("\n  agent_runs:");
  for (const r of runs) console.log("   ", JSON.stringify(r).slice(0, 400));
}
