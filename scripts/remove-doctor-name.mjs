/**
 * Remove a variável NOME_MEDICO_PRINCIPAL (settings_key: doctor_name) de todos
 * os templates e neutraliza as referências [NOME_MEDICO_PRINCIPAL] no prompt.
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

function neutralizeDoctor(prompt) {
  // Substitui [NOME_MEDICO_PRINCIPAL] por linguagem neutra conforme contexto.
  return prompt
    // "ao [NOME_MEDICO_PRINCIPAL]" → "à nossa equipe"
    .replace(/ao \[NOME_MEDICO_PRINCIPAL\]/g, "à nossa equipe")
    // "com [NOME_MEDICO_PRINCIPAL]" → "com nossa equipe"
    .replace(/com \[NOME_MEDICO_PRINCIPAL\]/g, "com nossa equipe")
    // "[NOME_MEDICO_PRINCIPAL] avalia" → "nossa equipe avalia"
    .replace(/\[NOME_MEDICO_PRINCIPAL\] avalia/g, "nossa equipe avalia")
    // qualquer remanescente → "nossa equipe"
    .replace(/\[NOME_MEDICO_PRINCIPAL\]/g, "nossa equipe");
}

const list = await fetch(`${SUPABASE_URL}/rest/v1/prompt_templates?select=*`, {
  headers: H,
}).then((r) => r.json());

for (const t of list) {
  const newVars = (t.variables || []).filter((v) => v.key !== "NOME_MEDICO_PRINCIPAL");
  const newPrompt = neutralizeDoctor(t.system_prompt);

  const patch = {
    variables: newVars,
    system_prompt: newPrompt,
    atualizado_em: new Date().toISOString(),
  };

  const res = await fetch(`${SUPABASE_URL}/rest/v1/prompt_templates?id=eq.${t.id}`, {
    method: "PATCH",
    headers: H,
    body: JSON.stringify(patch),
  });

  if (!res.ok) {
    console.error(`❌ ${t.nome}: ${res.status} ${await res.text()}`);
  } else {
    const removed = (t.variables || []).length - newVars.length;
    const remaining = (newPrompt.match(/\[NOME_MEDICO_PRINCIPAL\]/g) || []).length;
    console.log(
      `✅ ${t.nome}: removidas ${removed} var(s), placeholders restantes: ${remaining}`,
    );
  }
}
