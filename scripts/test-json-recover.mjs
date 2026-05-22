// Teste do recoverTruncatedJson com o caso real do log.

function recoverTruncatedJson(raw) {
  let s = raw.trim();
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

// Casos de teste
const cases = [
  {
    name: "campo sem valor (caso real do log)",
    input: '{"reply":"Poxa, sinto muito!","next_stage":"QUALIFICATION","lead_data_patch":{"interest":',
  },
  {
    name: "string truncada no meio",
    input: '{"reply":"Olá, tudo b',
  },
  {
    name: "vírgula trailing",
    input: '{"reply":"Olá","next_stage":"RECEPTION",',
  },
  {
    name: "objeto aninhado aberto",
    input: '{"reply":"Olá","lead_data_patch":{"name":"João",',
  },
  {
    name: "campo com valor parcial",
    input: '{"reply":"Olá","next_stage":"QUALIFICATION","lead_data_patch":{"interest":"IMP',
  },
];

for (const c of cases) {
  try {
    const result = recoverTruncatedJson(c.input);
    console.log(`✅ ${c.name}`);
    console.log("   →", JSON.stringify(result));
  } catch (e) {
    console.log(`❌ ${c.name}: ${e.message}`);
  }
}
