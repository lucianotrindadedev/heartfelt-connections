/**
 * Remove as variáveis NOME_MEDICO_SECUNDARIO e ESPECIALIDADE_SECUNDARIO de
 * todos os templates, junto com o bloco do prompt que fala sobre o
 * profissional secundário.
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

const SUPABASE_URL = env.SELFHOST_SUPABASE_URL;
const KEY = env.SELFHOST_SUPABASE_SERVICE_ROLE_KEY;
const H = { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };

const REMOVE_KEYS = new Set(["NOME_MEDICO_SECUNDARIO", "ESPECIALIDADE_SECUNDARIO"]);

function cleanPrompt(prompt) {
  let out = prompt;

  // Remove a seção inteira "# PROFISSIONAL SECUNDÁRIO ..." até o próximo "---"
  out = out.replace(
    /\n#\s+PROFISSIONAL SECUND[ÁA]RIO[^\n]*\n[\s\S]*?(?=\n---)/gi,
    "",
  );

  // Limpa placeholders soltos que possam ter sobrado
  out = out
    .replace(/\[NOME_MEDICO_SECUNDARIO\]/g, "nosso especialista")
    .replace(/\[ESPECIALIDADE_SECUNDARIO\]/g, "especialista");

  return out;
}

const list = await fetch(`${SUPABASE_URL}/rest/v1/prompt_templates?select=*`, {
  headers: H,
}).then((r) => r.json());

for (const t of list) {
  const newVars = (t.variables || []).filter((v) => !REMOVE_KEYS.has(v.key));
  const newPrompt = cleanPrompt(t.system_prompt);

  const res = await fetch(`${SUPABASE_URL}/rest/v1/prompt_templates?id=eq.${t.id}`, {
    method: "PATCH",
    headers: H,
    body: JSON.stringify({
      variables: newVars,
      system_prompt: newPrompt,
      atualizado_em: new Date().toISOString(),
    }),
  });

  if (!res.ok) {
    console.error(`❌ ${t.nome}: ${res.status} ${await res.text()}`);
  } else {
    const removed = (t.variables || []).length - newVars.length;
    const remaining =
      (newPrompt.match(/\[NOME_MEDICO_SECUNDARIO\]/g) || []).length +
      (newPrompt.match(/\[ESPECIALIDADE_SECUNDARIO\]/g) || []).length;
    console.log(
      `✅ ${t.nome}: removidas ${removed} var(s), placeholders restantes: ${remaining}`,
    );
  }
}
