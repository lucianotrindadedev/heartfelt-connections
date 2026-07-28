/**
 * Cria (ou atualiza) o template "Odonto SPIN — Clinup" derivado do template
 * Clinicorp já validado.
 *
 * O prompt é COPIADO do Clinicorp e só as chamadas de ferramenta são trocadas —
 * o fluxo comercial (SPIN, acolhimento, reabilitação oral) é o mesmo; o que muda
 * é qual agenda o agente opera. Trocar à mão no painel seria propenso a deixar
 * uma referência velha para trás, e uma referência velha significa o agente
 * chamando uma tool que não existe naquela conta.
 *
 * Idempotente: se o template Clinup já existir (mesmo nome), atualiza.
 * Uso: node scripts/seed-template-clinup.mjs [--dry]
 */
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dir = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dir, "..");

function loadEnv(name) {
  try {
    return Object.fromEntries(
      readFileSync(resolve(root, name), "utf8")
        .split("\n")
        .filter((l) => l && !l.startsWith("#") && l.includes("="))
        .map((l) => {
          const i = l.indexOf("=");
          return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")];
        }),
    );
  } catch {
    return {};
  }
}

const env = { ...loadEnv(".env"), ...loadEnv(".env.production") };
const URL_BASE = env.SELFHOST_SUPABASE_URL;
const KEY = env.SELFHOST_SUPABASE_SERVICE_ROLE_KEY;
if (!URL_BASE || !KEY) {
  console.error("❌  SELFHOST_SUPABASE_URL / SERVICE_ROLE_KEY não encontrados");
  process.exit(1);
}
const DRY = process.argv.includes("--dry");
const H = {
  apikey: KEY,
  Authorization: `Bearer ${KEY}`,
  "Content-Type": "application/json",
};

const NOME_CLINUP = "Odonto SPIN — Clinup";

/**
 * Troca as ferramentas do Clinicorp pelas do Clinup.
 *
 * Ambos os aliases existem no switch do scheduler (ver
 * scheduler.server.ts → tool loop), então o agente pode chamar por qualquer um
 * dos nomes. O importante é o prompt NÃO citar uma tool de outro provedor.
 */
const SUBSTITUICOES = [
  [/listar_horarios_clinicorp/g, "listar_horarios_clinup"],
  [/agendar_clinicorp/g, "agendar_clinup"],
  [/buscar_paciente_clinicorp/g, "buscar_paciente_clinup"],
  [/cancelar_clinicorp/g, "cancelar_clinup"],
  [/\(Clinicorp\)/g, "(Clinup)"],
  [/\bClinicorp\b/g, "Clinup"],
];

async function req(path, init) {
  const res = await fetch(`${URL_BASE}/rest/v1/${path}`, { ...init, headers: H });
  const txt = await res.text();
  if (!res.ok) throw new Error(`${res.status} ${txt.slice(0, 300)}`);
  return txt ? JSON.parse(txt) : null;
}

console.log("🔎  Buscando o template Clinicorp de origem…");
const origem = await req(
  "prompt_templates?select=*&integration_type=eq.clinicorp&ativo=eq.true&order=ordem.asc&limit=1",
);
if (!origem?.length) {
  console.error("❌  Nenhum template Clinicorp ativo encontrado — nada para derivar.");
  process.exit(1);
}
const base = origem[0];
console.log(`    origem: "${base.nome}" (${base.system_prompt.length} chars)`);

let prompt = base.system_prompt;
const contagens = [];
for (const [re, novo] of SUBSTITUICOES) {
  const n = (prompt.match(re) ?? []).length;
  if (n) contagens.push(`${re.source} → ${novo}: ${n}`);
  prompt = prompt.replace(re, novo);
}
console.log("\n🔁  Substituições aplicadas:");
for (const c of contagens) console.log(`    ${c}`);

// Rede de segurança: nenhuma referência a OUTRO provedor pode sobrar. Um
// "listar_horarios_clinicorp" esquecido faria o agente chamar uma tool que a
// conta Clinup não tem.
const sobrou = prompt.match(/clinicorp|clinic_experts|google_calendar/gi);
if (sobrou) {
  console.error(`\n❌  Sobraram referências a outro provedor: ${[...new Set(sobrou)].join(", ")}`);
  process.exit(1);
}
for (const alias of ["listar_horarios_clinup", "agendar_clinup"]) {
  if (!prompt.includes(alias)) {
    console.error(`\n❌  O prompt final não cita ${alias} — a troca não pegou.`);
    process.exit(1);
  }
}
console.log("    ✅  nenhuma referência a outro provedor sobrou");

const registro = {
  nome: NOME_CLINUP,
  descricao: (base.descricao ?? "").replace(/Clinicorp/g, "Clinup"),
  system_prompt: prompt,
  cover_url: base.cover_url,
  variables: base.variables,
  integration_type: "clinup",
  categoria: base.categoria,
  ordem: 7, // logo depois do Clinicorp (5) e do Google Calendar (6)
  ativo: true,
};

if (DRY) {
  console.log("\n🧪  --dry: nada gravado.");
  console.log(`    nome: ${registro.nome}`);
  console.log(`    prompt: ${prompt.length} chars`);
} else {
  const existente = await req(
    `prompt_templates?select=id&nome=eq.${encodeURIComponent(NOME_CLINUP)}`,
  );

  if (existente?.length) {
    console.log(`\n♻️   Template já existe (${existente[0].id}) — atualizando…`);
    await req(`prompt_templates?id=eq.${existente[0].id}`, {
      method: "PATCH",
      body: JSON.stringify({ ...registro, atualizado_em: new Date().toISOString() }),
    });
    console.log("    ✅  atualizado");
  } else {
    console.log("\n➕  Criando template…");
    const criado = await req("prompt_templates", {
      method: "POST",
      headers: { ...H, Prefer: "return=representation" },
      body: JSON.stringify(registro),
    });
    console.log(`    ✅  criado: ${criado?.[0]?.id ?? "(sem id no retorno)"}`);
  }

  console.log("\n✅  Template Clinup pronto.");
}
