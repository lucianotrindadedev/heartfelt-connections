// Templates de agendamento (Google Calendar) e campos coletados antes do booking.
// Agnóstico de vertical: clínica, escola, etc.

import type { LeadData } from "@/lib/agents/stage";
import type { AgentContext } from "@/lib/agents/context";

export interface BookingFieldDef {
  /** Chave em lead_data.custom_fields (ou "name" para lead_data.name). */
  key: string;
  label: string;
  /** Pergunta sugerida ao lead (1 por turno). */
  question: string;
  required?: boolean;
  /** Se "name", grava em lead_data.name em vez de custom_fields. */
  maps_to?: "name";
}

export const GCAL_TEMPLATE_VARS = [
  { key: "{name}", desc: "Nome do responsável / lead" },
  { key: "{child_name}", desc: "Nome da criança (custom_fields)" },
  { key: "{child_birth_date}", desc: "Data de nascimento da criança" },
  { key: "{guardians}", desc: "Nome dos responsáveis" },
  { key: "{interest}", desc: "Interesse identificado" },
  { key: "{company_name}", desc: "Nome da empresa/escola/clínica" },
  { key: "{doctor_name}", desc: "Profissional / consultor principal" },
  { key: "{appointment_type}", desc: "Tipo do agendamento (ex: Visita guiada)" },
  { key: "{slot_date}", desc: "Data do horário escolhido" },
  { key: "{slot_time}", desc: "Horário escolhido" },
  { key: "{notes}", desc: "Notas do lead" },
  { key: "{phone}", desc: "Telefone do lead" },
  { key: "{custom.campo}", desc: "Qualquer campo customizado coletado" },
] as const;

export const DEFAULT_BOOKING_FIELDS_CLINIC: BookingFieldDef[] = [
  {
    key: "name",
    label: "Nome completo",
    question: "Perfeito. Para finalizar, me envia por favor seu nome completo?",
    required: true,
    maps_to: "name",
  },
];

export const DEFAULT_BOOKING_FIELDS_SCHOOL: BookingFieldDef[] = [
  {
    key: "child_name",
    label: "Nome da criança",
    question: "Perfeito! Qual é o nome da sua criança?",
    required: true,
  },
  {
    key: "child_birth_date",
    label: "Data de nascimento",
    question: "E qual é a data de nascimento dela?",
    required: true,
  },
  {
    key: "guardians",
    label: "Responsáveis",
    question: "Agora me informa, por favor, o nome dos responsáveis.",
    required: true,
  },
];

export function parseBookingFieldsJson(raw: string | undefined): BookingFieldDef[] {
  if (!raw?.trim()) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((x) => x && typeof x === "object")
      .map((x) => {
        const o = x as Record<string, unknown>;
        return {
          key: String(o.key ?? "").trim(),
          label: String(o.label ?? o.key ?? "").trim(),
          question: String(o.question ?? "").trim(),
          required: o.required !== false,
          maps_to: o.maps_to === "name" ? ("name" as const) : undefined,
        };
      })
      .filter((f) => f.key && f.question);
  } catch {
    return [];
  }
}

export function getBookingFields(settings: Record<string, string>): BookingFieldDef[] {
  const parsed = parseBookingFieldsJson(settings.booking_fields_json);
  if (parsed.length > 0) return parsed;

  const companyType = (settings.company_type ?? "").toLowerCase();
  const role = (settings.assistant_role ?? "").toLowerCase();
  if (
    companyType.includes("escola") ||
    companyType.includes("educa") ||
    role.includes("escola") ||
    settings.appointment_type_label?.toLowerCase().includes("visita")
  ) {
    return DEFAULT_BOOKING_FIELDS_SCHOOL;
  }
  return DEFAULT_BOOKING_FIELDS_CLINIC;
}

function getFieldValue(
  key: string,
  mapsTo: "name" | undefined,
  ld: LeadData,
): string | undefined {
  if (mapsTo === "name" || key === "name") {
    return ld.name?.trim() || undefined;
  }
  const v = ld.custom_fields?.[key];
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

export function getMissingBookingFields(
  fields: BookingFieldDef[],
  ld: LeadData,
): BookingFieldDef[] {
  return fields.filter((f) => {
    if (!f.required) return false;
    return !getFieldValue(f.key, f.maps_to, ld);
  });
}

export function getNextBookingFieldQuestion(
  fields: BookingFieldDef[],
  ld: LeadData,
): BookingFieldDef | null {
  const missing = getMissingBookingFields(fields, ld);
  return missing[0] ?? null;
}

export function buildBookingFieldsPromptBlock(fields: BookingFieldDef[], ld: LeadData): string {
  if (fields.length === 0) return "";

  const collected = fields
    .map((f) => {
      const v = getFieldValue(f.key, f.maps_to, ld);
      return v ? `- ${f.label} (${f.key}): ${v}` : null;
    })
    .filter(Boolean)
    .join("\n");

  const missing = getMissingBookingFields(fields, ld);
  const missingLines = missing.map((f) => `- ${f.key}: "${f.question}"`).join("\n");

  return `# CAMPOS OBRIGATÓRIOS ANTES DO AGENDAMENTO

${collected ? `Já coletados:\n${collected}\n` : ""}
${missing.length > 0 ? `Ainda faltam (pergunte UM por vez, use lead_data_patch.custom_fields ou name):\n${missingLines}` : "Todos os campos obrigatórios já foram coletados — pode avançar para BOOKING após confirmação de compromisso (se configurada)."}

Regra: salve respostas em lead_data_patch:
- name → lead_data_patch.name
- demais campos → lead_data_patch.custom_fields.{key}`;
}

function formatSlotParts(iso: string | undefined): { date: string; time: string } {
  if (!iso) return { date: "", time: "" };
  try {
    const d = new Date(iso);
    return {
      date: new Intl.DateTimeFormat("pt-BR", {
        timeZone: "America/Sao_Paulo",
        weekday: "long",
        day: "2-digit",
        month: "2-digit",
        year: "numeric",
      }).format(d),
      time: new Intl.DateTimeFormat("pt-BR", {
        timeZone: "America/Sao_Paulo",
        hour: "2-digit",
        minute: "2-digit",
      }).format(d),
    };
  } catch {
    return { date: "", time: "" };
  }
}

export function looksLikeBirthDate(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  if (/^\d{1,2}[\/\-.]\d{1,2}[\/\-.]\d{2,4}$/.test(t)) return true;
  if (/^\d{1,2}\s+de\s+[a-zà-ú]+(\s+de\s+\d{2,4})?$/i.test(t)) return true;
  return false;
}

function looksLikePersonName(text: string): boolean {
  const t = text.trim();
  if (!t || looksLikeBirthDate(t) || looksLikeSchedulingPreference(t)) return false;
  if (/^\d+$/.test(t)) return false;
  return /[\p{L}']/u.test(t);
}

function isBirthDateField(field: BookingFieldDef): boolean {
  const k = field.key.toLowerCase();
  const l = field.label.toLowerCase();
  return k.includes("birth") || k.includes("nasc") || l.includes("nascimento");
}

function isGuardiansField(field: BookingFieldDef): boolean {
  const k = field.key.toLowerCase();
  const l = field.label.toLowerCase();
  return k.includes("guardian") || k.includes("respons") || l.includes("respons");
}

function isChildNameField(field: BookingFieldDef): boolean {
  return field.key === "child_name" || field.label.toLowerCase().includes("criança");
}

function matchFieldFromAssistantQuestion(
  assistantText: string,
  fields: BookingFieldDef[],
): BookingFieldDef | null {
  const t = assistantText.toLowerCase();
  for (const f of fields) {
    const q = f.question.toLowerCase().slice(0, 24);
    if (q.length >= 8 && t.includes(q)) return f;
    if (isBirthDateField(f) && /nascimento|nasceu|data de nasc/i.test(t)) return f;
    if (isChildNameField(f) && /nome da (sua )?crian/i.test(t)) return f;
    if (isGuardiansField(f) && /respons[aá]ve/i.test(t)) return f;
    if ((f.maps_to === "name" || f.key === "name") && /seu nome|nome completo/i.test(t)) {
      return f;
    }
  }
  return null;
}

function inferBookingFieldFromContent(
  text: string,
  missing: BookingFieldDef[],
): BookingFieldDef | null {
  if (looksLikeBirthDate(text)) {
    return missing.find(isBirthDateField) ?? null;
  }
  if (looksLikePersonName(text)) {
    return (
      missing.find(isChildNameField) ??
      missing.find((f) => f.maps_to === "name" || f.key === "name") ??
      missing.find(isGuardiansField) ??
      null
    );
  }
  return null;
}

/** Corrige custom_fields deslocados (ex.: nascimento com nome, responsáveis com data). */
export function normalizeLeadDataForBooking(
  ld: LeadData,
  opts?: { fallbackGuardianName?: string },
): LeadData {
  const cf = { ...(ld.custom_fields ?? {}) };
  const childName = cf.child_name?.trim();
  let birth = cf.child_birth_date?.trim();
  let guardians = cf.guardians?.trim();

  if (
    childName &&
    birth === childName &&
    guardians &&
    looksLikeBirthDate(guardians)
  ) {
    cf.child_birth_date = guardians;
    delete cf.guardians;
    birth = cf.child_birth_date;
    guardians = undefined;
  }

  if (guardians && looksLikeBirthDate(guardians) && (!birth || birth === childName)) {
    cf.child_birth_date = guardians;
    delete cf.guardians;
    birth = cf.child_birth_date;
    guardians = undefined;
  }

  if (birth && looksLikePersonName(birth) && birth === childName) {
    delete cf.child_birth_date;
  }

  if (!cf.guardians?.trim()) {
    const fallback = ld.name?.trim() || opts?.fallbackGuardianName?.trim();
    if (fallback && !looksLikeBirthDate(fallback)) {
      cf.guardians = fallback;
    }
  }

  return { ...ld, custom_fields: cf };
}

export function buildTemplateVars(ctx: AgentContext): Record<string, string> {
  const s = ctx.agentSettings;
  const ld = normalizeLeadDataForBooking(ctx.leadData, {
    fallbackGuardianName: ctx.helenaContact?.name,
  });
  const cf = ld.custom_fields ?? {};
  const { date: slot_date, time: slot_time } = formatSlotParts(ld.selected_slot_iso);
  const interest = ld.interest?.trim() ?? "";

  const vars: Record<string, string> = {
    name: ld.name?.trim() ?? "",
    child_name: cf.child_name?.trim() ?? "",
    child_birth_date: cf.child_birth_date?.trim() ?? "",
    guardians: cf.guardians?.trim() ?? "",
    interest,
    company_name: s.company_name?.trim() ?? "",
    doctor_name: s.doctor_name?.trim() ?? s.contact_person_name?.trim() ?? "",
    appointment_type: s.appointment_type_label?.trim() ?? "Consulta",
    slot_date,
    slot_time,
    notes: ld.notes?.trim() ?? "",
    phone: ctx.effectivePhone ?? ctx.conversationPhone ?? "",
  };

  for (const [k, v] of Object.entries(cf)) {
    vars[`custom.${k}`] = String(v);
  }
  for (const [k, v] of Object.entries(s)) {
    if (!vars[k] && v?.trim()) vars[k] = v.trim();
  }

  return vars;
}

export function renderBookingTemplate(
  template: string,
  vars: Record<string, string>,
  opts?: { preserveNewlines?: boolean },
): string {
  let out = template;
  out = out.replace(/\{custom\.([a-zA-Z0-9_]+)\}/g, (_, key: string) => vars[`custom.${key}`] ?? "");

  const standardKeys = Object.keys(vars)
    .filter((k) => !k.startsWith("custom."))
    .sort((a, b) => b.length - a.length);
  for (const key of standardKeys) {
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    out = out.replace(new RegExp(`\\{${escaped}\\}`, "g"), vars[key] ?? "");
  }

  if (opts?.preserveNewlines) {
    return out
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0)
      .join("\n")
      .trim();
  }
  return out.replace(/\s+/g, " ").trim();
}

export function defaultGcalTitleTemplate(settings: Record<string, string>): string {
  const type = settings.appointment_type_label?.trim() || "Consulta";
  if (type.toLowerCase().includes("visita")) {
    return `${type} - {child_name}`;
  }
  return `${type} - {name}`;
}

export function defaultGcalDescriptionTemplate(settings: Record<string, string>): string {
  const type = (settings.appointment_type_label ?? "").toLowerCase();
  if (type.includes("visita")) {
    return [
      "Criança: {child_name}",
      "Nascimento: {child_birth_date}",
      "Responsáveis: {guardians}",
      "{notes}",
    ].join("\n");
  }
  return "{notes}";
}

export function defaultCommitmentQuestion(settings: Record<string, string>): string {
  if (settings.booking_commitment_question === "") return "";

  const custom = settings.booking_commitment_question?.trim();
  if (custom) return custom;

  const type = (settings.appointment_type_label ?? "").toLowerCase();
  if (type.includes("visita")) {
    return "Posso garantir à equipe que você estará presente na visita?";
  }
  const prof = settings.doctor_name?.trim() || "profissional";
  return `Posso garantir ao ${prof} que você estará presente nesse horário?`;
}

export function resolveGcalEventTemplates(ctx: AgentContext): { titulo: string; descricao: string } {
  const s = ctx.agentSettings;
  const vars = buildTemplateVars(ctx);
  const titleTpl = s.gcal_event_title_template?.trim() || defaultGcalTitleTemplate(s);
  const descTpl = s.gcal_event_description_template?.trim() || defaultGcalDescriptionTemplate(s);

  let titulo = renderBookingTemplate(titleTpl, vars);
  let descricao = renderBookingTemplate(descTpl, vars, { preserveNewlines: true });

  if (!titulo) titulo = renderBookingTemplate(defaultGcalTitleTemplate(s), vars);
  if (!descricao) descricao = ldNotesOnly(ctx);

  return { titulo, descricao };
}

function ldNotesOnly(ctx: AgentContext): string {
  return ctx.leadData.notes?.trim() ?? "";
}

/** Nome do responsável para booking/GCal — fallback para campos da escola. */
export function resolveBookingLeadName(leadData: LeadData): string | undefined {
  if (leadData.name?.trim()) return leadData.name.trim();
  const guardians = leadData.custom_fields?.guardians?.trim();
  if (guardians) {
    const first = guardians.split(/[,;/]|(?:\s+e\s+)/i)[0]?.trim();
    if (first) return first;
  }
  return leadData.custom_fields?.child_name?.trim() || undefined;
}

export function isCommitmentRequired(settings: Record<string, string>): boolean {
  if (settings.booking_commitment_question === "") return false;
  // Só exige confirmação de compromisso se o proprietário configurou pergunta explícita.
  return !!settings.booking_commitment_question?.trim();
}

export function isReadyForBooking(
  leadData: LeadData,
  settings: Record<string, string>,
  opts: { hasPhone: boolean; hasBookingIntegration: boolean },
): boolean {
  if (!opts.hasBookingIntegration || !opts.hasPhone) return false;
  if (leadData.appointment_id) return false;
  if (!leadData.selected_slot_iso) return false;
  if (!resolveBookingLeadName(leadData)) return false;
  if (getMissingBookingFields(getBookingFields(settings), leadData).length > 0) return false;
  if (isCommitmentRequired(settings) && !leadData.commitment_confirmed) return false;
  return true;
}

type OfferedSlot = NonNullable<LeadData["offered_slots"]>[number];

function normalizeTimeLabel(raw: string): string {
  const m = raw.match(/(\d{1,2}):(\d{2})/);
  if (!m) return "";
  return `${m[1]!.padStart(2, "0")}:${m[2]}`;
}

function hourInBrt(iso: string): number {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return -1;
  return Number(
    new Intl.DateTimeFormat("en-US", {
      timeZone: "America/Sao_Paulo",
      hour: "numeric",
      hour12: false,
    }).format(d),
  );
}

/** Lead falando de turno/dia — preferência de horário, não resposta de campo nem nome. */
export function looksLikeSchedulingPreference(text: string): boolean {
  const t = text.trim().toLowerCase();
  if (!t) return false;
  if (
    /^(manh[aã]|tarde|noite|de manh[aã]|de tarde|de noite|periodo|per[ií]odo|hor[aá]rio|turno)[!.?\s]*$/i.test(
      t,
    )
  ) {
    return true;
  }
  if (/\d{1,2}:\d{2}/.test(t)) return false;
  if (
    /manh[aã]|tarde|noite|prefer[oi]|hor[aá]rio|turno|segunda|ter[cç]a|quarta|quinta|sexta|s[aá]bado|domingo|\b\d{1,2}\/\d{1,2}\b/.test(
      t,
    ) &&
    t.length <= 48 &&
    !/^[A-ZÀ-Ú][a-zà-ú]+(\s+[A-ZÀ-Úa-zà-ú]+)+$/.test(text.trim())
  ) {
    return true;
  }
  return false;
}

function pickSlotByPreference(
  slots: OfferedSlot[],
  text: string,
  assistantText: string,
): Partial<LeadData> | null {
  const t = text.toLowerCase();
  const wantMorning = /manh[aã]|de manh[aã]/.test(t);
  const wantAfternoon = /\btarde\b|de tarde/.test(t);
  const wantEvening = /noite|de noite/.test(t);
  if (!wantMorning && !wantAfternoon && !wantEvening) return null;

  let pool = slots;
  const mentioned = slots.filter((s) => slotMentionedInText(s, assistantText));
  if (mentioned.length > 0) pool = mentioned;

  const filtered = pool.filter((s) => {
    const h = hourInBrt(s.iso);
    if (h < 0) return false;
    if (wantMorning) return h < 12;
    if (wantAfternoon) return h >= 12 && h < 18;
    if (wantEvening) return h >= 18;
    return true;
  });
  if (filtered.length === 0) return null;

  filtered.sort((a, b) => new Date(a.iso).getTime() - new Date(b.iso).getTime());
  const s = filtered[0]!;
  return {
    selected_slot_iso: s.iso,
    ...(s.dentist_person_id != null ? { dentist_person_id: s.dentist_person_id } : {}),
  };
}

export function sanitizeLeadDataPatch(patch: Partial<LeadData>): Partial<LeadData> {
  const next: Partial<LeadData> = { ...patch };
  if (next.custom_fields) {
    const cleaned: Record<string, string> = {};
    for (const [k, v] of Object.entries(next.custom_fields)) {
      if (typeof v !== "string") continue;
      if (looksLikeSchedulingPreference(v)) continue;
      if (k.includes("birth") && !looksLikeBirthDate(v) && looksLikePersonName(v)) continue;
      if (k.includes("guardian") && looksLikeBirthDate(v)) continue;
      cleaned[k] = v;
    }
    next.custom_fields = cleaned;
  }
  if (typeof next.name === "string" && looksLikeSchedulingPreference(next.name)) {
    delete next.name;
  }
  return next;
}

function slotMentionedInText(slot: OfferedSlot, text: string): boolean {
  const hay = text.toLowerCase();
  const time = normalizeTimeLabel(slot.time_label);
  if (time && hay.includes(time)) return true;

  for (const part of slot.date_label.split(/[,/]/)) {
    const p = part.trim().toLowerCase();
    if (p.length >= 4 && hay.includes(p.slice(0, Math.min(p.length, 12)))) return true;
  }
  return false;
}

export function isSlotAcceptanceMessage(text: string): boolean {
  const t = text.trim().toLowerCase();
  if (
    /^(pode ser|sim|ok|blz|beleza|confirmo|confirmado|esse|essa|este|esta|perfeito|funciona|pode|vamos|top|fechado|combinado)(?:\s+(?:as?|às|o|a|no|na|em)\s+\d{1,2}:\d{2})?[!.?\s]*$/i.test(
      t,
    )
  ) {
    return true;
  }
  if (/^(o\s+)?primeir[oa]|1ª|1a\b|opção\s*1/i.test(t)) return true;
  if (/^(o\s+)?segund[oa]|2ª|2a\b|opção\s*2/i.test(t)) return true;
  if (/\d{1,2}:\d{2}/.test(t) && /(pode ser|sim|ok|confirmo|esse|essa|este|esta|funciona|prefiro|quero)/i.test(t)) {
    return true;
  }
  return !!normalizeTimeLabel(t);
}

/**
 * Quando o lead aceita um horário ("Pode ser", "Sim", "14:40"), grava
 * selected_slot_iso a partir de offered_slots — evita reservar slot antigo/errado.
 */
export function tryAutoSelectOfferedSlot(
  stage: string,
  leadData: LeadData,
  history: { role: "user" | "assistant"; content: string }[],
): Partial<LeadData> {
  if (stage !== "SLOT_OFFER" && stage !== "NAME_COLLECT" && stage !== "BOOKING") return {};

  const slots = leadData.offered_slots ?? [];
  if (slots.length === 0) return {};

  let lastUserIdx = -1;
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i]!.role === "user") {
      lastUserIdx = i;
      break;
    }
  }
  if (lastUserIdx < 0) return {};

  const lastUser = history[lastUserIdx]!.content.trim();
  if (!lastUser) return {};

  const lastAssistant = history
    .slice(0, lastUserIdx)
    .reverse()
    .find((m) => m.role === "assistant");
  const assistantText = lastAssistant?.content ?? "";

  const prefPatch = pickSlotByPreference(slots, lastUser, assistantText);
  if (prefPatch) return prefPatch;

  if (!isSlotAcceptanceMessage(lastUser)) return {};

  const userTime = normalizeTimeLabel(lastUser);
  if (userTime) {
    const byTime = slots.filter((s) => normalizeTimeLabel(s.time_label) === userTime);
    if (byTime.length === 1) {
      const s = byTime[0]!;
      return {
        selected_slot_iso: s.iso,
        ...(s.dentist_person_id != null ? { dentist_person_id: s.dentist_person_id } : {}),
      };
    }
  }

  if (/^(o\s+)?primeir[oa]|1ª|1a\b|opção\s*1/i.test(lastUser.toLowerCase()) && slots[0]) {
    const s = slots[0];
    return {
      selected_slot_iso: s.iso,
      ...(s.dentist_person_id != null ? { dentist_person_id: s.dentist_person_id } : {}),
    };
  }
  if (/^(o\s+)?segund[oa]|2ª|2a\b|opção\s*2/i.test(lastUser.toLowerCase()) && slots[1]) {
    const s = slots[1];
    return {
      selected_slot_iso: s.iso,
      ...(s.dentist_person_id != null ? { dentist_person_id: s.dentist_person_id } : {}),
    };
  }

  const mentionedInAssistant = slots.filter((s) => slotMentionedInText(s, assistantText));
  if (mentionedInAssistant.length === 1) {
    const s = mentionedInAssistant[0]!;
    return {
      selected_slot_iso: s.iso,
      ...(s.dentist_person_id != null ? { dentist_person_id: s.dentist_person_id } : {}),
    };
  }

  if (slots.length === 1) {
    const s = slots[0]!;
    return {
      selected_slot_iso: s.iso,
      ...(s.dentist_person_id != null ? { dentist_person_id: s.dentist_person_id } : {}),
    };
  }

  return {};
}

export function mergeLeadDataPatch(current: LeadData, patch: Partial<LeadData>): LeadData {
  const next: LeadData = { ...current, ...patch };
  if (patch.custom_fields || current.custom_fields) {
    next.custom_fields = {
      ...(current.custom_fields ?? {}),
      ...(patch.custom_fields ?? {}),
    };
  }
  return next;
}

const MAX_AUTO_CAPTURE_LEN = 200;

function looksLikeQuestion(text: string): boolean {
  return text.trim().endsWith("?");
}

function isShortAffirmative(text: string): boolean {
  return /^(sim|não|nao|ok|blz|beleza|uhum|certo|pode|confirmo|confirmado|yes|no)[!.?\s]*$/i.test(
    text.trim(),
  );
}

/**
 * Em NAME_COLLECT, se o lead acabou de responder a pergunta do campo pendente
 * mas o LLM não gravou em lead_data, captura a última mensagem do usuário.
 */
export function tryAutoCaptureBookingAnswer(
  stage: string,
  leadData: LeadData,
  history: { role: "user" | "assistant"; content: string }[],
  settings: Record<string, string>,
): Partial<LeadData> {
  if (stage !== "NAME_COLLECT") return {};
  if (!leadData.selected_slot_iso) return {};

  const fields = getBookingFields(settings);
  const missing = getMissingBookingFields(fields, leadData);
  if (missing.length === 0) return {};

  let lastUserIdx = -1;
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i]!.role === "user") {
      lastUserIdx = i;
      break;
    }
  }
  if (lastUserIdx < 0) return {};

  const lastUser = history[lastUserIdx]!.content.trim();
  if (!lastUser || lastUser.length > MAX_AUTO_CAPTURE_LEN) return {};
  if (looksLikeQuestion(lastUser)) return {};
  if (isSlotAcceptanceMessage(lastUser)) return {};
  if (looksLikeSchedulingPreference(lastUser)) return {};

  const prevAssistant = history
    .slice(0, lastUserIdx)
    .reverse()
    .find((m) => m.role === "assistant");
  if (!prevAssistant) return {};

  const field =
    matchFieldFromAssistantQuestion(prevAssistant.content, missing) ??
    inferBookingFieldFromContent(lastUser, missing) ??
    missing[0]!;

  if (isBirthDateField(field) && !looksLikeBirthDate(lastUser)) return {};
  if (isChildNameField(field) && looksLikeBirthDate(lastUser)) {
    const birthField = missing.find(isBirthDateField);
    if (!birthField) return {};
    if (field.maps_to === "name" || field.key === "name") {
      return { name: lastUser };
    }
    return { custom_fields: { [birthField.key]: lastUser } };
  }
  if (isGuardiansField(field) && looksLikeBirthDate(lastUser)) {
    const birthField = missing.find(isBirthDateField);
    if (birthField) {
      return { custom_fields: { [birthField.key]: lastUser } };
    }
    return {};
  }

  if (isShortAffirmative(lastUser) && field.maps_to !== "name" && field.key !== "name") {
    return {};
  }

  if (field.maps_to === "name" || field.key === "name") {
    return { name: lastUser };
  }

  return {
    custom_fields: {
      [field.key]: lastUser,
    },
  };
}
