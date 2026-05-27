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

export function buildTemplateVars(ctx: AgentContext): Record<string, string> {
  const s = ctx.agentSettings;
  const ld = ctx.leadData;
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
  out = out.replace(/\{([a-zA-Z0-9_]+)\}/g, (_, key: string) => vars[key] ?? "");
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

  const prevAssistant = history
    .slice(0, lastUserIdx)
    .reverse()
    .find((m) => m.role === "assistant");
  if (!prevAssistant) return {};

  const field = missing[0]!;
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
