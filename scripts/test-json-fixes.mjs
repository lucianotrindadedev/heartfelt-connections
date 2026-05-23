// Teste das funções de recuperação de JSON do callLlmStructured.

function fixUnescapedNewlinesInStrings(raw) {
  let result = "";
  let inString = false;
  let escapeNext = false;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (escapeNext) { result += c; escapeNext = false; continue; }
    if (c === "\\") { result += c; escapeNext = true; continue; }
    if (c === '"') { result += c; inString = !inString; continue; }
    if (inString) {
      if (c === "\n") { result += "\\n"; continue; }
      if (c === "\r") { result += "\\r"; continue; }
      if (c === "\t") { result += "\\t"; continue; }
    }
    result += c;
  }
  return result;
}

function recoverTruncatedJson(raw) {
  let s = fixUnescapedNewlinesInStrings(raw).trim();
  let inString = false;
  let escapeNext = false;
  const stack = [];
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (escapeNext) { escapeNext = false; continue; }
    if (c === "\\") { escapeNext = true; continue; }
    if (c === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (c === "{") stack.push("}");
    else if (c === "[") stack.push("]");
    else if (c === "}" || c === "]") stack.pop();
  }
  if (inString) s += '"';
  s = s.replace(/,\s*$/, "");
  s = s.replace(/[,{[]?\s*"[^"]*"\s*:\s*$/, (m) => (m.startsWith("{") ? "{" : ""));
  s = s.replace(/[,{[]?\s*"[^"]*"\s*:\s*""\s*$/, (m) => (m.startsWith("{") ? "{" : ""));
  s = s.replace(/,\s*$/, "");
  while (stack.length > 0) s += stack.pop();
  return JSON.parse(s);
}

// Caso real do log do user
const realCase = `{
  "reply": "Entendi, Luciano! É uma excelente forma de atrair mais pacientes para sua clínica.

Para te ajudar melhor, qual é o principal objetivo que você busca alcançar com o tráfego pago na sua clínica?",
  "next_stage": "QUALIFICATION",
  "lead_data_patch": {
    "interest": "interesse-trafego`;

const cases = [
  {
    name: "Caso REAL do log: newlines literais + truncamento",
    input: realCase,
  },
  {
    name: "Newlines literais sem truncamento",
    input: `{"reply": "Linha 1
Linha 2", "next_stage": "QUALIFICATION"}`,
  },
  {
    name: "Truncamento sem newlines",
    input: '{"reply":"Olá","next_stage":"QUALIFICATION","lead_data_patch":{"interest":',
  },
  {
    name: "JSON válido completo (não deve quebrar)",
    input: '{"reply":"Tudo bem","next_stage":"RECEPTION"}',
  },
];

for (const c of cases) {
  console.log(`\n=== ${c.name} ===`);
  try {
    const parsed = JSON.parse(c.input);
    console.log("✅ Parse direto OK:", JSON.stringify(parsed));
  } catch {
    try {
      const parsed = JSON.parse(fixUnescapedNewlinesInStrings(c.input));
      console.log("✅ Parse após fixNewlines OK:", JSON.stringify(parsed));
    } catch {
      try {
        const parsed = recoverTruncatedJson(c.input);
        console.log("✅ Recover OK:", JSON.stringify(parsed));
      } catch (e) {
        console.log("❌ FALHOU:", e.message);
      }
    }
  }
}
