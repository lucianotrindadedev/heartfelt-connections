/**
 * Insere/atualiza o template "Agente Odontológico — Google Calendar".
 *
 * Reaproveita o system_prompt do template Clinicorp e troca as referências de
 * ferramentas (listar_horarios_clinicorp → listar_horarios_google_calendar etc).
 *
 * Uso: node scripts/seed-template-gcal.mjs
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

const HEADERS = {
  apikey: SERVICE_KEY,
  Authorization: `Bearer ${SERVICE_KEY}`,
  "Content-Type": "application/json",
};

// 1. Busca o template Clinicorp para reaproveitar prompt + variables
const baseRes = await fetch(
  `${SUPABASE_URL}/rest/v1/prompt_templates?integration_type=eq.clinicorp&select=system_prompt,variables`,
  { headers: HEADERS },
);
const baseList = await baseRes.json();
if (!Array.isArray(baseList) || baseList.length === 0) {
  console.error("❌  Template Clinicorp base não encontrado");
  process.exit(1);
}
const base = baseList[0];

// 2. Adapta o system_prompt: troca referências a tools Clinicorp por Google Calendar
let prompt = base.system_prompt;

const replacements = [
  // Tools Clinicorp → Google Calendar
  [/listar_horarios_clinicorp/g, "listar_horarios_google_calendar"],
  [/agendar_clinicorp/g, "agendar_google_calendar"],
  [/buscar_paciente_clinicorp/g, "buscar_agendamentos_google_calendar"],
  [/buscar_agendamentos_clinicorp/g, "buscar_agendamentos_google_calendar"],
  [/cancelar_agendamento_clinicorp/g, "cancelar_agendamento_google_calendar"],
  // Conceitos: o Google Calendar não tem "paciente" pré-cadastrado — só eventos
  [
    /## 1\. Regra do 1º ciclo[\s\S]*?\*\*Nunca confirme ao paciente antes do retorno de sucesso da ferramenta\.\*\*/,
    `## 1. Regra do 1º ciclo
No 1º ciclo (primeira resposta), nenhuma ferramenta pode ser executada. Foque em se apresentar e perguntar o nome.

## 2. Tags de interesse (a partir do 2º ciclo)
Quando o interesse estiver identificado com segurança:
1. \`helena_listar_tags\` → obtém os nomes exatos das tags disponíveis
2. \`helena_add_tags\` → aplica a tag de interesse correspondente

Nunca invente nomes de tags.

## 3. Verificar agendamento já existente
Antes de oferecer horários, sempre chame \`buscar_agendamentos_google_calendar\` para verificar se o contato já não tem agendamento futuro. Se já existir, confirme o horário com o lead em vez de criar outro.

## 4. Consulta de horários disponíveis
Antes de oferecer qualquer horário:
1. \`listar_horarios_google_calendar\` com:
   - \`periodo_inicio\` e \`periodo_fim\` em ISO 8601 com fuso (-03:00)
   - \`tamanho_janela_minutos\`: duração da consulta (ex: 40)
   - \`granularidade\`: espaçamento entre slots (ex: 30)
   - \`amostras\`: número de opções (use 2)
2. Priorize hoje até 3 dias à frente
3. Selecione no máximo 2 horários reais retornados pela ferramenta

**Nunca ofereça horário sem consultar a ferramenta primeiro.**

## 5. Criação do agendamento
Somente após: lead escolheu horário ✓ + nome completo coletado ✓ + comprometimento confirmado ✓

\`agendar_google_calendar\` com:
- \`evento_inicio\`: ISO 8601 do slot escolhido
- \`duracao_minutos\`: duração configurada
- \`titulo\`: "Consulta - [NOME COMPLETO]"
- \`descricao\`: queixa principal / interesse do lead

**Nunca confirme ao paciente antes do retorno de sucesso da ferramenta.**`,
  ],
];

for (const [re, val] of replacements) {
  prompt = prompt.replace(re, val);
}

// 3. Variables: as mesmas do Clinicorp (mesmo formato de configuração)
const variables = base.variables;

// 4. Upsert do template
const templateData = {
  nome: "Agente Odontológico — Google Calendar",
  descricao:
    "Fluxo completo de atendimento para clínicas odontológicas: qualificação SPIN, agendamento via Google Calendar (com janelas baseadas no expediente cadastrado), etiquetagem de interesse e escalada humana.",
  system_prompt: prompt,
  integration_type: "google_calendar",
  categoria: "saude",
  ordem: 20,
  ativo: true,
  variables,
  cover_url: null,
};

// Verifica se já existe
const existRes = await fetch(
  `${SUPABASE_URL}/rest/v1/prompt_templates?integration_type=eq.google_calendar&select=id`,
  { headers: HEADERS },
);
const existList = await existRes.json();

let res;
if (Array.isArray(existList) && existList.length > 0) {
  const id = existList[0].id;
  console.log(`🔄  Atualizando template existente (${id})...`);
  res = await fetch(`${SUPABASE_URL}/rest/v1/prompt_templates?id=eq.${id}`, {
    method: "PATCH",
    headers: { ...HEADERS, Prefer: "return=representation" },
    body: JSON.stringify({
      ...templateData,
      atualizado_em: new Date().toISOString(),
    }),
  });
} else {
  console.log("🆕  Criando novo template Google Calendar...");
  res = await fetch(`${SUPABASE_URL}/rest/v1/prompt_templates`, {
    method: "POST",
    headers: { ...HEADERS, Prefer: "return=representation" },
    body: JSON.stringify(templateData),
  });
}

const body = await res.text();
if (!res.ok) {
  console.error(`❌  Falha: ${res.status}`);
  console.error(body);
  process.exit(1);
}

const result = JSON.parse(body);
console.log("✅  Template Google Calendar salvo!");
console.log(`   ID: ${Array.isArray(result) ? result[0].id : result.id}`);
console.log(`   Nome: ${templateData.nome}`);
console.log(`   Variáveis: ${variables.length}`);
console.log(`   Tamanho do prompt: ${prompt.length} caracteres`);
