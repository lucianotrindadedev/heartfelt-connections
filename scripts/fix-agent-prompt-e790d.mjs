// Corrige o system_prompt do agente E790D (a182a0ee) que estava oferecendo
// horários sem antes consultar listar_horarios_google_calendar.
//
// Falhas identificadas:
//   1. PASSO 7 afirmava "horários disponíveis são 10h ou 13h" SEM consultar
//      a tool primeiro — inventava a oferta.
//   2. Não verificava o dia da semana antes de oferecer (sábado/domingo a
//      clínica está fechada — business_hours_json marca como inativo).
//   3. PASSO 8 só consultava DEPOIS do lead escolher, mas a mensagem do
//      PASSO 7 já fazia afirmação falsa.
//   4. Não havia bloqueio explícito para dias fora do expediente.

import { readFileSync } from "fs";

const env = Object.fromEntries(
  readFileSync(".env", "utf8")
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

const AGENT_ID = "a182a0ee-21fd-4bfc-9d1e-94b8aa47d041";

const current = await fetch(
  `${SUPABASE_URL}/rest/v1/agents?id=eq.${AGENT_ID}&select=system_prompt`,
  { headers: H },
).then((r) => r.json());
let prompt = current[0].system_prompt;
console.log(`Original: ${prompt.length} chars`);

// ── FIX 1: PASSO 7 — primeiro consultar tool, depois oferecer
const oldPasso7 = `### PASSO 7 — Conduzir ao agendamento

> "Os horários disponíveis pra essa reunião são **10h da manhã** ou **13h da tarde**. Qual fica melhor pra você?"

(após resposta)

> "Perfeito. E prefere ser **hoje** ou **amanhã**?"

### PASSO 8 — Verificar disponibilidade real

Antes de confirmar, **consulte a agenda** via \`listar_horarios_google_calendar\` para o dia/horário escolhido.

Se disponível: avance para PASSO 9. Se ocupado: ofereça a outra opção (10h ou 13h) do mesmo dia ou do dia seguinte. **Nunca invente outro horário.**`;

const newPasso7 = `### PASSO 7 — Conduzir ao agendamento (REGRA OBRIGATÓRIA)

**ANTES de mencionar qualquer horário ao lead**, faça as seguintes verificações:

1. **Pergunte primeiro qual o melhor dia**:

   > "Pra essa reunião, você prefere ser **hoje**, **amanhã** ou outro dia útil dessa semana?"

2. **Verifique se o dia escolhido é dia útil da E790D**:
   Expediente atual: **Segunda a Sexta**, das **08h às 18h** (almoço 12h–13h).
   Sábado e Domingo: **FECHADO**. Feriados: **FECHADO**.

   - Se o lead pedir um sábado, domingo ou feriado, responda:
     > "Nesse dia o consultor não atende. O próximo dia disponível é [próximo dia útil]. Tudo bem por esse?"

3. **Consulte a agenda real** via \`listar_horarios_google_calendar\` com período do dia útil escolhido (das 08h às 18h).

4. **Filtre os slots retornados** para considerar APENAS 10h ou 13h disponíveis.

5. **OFEREÇA APENAS os horários que a ferramenta retornou disponíveis**:
   - Se 10h e 13h livres no dia → "Tenho **10h** ou **13h**. Qual prefere?"
   - Se só 10h livre → "Tenho **10h** disponível nesse dia. Posso reservar pra você?"
   - Se só 13h livre → "Tenho **13h** disponível nesse dia. Posso reservar pra você?"
   - Se nenhum dos dois → "Nesse dia o consultor já não tem 10h nem 13h disponíveis. O próximo dia que tem é [oferecer próximo dia útil consultando a ferramenta de novo]."

**REGRAS ABSOLUTAS — NUNCA QUEBRAR:**

- ❌ NUNCA afirme "os horários disponíveis são X e Y" sem ter chamado \`listar_horarios_google_calendar\` primeiro.
- ❌ NUNCA ofereça horário em sábado, domingo ou feriado.
- ❌ NUNCA ofereça horário fora de 10h ou 13h.
- ❌ NUNCA invente que um horário está livre — só fale o que a ferramenta retornou.
- ✅ Sempre cite o dia (segunda-feira, terça-feira, etc.) ao oferecer o horário, para o lead confirmar.`;

if (prompt.includes(oldPasso7)) {
  prompt = prompt.replace(oldPasso7, newPasso7);
  console.log("✅ PASSO 7 corrigido");
} else {
  console.error("❌ PASSO 7 não encontrado (já foi alterado?)");
  process.exit(1);
}

// ── FIX 2: Reescreve a regra #3 do FLUXO DE FERRAMENTAS
const oldRegra3 = `### 3. Listar disponibilidade

Antes de confirmar o horário escolhido pelo lead, chame \`listar_horarios_google_calendar\` para verificar disponibilidade real.

Parâmetros:

- \`periodo_inicio\` e \`periodo_fim\` em ISO 8601 com fuso (-03:00)
- Janela do dia escolhido (hoje ou amanhã)
- Filtrar apenas slots de **10:00** ou **13:00**

**Nunca ofereça horário diferente de 10h ou 13h, mesmo que outros estejam disponíveis.**`;

const newRegra3 = `### 3. Listar disponibilidade (OBRIGATÓRIO ANTES DE OFERECER)

**SEMPRE** chame \`listar_horarios_google_calendar\` ANTES de mencionar qualquer
horário ao lead. NÃO existe oferta sem consulta prévia.

Antes de chamar a tool:
- Verifique se o dia escolhido é dia útil (Seg–Sex). Se não for, recuse
  educadamente e ofereça o próximo dia útil.
- Verifique se o horário pedido está dentro do expediente (08h–18h, almoço
  12h–13h).

Parâmetros da chamada:
- \`periodo_inicio\` e \`periodo_fim\` em ISO 8601 com fuso (-03:00)
- Janela do dia útil escolhido das 08h às 18h
- \`tamanho_janela_minutos\`: 30 (duração da reunião)
- \`granularidade\`: 30

Depois de receber a resposta:
- Filtre apenas slots que começam às **10:00** ou **13:00**.
- Se houver pelo menos 1 desses, ofereça-o(s) ao lead.
- Se NÃO houver nem 10h nem 13h livres nesse dia, busque o próximo dia
  útil com slots disponíveis (chamada nova da ferramenta).

**Nunca ofereça horário diferente de 10h ou 13h, mesmo que outros estejam disponíveis.**
**Nunca afirme disponibilidade sem ter chamado a ferramenta primeiro.**`;

if (prompt.includes(oldRegra3)) {
  prompt = prompt.replace(oldRegra3, newRegra3);
  console.log("✅ Regra #3 (Listar disponibilidade) reforçada");
} else {
  console.error("❌ Regra #3 não encontrada");
}

// ── FIX 3: Adiciona regra geral no topo do FLUXO DE FERRAMENTAS
const oldFluxoHeader = `## FLUXO DE FERRAMENTAS — REGRAS ABSOLUTAS

### 1. Regra do 1º ciclo`;
const newFluxoHeader = `## FLUXO DE FERRAMENTAS — REGRAS ABSOLUTAS

**REGRA #0 — CONTEXTO DE DATA E EXPEDIENTE:**
- O sistema injeta a data e hora atual no início do prompt. **Use-a sempre**
  para saber qual é o dia da semana antes de oferecer horários.
- Expediente do consultor: **Segunda a Sexta**, 08h–18h (almoço 12h–13h).
  **Sábado, Domingo e Feriados: o consultor NÃO atende.** Você não pode
  oferecer reunião nesses dias — sempre redirecione para o próximo dia útil.
- Antes de aceitar QUALQUER pedido de horário, valide: (a) é dia útil? e
  (b) o horário cabe em 10h ou 13h?

### 1. Regra do 1º ciclo`;

if (prompt.includes(oldFluxoHeader)) {
  prompt = prompt.replace(oldFluxoHeader, newFluxoHeader);
  console.log("✅ Regra #0 (Contexto de data/expediente) adicionada");
} else {
  console.error("❌ Header do FLUXO DE FERRAMENTAS não encontrado");
}

console.log(`Novo prompt: ${prompt.length} chars (diff ${prompt.length - current[0].system_prompt.length})`);

// ── UPDATE no banco
const res = await fetch(`${SUPABASE_URL}/rest/v1/agents?id=eq.${AGENT_ID}`, {
  method: "PATCH",
  headers: H,
  body: JSON.stringify({ system_prompt: prompt }),
});
if (!res.ok) {
  console.error("❌ Falha no UPDATE:", res.status, await res.text());
  process.exit(1);
}
console.log("✅ Agente atualizado no banco");
