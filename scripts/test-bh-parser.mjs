// Teste do parser parseDisponibilidadeFromSettings com o JSON real da UI.

function removeAcento(str) {
  return (str || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

const SHORT_DAY_MAP = {
  dom: "domingo", seg: "segunda", ter: "terca",
  qua: "quarta", qui: "quinta", sex: "sexta", sab: "sabado",
};

function parseDisponibilidadeFromSettings(raw) {
  if (!raw) return {};
  try {
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (!parsed || typeof parsed !== "object") return {};

    const out = {};
    for (const [k, v] of Object.entries(parsed)) {
      const lower = removeAcento(k);
      const key = SHORT_DAY_MAP[lower] ?? lower;

      if (Array.isArray(v)) {
        out[key] = v.filter((b) => b && typeof b.inicio === "string" && typeof b.fim === "string");
      } else if (v && typeof v === "object") {
        const obj = v;
        const isActive = obj.active !== false && obj.enabled !== false;
        if (!isActive) {
          out[key] = [];
          continue;
        }
        const start = obj.start || obj.inicio || "";
        const end = obj.end || obj.fim || "";
        const lunchStart = obj.lunch_start || "";
        const lunchEnd = obj.lunch_end || "";

        if (!start || !end) {
          out[key] = [];
          continue;
        }

        if (lunchStart && lunchEnd && lunchStart < lunchEnd && lunchStart > start && lunchEnd < end) {
          out[key] = [
            { inicio: start, fim: lunchStart },
            { inicio: lunchEnd, fim: end },
          ];
        } else {
          out[key] = [{ inicio: start, fim: end }];
        }
      }
    }
    return out;
  } catch {
    return {};
  }
}

// ── Caso 1: JSON real da UI (BusinessHoursEditor) ──
const ui = JSON.stringify({
  dom: { active: false, start: "08:00", lunch_start: "12:00", lunch_end: "13:00", end: "18:00" },
  seg: { active: true, start: "08:00", lunch_start: "12:00", lunch_end: "13:00", end: "18:00" },
  ter: { active: true, start: "08:00", lunch_start: "12:00", lunch_end: "13:00", end: "18:00" },
  qua: { active: true, start: "08:00", lunch_start: "12:00", lunch_end: "13:00", end: "18:00" },
  qui: { active: true, start: "08:00", lunch_start: "12:00", lunch_end: "13:00", end: "18:00" },
  sex: { active: true, start: "08:00", lunch_start: "12:00", lunch_end: "13:00", end: "18:00" },
  sab: { active: false, start: "08:00", lunch_start: "12:00", lunch_end: "13:00", end: "13:00" },
});

console.log("Caso 1: JSON do BusinessHoursEditor da UI");
console.log(JSON.stringify(parseDisponibilidadeFromSettings(ui), null, 2));

// ── Caso 2: formato n8n (array de blocos) ──
const n8n = JSON.stringify({
  segunda: [{ inicio: "09:00", fim: "19:00" }],
  terca: [{ inicio: "09:00", fim: "19:00" }],
  quarta: [{ inicio: "09:00", fim: "19:00" }],
  sabado: [],
});
console.log("\nCaso 2: formato n8n");
console.log(JSON.stringify(parseDisponibilidadeFromSettings(n8n), null, 2));

// ── Caso 3: vazio ──
console.log("\nCaso 3: vazio");
console.log(JSON.stringify(parseDisponibilidadeFromSettings("")));
console.log(JSON.stringify(parseDisponibilidadeFromSettings(null)));
