// Agradecimento ou "ok" do lead NÃO é pedido para mexer no agendamento.
//
// Caso real (Clínica Bomfim, 19/11/2026): a paciente remarcou de 19/11 para
// 23/11 às 19:00, a remarcação deu certo, e ela respondeu só "Obrigada". O
// modelo chamou remarcar_agendamento de novo: o agendamento recém-criado virou
// o "antigo" de uma nova remarcação, as 19:00 sumiram da oferta (ocupadas por
// ela mesma) e a conversa virou uma sequência de horários errados (18:00, depois
// 30/11) — enquanto a agenda real estava certa em 23/11 às 19:00.

/** Agradecimento: precisa haver ao menos um destes. */
const AGRADECIMENTO = new Set([
  "obrigado", "obrigada", "obrigadao", "obrigadinha", "obrigadinho", "obg", "obgd", "obgda", "brigado", "brigada",
  "grato", "grata", "gratidao", "valeu", "vlw", "agradeco", "agradecida", "agradecido",
]);

/** Pode acompanhar o agradecimento ("ok, obrigada", "perfeito, valeu!"). */
const ENCHIMENTO = new Set([
  "ok", "okay", "okey", "blz", "beleza", "certo", "certinho", "combinado", "fechado", "perfeito",
  "otimo", "otima", "show", "top", "maravilha", "joia", "entendi", "anotado", "amem", "bom", "bem", "legal",
  "muito", "muita", "mto", "mt", "mesmo", "demais", "ta", "tah", "esta", "boa", "tudo", "entao", "e",
  "a", "o", "voce", "voces", "vc", "vcs", "pela", "pelo", "ajuda", "atencao", "atendimento", "deus", "abencoe",
  "te", "de", "nada", "dia", "tarde", "noite", "ate", "la", "aguardo", "fico", "no", "aguardando", "kkk", "rs",
]);

function tokens(texto: string): string[] {
  return (texto ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * true = a mensagem é só um agradecimento ("Obrigada", "ok, valeu",
 * "perfeito, obrigada!"). "ok"/"certo"/"perfeito" SOZINHOS não contam: depois
 * de "quer remarcar?" eles são consentimento. Qualquer palavra de pedido
 * ("remarcar", "outro", "não", "sim", datas, horas) faz devolver false.
 */
export function ehSoAgradecimento(texto: string): boolean {
  const ts = tokens(texto);
  if (ts.length === 0 || ts.length > 8) return false;
  let agradeceu = false;
  for (const t of ts) {
    if (AGRADECIMENTO.has(t)) agradeceu = true;
    else if (!ENCHIMENTO.has(t)) return false;
  }
  return agradeceu;
}

/** A nossa última fala perguntou se o lead quer remarcar/cancelar/trocar? */
export function perguntouSobreMudarAgendamento(ultimaNossa: string): boolean {
  const t = (ultimaNossa ?? "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
  return /\?/.test(t) && /(remarc|reagend|cancel|desmarc|trocar|mudar|outro (dia|horario)|outra data)/.test(t);
}

/** Falas do lead depois da última fala nossa (a rajada atual). */
export function falasAtuaisDoLead(history: { role: "user" | "assistant"; content: string }[]): string[] {
  const out: string[] = [];
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i]!;
    if (m.role !== "user") break;
    out.unshift(m.content ?? "");
  }
  return out;
}
