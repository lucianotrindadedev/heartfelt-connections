// Templates de agendamento (Google Calendar) e campos coletados antes do booking.
// Agnóstico de vertical: clínica, escola, etc.

import type { LeadData } from "@/lib/agents/stage";
import type { AgentContext } from "@/lib/agents/context";
import type { ConversationChannel } from "@/lib/conversation-channel.server";

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

export interface BookingChannelContext {
  channel: ConversationChannel;
  effectivePhone: string | null | undefined;
}

export function isPhoneRelatedBookingField(field: BookingFieldDef): boolean {
  const k = field.key.toLowerCase();
  const l = field.label.toLowerCase();
  const q = field.question.toLowerCase();
  return (
    k.includes("phone") ||
    k.includes("telefone") ||
    k.includes("celular") ||
    k.includes("whatsapp") ||
    l.includes("telefone") ||
    l.includes("celular") ||
    l.includes("whatsapp") ||
    q.includes("telefone") ||
    q.includes("celular") ||
    q.includes("whatsapp")
  );
}

/** WhatsApp com telefone no contexto → não coletar telefone de novo. */
export function shouldSkipPhoneCollection(
  channel: ConversationChannel,
  effectivePhone: string | null | undefined,
): boolean {
  return channel === "whatsapp" && !!effectivePhone?.trim();
}

/**
 * Telefone que o lead informou na conversa e que ficou salvo em
 * `lead_data.custom_fields` (ex.: whatsapp_phone). Usado como fallback no
 * agendamento quando não há telefone do contexto (`effectivePhone`) — caso de
 * contato de teste sem número no CRM ou canais sem telefone. `normalize` recebe
 * o normalizador de telefone (server-only) por parâmetro para manter este
 * módulo livre de imports de servidor.
 */
export function resolveCollectedPhone(
  fields: BookingFieldDef[],
  ld: LeadData,
  normalize: (raw: string | null | undefined) => string | null,
): string | null {
  const cf = ld.custom_fields ?? {};

  // 1) Campos de telefone declarados no template de booking_fields.
  for (const f of fields) {
    if (!isPhoneRelatedBookingField(f)) continue;
    const norm = normalize(cf[f.key]);
    if (norm) return norm;
  }

  // 2) Qualquer custom_field cuja chave pareça telefone (whatsapp_phone, etc.).
  for (const [k, v] of Object.entries(cf)) {
    const kl = k.toLowerCase();
    if (
      kl.includes("phone") ||
      kl.includes("whatsapp") ||
      kl.includes("telefone") ||
      kl.includes("celular") ||
      kl.includes("fone")
    ) {
      const norm = normalize(v);
      if (norm) return norm;
    }
  }

  return null;
}

/**
 * Chaves que travam a etiquetagem de interesse até serem coletadas.
 *
 * PADRÃO AUTOMÁTICO (sem config): escolas (template MB / MB Escolas) classificam
 * a turma — e portanto a tag (Y226, SK26, ...) — a partir da DATA DE NASCIMENTO.
 * Como o fluxo de escola já tem um campo de data de nascimento nos booking
 * fields, derivamos a trava dele: enquanto não houver data de nascimento válida,
 * o agente não etiqueta. Clínicas (só "name") não têm campo de data → sem trava,
 * seguem etiquetando cedo como antes.
 *
 * OVERRIDE OPCIONAL (interno, raramente necessário): settings.tag_gate_field —
 * uma ou mais chaves de custom_fields separadas por vírgula; "name" = nome do
 * lead. Quando presente, substitui a derivação automática.
 */
function tagGateKeys(settings: Record<string, string>): string[] {
  const explicit = settings.tag_gate_field?.trim();
  if (explicit) return explicit.split(",").map((k) => k.trim()).filter(Boolean);
  // Automático: campo(s) de data de nascimento do fluxo (escola).
  return getBookingFields(settings).filter(isDateFieldKey).map((f) => f.key);
}

/**
 * Retorna a chave do dado que ainda falta para poder etiquetar (ou null se já
 * pode). Para chaves que parecem data (birth/nasc/data), exige que o valor
 * pareça uma data válida — não basta estar preenchido com lixo.
 */
export function tagGateMissingField(
  settings: Record<string, string>,
  ld: LeadData,
): string | null {
  for (const key of tagGateKeys(settings)) {
    const value = (key === "name" ? ld.name : ld.custom_fields?.[key]) ?? "";
    const v = String(value).trim();
    if (!v) return key;
    if (/birth|nasc|data/i.test(key) && !looksLikeBirthDate(v)) return key;
  }
  return null;
}

// ── Classificação determinística de TURMA (Maple Bear / escolas) ────────────
//
// Tira do LLM a decisão de QUAL turma e QUANDO etiquetar: o código calcula a
// turma a partir da DATA DE NASCIMENTO (corte 31/03) e o agente aplica a tag
// certa. Opt-in por agente via settings.turma_auto="true" (e ano letivo de
// referência via settings.turma_ano_letivo, padrão 2026). Sem a flag, NADA muda
// — clínicas e agentes de festa seguem com a etiquetagem normal pelo LLM.

const MONTHS_PT: Record<string, number> = {
  janeiro: 1, fevereiro: 2, marco: 3, "março": 3, abril: 4, maio: 5, junho: 6,
  julho: 7, agosto: 8, setembro: 9, outubro: 10, novembro: 11, dezembro: 12,
};

/** Extrai {year, month, day} de uma data de nascimento em formatos comuns. */
export function parseBirthDateParts(
  raw: string | null | undefined,
): { year: number; month: number; day: number } | null {
  if (!raw?.trim()) return null;
  const t = raw.trim().toLowerCase();

  let day: number, month: number, year: number;
  const numeric = t.match(/\b(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})\b/);
  if (numeric) {
    day = Number(numeric[1]);
    month = Number(numeric[2]);
    year = Number(numeric[3]);
  } else {
    // "25 de julho de 2019" / "25 julho 2019"
    const textual = t.match(/\b(\d{1,2})\s*(?:de\s+)?([a-zçã]+)\s*(?:de\s+)?(\d{4})\b/);
    if (!textual || MONTHS_PT[textual[2]] === undefined) return null;
    day = Number(textual[1]);
    month = MONTHS_PT[textual[2]]!;
    year = Number(textual[3]);
  }

  if (year < 100) year += 2000;
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  if (year < 1990 || year > 2100) return null;
  return { year, month, day };
}

/**
 * Calcula a turma Maple Bear a partir da data de nascimento, com corte em 31/03.
 * `refYear` é o ano letivo de referência (a tabela base é a de 2026). Retorna o
 * nome da turma (ex.: "YEAR 2", "JK", "NURSERY", "BEAR CARE", "FBC") ou null
 * quando não há turma (faixa muito acima da atendida — não etiqueta).
 */
export function classifyMapleBearTurma(
  birthDate: string | null | undefined,
  refYear = 2026,
): string | null {
  const p = parseBirthDateParts(birthDate);
  if (!p) return null;

  // Janela do ano letivo: 01/04 a 31/03. Quem nasce em jan–mar pertence ao
  // "cohort" do ano anterior.
  const cohort = p.month >= 4 ? p.year : p.year - 1;
  // Normaliza para a tabela base de 2026 (cada ano à frente sobe uma turma).
  const ec = cohort - (refYear - 2026);

  if (ec <= 2007) return null; // nascido ≤ 31/03/2008 → não atende, sem tag
  if (ec <= 2019) return `YEAR ${2020 - ec}`; // 2008..2019 → YEAR 12..YEAR 1
  if (ec === 2020) return "SK";
  if (ec === 2021) return "JK";
  if (ec === 2022) return "NURSERY";
  if (ec === 2023) return "TODDLER";
  if (ec === 2024) {
    // BEAR CARE: 01/04–31/10; a partir de 01/11 → futuro BEAR CARE (18 meses).
    return p.month >= 4 && p.month <= 10 ? "BEAR CARE" : "FBC";
  }
  return "FBC"; // ec ≥ 2025 (mais novos) → futuro BEAR CARE
}

/** Agente usa classificação determinística de turma? (opt-in, isolado). */
export function agentUsesTurmaClassifier(settings: Record<string, string>): boolean {
  return settings.turma_auto === "true";
}

/**
 * Nome da turma a etiquetar para o lead atual, ou null. Lê a data de nascimento
 * do campo de data dos booking fields (ou custom_fields.child_birth_date) e
 * classifica. Só atua se o agente tiver turma_auto ligado.
 */
export function turmaTagForLead(
  settings: Record<string, string>,
  ld: LeadData,
): string | null {
  if (!agentUsesTurmaClassifier(settings)) return null;
  const dateField = getBookingFields(settings).find(isDateFieldKey);
  const birth =
    (dateField ? ld.custom_fields?.[dateField.key] : undefined) ??
    ld.custom_fields?.child_birth_date;
  if (!birth) return null;
  const refYear = Number(settings.turma_ano_letivo) || 2026;
  return classifyMapleBearTurma(birth, refYear);
}

export function getBookingFieldsForChannel(
  settings: Record<string, string>,
  channelCtx?: BookingChannelContext,
): BookingFieldDef[] {
  const fields = getBookingFields(settings);
  if (!channelCtx || !shouldSkipPhoneCollection(channelCtx.channel, channelCtx.effectivePhone)) {
    return fields;
  }
  return fields.filter((f) => !isPhoneRelatedBookingField(f));
}

export function buildChannelPhonePromptBlock(
  channel: ConversationChannel,
  effectivePhone: string | null | undefined,
): string {
  if (shouldSkipPhoneCollection(channel, effectivePhone)) {
    return `# TELEFONE — NÃO PERGUNTE

O lead está no **WhatsApp**. Telefone já confirmado: **${effectivePhone}**.

- **NUNCA** peça telefone, celular ou "número para contato".
- Se o prompt do proprietário pedir telefone, **ignore** essa instrução neste canal.
- O agendamento usa esse número automaticamente (GCal / Clinicorp).`;
  }
  if ((channel === "instagram" || channel === "messenger") && !effectivePhone?.trim()) {
    return `# TELEFONE

Canal ${channel}: confirme o WhatsApp do lead antes do agendamento, se ainda não houver telefone no contexto.`;
  }
  return "";
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
    const v = getFieldValue(f.key, f.maps_to, ld);
    if (!v) return true;
    // Campos de nome preenchidos com mensagem de saudacao/intencao
    // contam como MISSING — forca o agente a perguntar de novo em vez
    // de criar um agendamento com lixo no titulo/descricao.
    const isNameField =
      f.key === "child_name" ||
      f.key.includes("child") ||
      f.key.includes("guardian") ||
      f.key.includes("respons") ||
      f.maps_to === "name" ||
      f.key === "name";
    if (isNameField && looksLikeIntentMessage(v)) return true;
    return false;
  });
}

export function getNextBookingFieldQuestion(
  fields: BookingFieldDef[],
  ld: LeadData,
): BookingFieldDef | null {
  const missing = getMissingBookingFields(fields, ld);
  return missing[0] ?? null;
}

// ── Preflight pre-criar_agendamento ─────────────────────────────────────────
//
// Ultima barreira ANTES de chamar criar_agendamento. Detecta campos suspeitos
// que escaparam de sanitizeLeadDataPatch / getMissingBookingFields (cintos +
// suspensorio + air-bag). Se detectar lixo, retorna a lista de chaves para o
// scheduler limpar do lead_data — o orchestrator vai naturalmente forcar o LLM
// a re-perguntar no proximo turn (sem o lead nem perceber).
//
// Aceita os mesmos tipos de "lixo" que sanitizeLeadDataPatch ja rejeita, mas
// aqui validamos o ESTADO ATUAL de lead_data (que pode ter sido contaminado
// por backfill ou por turns anteriores).

export interface PreflightIssue {
  key: string;
  value: string;
  reason:
    | "intent_message_in_name"
    | "too_many_words_in_name"
    | "scheduling_text_in_name"
    | "not_a_date";
}

export interface PreflightResult {
  ok: boolean;
  issues: PreflightIssue[];
}

function isNameFieldKey(field: BookingFieldDef): boolean {
  if (field.maps_to === "name") return true;
  if (field.key === "name") return true;
  const k = field.key.toLowerCase();
  return (
    k.includes("name") ||
    k.includes("nome") ||
    k.includes("child") ||
    k.includes("guardian") ||
    k.includes("respons")
  );
}

function isDateFieldKey(field: BookingFieldDef): boolean {
  const k = field.key.toLowerCase();
  const label = (field.label ?? "").toLowerCase();
  return (
    k.includes("birth") ||
    k.includes("nasciment") ||
    k.includes("data") ||
    label.includes("nasciment") ||
    label.includes("data")
  );
}

export function preflightBookingFields(
  fields: BookingFieldDef[],
  ld: LeadData,
): PreflightResult {
  const issues: PreflightIssue[] = [];

  for (const f of fields) {
    if (!f.required) continue;
    const v = getFieldValue(f.key, f.maps_to, ld);
    if (!v) continue;

    // Date fields tem prioridade sobre name fields. Ex: "child_birth_date"
    // contem "child" mas e claramente uma data.
    const dateField = isDateFieldKey(f);
    const nameField = !dateField && isNameFieldKey(f);

    if (dateField) {
      if (!looksLikeBirthDate(v)) {
        issues.push({ key: f.key, value: v, reason: "not_a_date" });
      }
      continue;
    }

    if (nameField) {
      // Prioridade do mais especifico (palavras-chave de intencao / agendamento)
      // para o mais generico (so contagem de palavras).
      const hasIntentKeyword =
        /\b(ol[aá]|oi|bom dia|boa tarde|boa noite|gostaria|quero|queria|preciso|interesse|informa[cç][oõ]es?|sobre|d[uú]vida|valor|pre[cç]o|mensalidad)\b/i.test(
          v,
        ) || v.trim().endsWith("?");
      if (hasIntentKeyword) {
        issues.push({ key: f.key, value: v, reason: "intent_message_in_name" });
        continue;
      }
      if (looksLikeSchedulingPreference(v) || isSlotAcceptanceMessage(v)) {
        issues.push({ key: f.key, value: v, reason: "scheduling_text_in_name" });
        continue;
      }
      const wordCount = v.split(/\s+/).filter(Boolean).length;
      if (wordCount > 6) {
        issues.push({ key: f.key, value: v, reason: "too_many_words_in_name" });
        continue;
      }
    }
  }

  return { ok: issues.length === 0, issues };
}

/**
 * Retorna LeadData com os campos suspeitos zerados — usado pelo scheduler
 * apos preflightBookingFields detectar lixo. Os campos voltam a constar como
 * MISSING e o LLM e forcado a re-perguntar no proximo turn.
 */
export function clearBookingFields(ld: LeadData, fieldsToClear: BookingFieldDef[]): LeadData {
  if (fieldsToClear.length === 0) return ld;
  const next: LeadData = { ...ld };
  let mutatedCustom = false;
  const customFields = { ...(next.custom_fields ?? {}) };
  for (const f of fieldsToClear) {
    if (f.maps_to === "name" || f.key === "name") {
      delete next.name;
    } else {
      delete customFields[f.key];
      mutatedCustom = true;
    }
  }
  if (mutatedCustom) next.custom_fields = customFields;
  return next;
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
- demais campos → lead_data_patch.custom_fields.{key}

Regra CRÍTICA: se um campo já aparece em "Já coletados" abaixo, NUNCA pergunte de novo.
Telefone do WhatsApp já está disponível (# LEAD_DATA / effectivePhone) — não peça telefone salvo em custom_fields.`;
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

/**
 * Detecta mensagens de saudacao/intencao/qualificacao do lead.
 * Essas mensagens NAO devem ser usadas como resposta de campo de cadastro
 * (nome da crianca, nome dos responsaveis etc).
 *
 * Heuristica conservadora:
 *  - >= 5 palavras (nomes proprios raramente passam disso)
 *  - OU contem verbos/palavras tipicas de intencao
 *  - OU pergunta (termina com ?)
 */
export function looksLikeIntentMessage(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  if (t.endsWith("?")) return true;

  const tl = t.toLowerCase();
  const intentWords =
    /\b(ol[aá]|oi|bom dia|boa tarde|boa noite|gostaria|gostari[ae]|quero|queria|preciso|posso|pode|poderia|tenho|estou|interesse|interessad[oa]|informa[cç][oõ]es?|saber|sobre|d[uú]vida|escola|consulta|atendiment|servi[cç]o|aula|curso|mensalidad|valor|pre[cç]o|hor[aá]rio|disponibilidade|matr[ií]cul|filh[oa]|crian[cç]a|esposa|marido|m[ãa]e|pai|melhor falar|gente|al[ôo])\b/i;
  if (intentWords.test(tl)) return true;

  const wordCount = t.split(/\s+/).filter(Boolean).length;
  if (wordCount >= 5) return true;

  return false;
}

function looksLikePersonName(text: string): boolean {
  const t = text.trim();
  if (!t || looksLikeBirthDate(t) || looksLikeSchedulingPreference(t)) return false;
  if (/^\d+$/.test(t)) return false;
  // Rejeita mensagens de saudacao/intencao — elas nao sao nome de pessoa.
  if (looksLikeIntentMessage(t)) return false;
  // Nome de pessoa raramente passa de 6 palavras.
  const wordCount = t.split(/\s+/).filter(Boolean).length;
  if (wordCount > 6) return false;
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
  let birth: string | undefined = cf.child_birth_date?.trim();
  let guardians: string | undefined = cf.guardians?.trim();

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

  if (!cf.guardians?.trim() && cf.child_birth_date?.trim() && cf.child_name?.trim()) {
    const fallback = ld.name?.trim() || opts?.fallbackGuardianName?.trim();
    if (fallback && !looksLikeBirthDate(fallback) && !looksLikePhoneNumber(fallback)) {
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
    // Também expõe a chave "crua" ({cpf}, {turno}, ...) — o proprietário
    // naturalmente escreve {cpf} no template, igual a {child_name}/{guardians}.
    // Não sobrescreve uma var padrão já definida (name, notes, interest, etc.).
    if (!(k in vars)) vars[k] = String(v);
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

export function resolveGcalEventTemplates(
  ctx: AgentContext,
  overrides?: { titleTemplate?: string; descriptionTemplate?: string },
): { titulo: string; descricao: string } {
  const s = ctx.agentSettings;
  const vars = buildTemplateVars(ctx);
  // Precedência: template específico da agenda (multi-agenda) → global do
  // agente → default derivado do tipo de agendamento.
  const titleTpl =
    overrides?.titleTemplate?.trim() ||
    s.gcal_event_title_template?.trim() ||
    defaultGcalTitleTemplate(s);
  const descTpl =
    overrides?.descriptionTemplate?.trim() ||
    s.gcal_event_description_template?.trim() ||
    defaultGcalDescriptionTemplate(s);

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
  opts: {
    hasPhone: boolean;
    hasBookingIntegration: boolean;
    channel?: ConversationChannel;
    effectivePhone?: string | null;
  },
): boolean {
  if (!opts.hasBookingIntegration || !opts.hasPhone) return false;
  if (leadData.appointment_id) return false;
  if (!leadData.selected_slot_iso) return false;
  if (!resolveBookingLeadName(leadData)) return false;
  const channelCtx =
    opts.channel != null
      ? { channel: opts.channel, effectivePhone: opts.effectivePhone ?? null }
      : undefined;
  if (getMissingBookingFields(getBookingFieldsForChannel(settings, channelCtx), leadData).length > 0) {
    return false;
  }
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

/** Data (YYYY-MM-DD) de um instante no fuso de Brasília. */
function dateInBrt(d: Date): string {
  if (isNaN(d.getTime())) return "";
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d); // en-CA → "YYYY-MM-DD"
}

/**
 * Resolve datas RELATIVAS faladas pelo lead ("hoje", "amanhã", "depois de
 * amanhã") para a data alvo (YYYY-MM-DD em BRT). Retorna null se não houver.
 * IMPORTANTE: "amanhã" contém "manhã" — por isso o match de turno usa \b.
 */
function relativeTargetDateBrt(t: string): string | null {
  const now = Date.now();
  const DAY = 86_400_000;
  // \b só no início: "amanhã" termina em "ã" (não-word), então \b final falha.
  // O \b inicial basta — em "manhã" o "m" abre palavra; dentro de "amanhã" não.
  if (/depois\s+de\s+amanh[aã]/.test(t)) return dateInBrt(new Date(now + 2 * DAY));
  if (/\bamanh[aã]/.test(t)) return dateInBrt(new Date(now + DAY));
  if (/\bhoje\b/.test(t)) return dateInBrt(new Date(now));
  return null;
}

/** Lead falando de turno/dia — preferência de horário, não resposta de campo nem nome. */
export function looksLikeSchedulingPreference(text: string): boolean {
  const t = text.trim().toLowerCase();
  if (!t) return false;
  // Data de nascimento (dd/mm/yyyy) tem prioridade — nunca classifica como preferencia.
  if (looksLikeBirthDate(text)) return false;
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

  // Data relativa ("amanhã", "hoje", "depois de amanhã"). O \b em relativo
  // evita o bug clássico: "amanhã" contém "manhã".
  const targetDate = relativeTargetDateBrt(t);

  // Turno do dia. \b inicial impede "amanhã" de casar como "manhã": o "m"
  // dentro de "amanhã" é precedido por "a" (sem boundary); em "manhã"/"de
  // manhã" o "m" abre palavra.
  const wantMorning = /\bmanh[aã]/.test(t);
  const wantAfternoon = /\btarde/.test(t);
  const wantEvening = /\bnoite/.test(t);

  if (!targetDate && !wantMorning && !wantAfternoon && !wantEvening) return null;

  let pool = slots;
  const mentioned = slots.filter((s) => slotMentionedInText(s, assistantText));
  if (mentioned.length > 0) pool = mentioned;

  let filtered = pool;
  if (targetDate) {
    filtered = filtered.filter((s) => dateInBrt(new Date(s.iso)) === targetDate);
  }
  if (wantMorning || wantAfternoon || wantEvening) {
    filtered = filtered.filter((s) => {
      const h = hourInBrt(s.iso);
      if (h < 0) return false;
      if (wantMorning) return h < 12;
      if (wantAfternoon) return h >= 12 && h < 18;
      if (wantEvening) return h >= 18;
      return true;
    });
  }
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

      // Campos de nome (crianca, responsaveis, nome generico) NUNCA aceitam
      // mensagens de saudacao/intencao tipo "ola gostaria de mais informacoes".
      const isNameField =
        k === "child_name" ||
        k.includes("child") ||
        k.includes("guardian") ||
        k.includes("respons") ||
        k === "name";
      if (isNameField && looksLikeIntentMessage(v)) continue;

      cleaned[k] = v;
    }
    next.custom_fields = cleaned;
  }
  if (typeof next.name === "string") {
    if (looksLikeSchedulingPreference(next.name) || looksLikeIntentMessage(next.name)) {
      delete next.name;
    }
  }
  return next;
}

function slotMentionedInText(slot: OfferedSlot, text: string): boolean {
  const hay = text.toLowerCase();
  const time = normalizeTimeLabel(slot.time_label);
  const userTime = normalizeTimeLabel(hay);
  if (time && hay.includes(time)) return true;

  const dayPart = slot.date_label.split(/[,/]/)[0]?.trim().toLowerCase() ?? "";
  const weekdayStems = [
    "domingo",
    "segunda",
    "terca",
    "terça",
    "quarta",
    "quinta",
    "sexta",
    "sabado",
    "sábado",
  ];
  for (const stem of weekdayStems) {
    const normalizedStem = stem.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    const normalizedDay = dayPart.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    const normalizedHay = hay.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    if (normalizedDay.startsWith(normalizedStem) && normalizedHay.includes(normalizedStem)) {
      if (!userTime || time === userTime) return true;
    }
  }

  for (const part of slot.date_label.split(/[,/]/)) {
    const p = part.trim().toLowerCase();
    if (p.length >= 4 && hay.includes(p.slice(0, Math.min(p.length, 12)))) {
      if (!userTime || time === userTime) return true;
    }
  }

  const dateMatch = slot.date_label.match(/\b(\d{1,2}\/\d{1,2})\b/);
  if (dateMatch?.[1] && hay.includes(dateMatch[1])) {
    if (!userTime || time === userTime) return true;
  }

  return false;
}

function recentAssistantContext(
  history: { role: "user" | "assistant"; content: string }[],
  beforeIdx: number,
  maxMessages = 4,
): string {
  return history
    .slice(0, beforeIdx)
    .filter((m) => m.role === "assistant")
    .slice(-maxMessages)
    .map((m) => m.content)
    .join("\n");
}

function patchFromSlot(slot: OfferedSlot): Partial<LeadData> {
  return {
    selected_slot_iso: slot.iso,
    ...(slot.dentist_person_id != null ? { dentist_person_id: slot.dentist_person_id } : {}),
  };
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
  if (
    /\d{1,2}:\d{2}/.test(t) &&
    /(pode ser|sim|ok|confirmo|esse|essa|este|esta|funciona|prefiro|quero|otimo|ótimo|t[aá] otimo|t[aá] ótimo|legal|bom|maravilha|certo|fechado|perfeito)/i.test(
      t,
    )
  ) {
    return true;
  }
  if (
    /\d{1,2}:\d{2}/.test(t) &&
    /(segunda|ter[cç]a|quarta|quinta|sexta|s[aá]bado|domingo)/i.test(t)
  ) {
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

  const assistantText = recentAssistantContext(history, lastUserIdx);

  const prefPatch = pickSlotByPreference(slots, lastUser, assistantText);
  if (prefPatch) return prefPatch;

  if (!isSlotAcceptanceMessage(lastUser)) return {};

  const mentionedByUser = slots.filter((s) => slotMentionedInText(s, lastUser));
  if (mentionedByUser.length === 1) {
    return patchFromSlot(mentionedByUser[0]!);
  }

  const userTime = normalizeTimeLabel(lastUser);
  if (userTime) {
    const byTime = slots.filter((s) => normalizeTimeLabel(s.time_label) === userTime);
    if (byTime.length === 1) {
      return patchFromSlot(byTime[0]!);
    }
    if (byTime.length > 1) {
      const narrowed = byTime.filter((s) => slotMentionedInText(s, lastUser));
      if (narrowed.length === 1) {
        return patchFromSlot(narrowed[0]!);
      }
    }
  }

  if (/^(o\s+)?primeir[oa]|1ª|1a\b|opção\s*1/i.test(lastUser.toLowerCase()) && slots[0]) {
    return patchFromSlot(slots[0]);
  }
  if (/^(o\s+)?segund[oa]|2ª|2a\b|opção\s*2/i.test(lastUser.toLowerCase()) && slots[1]) {
    return patchFromSlot(slots[1]);
  }

  const mentionedInAssistant = slots.filter((s) => slotMentionedInText(s, assistantText));
  if (mentionedInAssistant.length === 1) {
    return patchFromSlot(mentionedInAssistant[0]!);
  }

  if (mentionedByUser.length > 1 && userTime) {
    const byDayAndTime = mentionedByUser.filter(
      (s) => normalizeTimeLabel(s.time_label) === userTime,
    );
    if (byDayAndTime.length === 1) {
      return patchFromSlot(byDayAndTime[0]!);
    }
  }

  if (slots.length === 1) {
    return patchFromSlot(slots[0]!);
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

function looksLikePhoneNumber(text: string): boolean {
  const digits = text.replace(/\D/g, "");
  return digits.length >= 10 && digits.length <= 13;
}

function stripAffirmativePrefix(text: string): string {
  return text.replace(/^(sim|ok|isso|uhum|certo)[,.\s]+/i, "").trim();
}

function captureBookingAnswer(
  rawAnswer: string,
  assistantText: string,
  leadData: LeadData,
  fields: BookingFieldDef[],
  channelCtx?: BookingChannelContext,
): Partial<LeadData> {
  if (
    channelCtx &&
    shouldSkipPhoneCollection(channelCtx.channel, channelCtx.effectivePhone) &&
    /\b(telefone|celular|whatsapp|n[uú]mero para contato)\b/i.test(assistantText.toLowerCase())
  ) {
    return {};
  }
  const lastUser = stripAffirmativePrefix(rawAnswer.trim());
  if (!lastUser || lastUser.length > MAX_AUTO_CAPTURE_LEN) return {};
  if (looksLikeQuestion(lastUser)) return {};
  if (isSlotAcceptanceMessage(lastUser)) return {};
  if (looksLikeSchedulingPreference(lastUser)) return {};
  if (looksLikePhoneNumber(lastUser)) return {};

  const missing = getMissingBookingFields(fields, leadData);
  if (missing.length === 0) return {};

  // Datas de nascimento sao auto-classificadas independente da pergunta —
  // o formato dd/mm/yyyy e inequivoco.
  if (looksLikeBirthDate(lastUser)) {
    const birthField = missing.find(isBirthDateField);
    if (birthField) {
      return { custom_fields: { [birthField.key]: lastUser } };
    }
    return {};
  }

  // Para os demais campos, EXIGIMOS que o assistente tenha perguntado
  // explicitamente sobre o campo. Sem isso, nao capturamos — evita usar
  // a M1 ("Ola gostaria de mais informacoes...") como nome da crianca.
  const fieldFromQuestion = matchFieldFromAssistantQuestion(assistantText, missing);
  if (!fieldFromQuestion) return {};
  const field = fieldFromQuestion;

  if (isShortAffirmative(lastUser) && field.maps_to !== "name" && field.key !== "name") {
    return {};
  }

  // Mensagens de saudacao/intencao nao sao resposta de campo de cadastro.
  if (looksLikeIntentMessage(lastUser)) return {};

  if (field.maps_to === "name" || field.key === "name") {
    if (!looksLikePersonName(lastUser)) return {};
    return { name: lastUser };
  }

  // Campos de nome (crianca / responsaveis) exigem que o conteudo
  // pareca nome de pessoa — nao texto livre.
  if (isChildNameField(field) || isGuardiansField(field)) {
    if (!looksLikePersonName(lastUser)) return {};
  }

  return {
    custom_fields: {
      [field.key]: lastUser,
    },
  };
}

/**
 * Reprocessa o histórico e preenche campos que o LLM não gravou em lead_data.
 * Evita repetir perguntas já respondidas no chat.
 *
 * Importante: so processa mensagens APOS o assistente ter feito a primeira
 * pergunta de campo de booking. Mensagens da fase RECEPTION/QUALIFICATION
 * (ex: "Ola gostaria de informacoes") nunca viram resposta de cadastro.
 */
export function backfillBookingFieldsFromHistory(
  leadData: LeadData,
  history: { role: "user" | "assistant"; content: string }[],
  settings: Record<string, string>,
  channelCtx?: BookingChannelContext,
): Partial<LeadData> {
  const fields = getBookingFieldsForChannel(settings, channelCtx);

  // Encontra o indice da primeira pergunta de campo de booking do assistente.
  // Tudo antes disso e descartado para evitar capturar M1/QUALIFICATION.
  let firstFieldQuestionIdx = -1;
  for (let i = 0; i < history.length; i++) {
    const m = history[i]!;
    if (m.role !== "assistant") continue;
    if (matchFieldFromAssistantQuestion(m.content, fields)) {
      firstFieldQuestionIdx = i;
      break;
    }
  }
  if (firstFieldQuestionIdx === -1) return {};

  let acc = leadData;
  let merged: Partial<LeadData> = {};

  for (let i = firstFieldQuestionIdx + 1; i < history.length; i++) {
    const msg = history[i]!;
    if (msg.role !== "user") continue;

    const assistantText = history
      .slice(0, i)
      .filter((m) => m.role === "assistant")
      .slice(-3)
      .map((m) => m.content)
      .join("\n");
    if (!assistantText.trim()) continue;

    const patch = captureBookingAnswer(msg.content, assistantText, acc, fields, channelCtx);
    if (Object.keys(patch).length === 0) continue;

    acc = mergeLeadDataPatch(acc, patch);
    merged = mergeLeadDataPatch(merged as LeadData, patch);
  }

  return merged;
}

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
  channelCtx?: BookingChannelContext,
): Partial<LeadData> {
  if (stage !== "NAME_COLLECT" && stage !== "BOOKING") return {};

  const fields = getBookingFieldsForChannel(settings, channelCtx);
  if (getMissingBookingFields(fields, leadData).length === 0) return {};

  let lastUserIdx = -1;
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i]!.role === "user") {
      lastUserIdx = i;
      break;
    }
  }
  if (lastUserIdx < 0) return {};

  const assistantText = history
    .slice(0, lastUserIdx)
    .filter((m) => m.role === "assistant")
    .slice(-3)
    .map((m) => m.content)
    .join("\n");
  if (!assistantText.trim()) return {};

  return captureBookingAnswer(history[lastUserIdx]!.content, assistantText, leadData, fields, channelCtx);
}
