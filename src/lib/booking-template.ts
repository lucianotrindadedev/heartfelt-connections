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
  /**
   * Campo de nome exige NOME + SOBRENOME (default para campos de nome).
   * Só desligue (`false` explícito) se a operação aceitar primeiro nome sozinho.
   */
  require_full_name?: boolean;
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
          // undefined = default (exige sobrenome em campo de nome); só `false`
          // explícito no JSON do proprietário libera primeiro nome sozinho.
          require_full_name: o.require_full_name === false ? false : undefined,
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
  // ISO (AAAA-MM-DD) — o LLM às vezes salva a data nesse formato (sem
  // instrução explícita de formato no prompt) mesmo o lead tendo respondido
  // em DD/MM/AAAA. Sem este ramo, a data ISO nunca batia com o regex
  // DD/MM/AAAA abaixo (ano na frente tem 4 dígitos, não 1-2) e caía como
  // "não é data" — apagada pelo preflight e o agendamento travava em loop.
  const iso = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  const numeric = !iso ? t.match(/\b(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})\b/) : null;
  if (iso) {
    year = Number(iso[1]);
    month = Number(iso[2]);
    day = Number(iso[3]);
  } else if (numeric) {
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

/** Agente usa classificação determinística de turma? (opt-in, isolado).
 *  Tolerante ao formato do valor: "true"/true/"1"/"sim"/"on" (qualquer caixa). */
export function agentUsesTurmaClassifier(settings: Record<string, string>): boolean {
  const v = String((settings as Record<string, unknown>).turma_auto ?? "")
    .trim()
    .toLowerCase();
  return v === "true" || v === "1" || v === "sim" || v === "on" || v === "yes";
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

/**
 * Nomes-candidatos para casar a turma calculada com a TAG do CRM.
 * O classificador produz nomes legíveis ("YEAR 1", "NURSERY", "BEAR CARE"), mas
 * o CRM costuma cadastrar a turma CODIFICADA (padrão franquia Maple Bear):
 *   YEAR 1 → "Y126" (ex.: "06 Y126") · NURSERY → "NS26" (ex.: "03 NS26")
 *   TODDLER → "TD26" · BEAR CARE → "BC26" · FBC → "FBC26" · JK/SK → "JK26"/"SK26"
 * (o sufixo "26" = ano letivo de referência). Geramos o código PRIMEIRO (mais
 * específico, casa sem ambiguidade via substring) e o nome legível como fallback.
 * refYear default 2026 → sufixo "26".
 */
export function turmaTagCandidates(turma: string, refYear = 2026): string[] {
  const yy = String(((refYear % 100) + 100) % 100).padStart(2, "0");
  const t = turma.trim().toUpperCase();
  const yearMatch = t.match(/^YEAR\s+(\d+)$/);
  if (yearMatch) {
    return [`Y${yearMatch[1]}${yy}`, turma];
  }
  const abbr: Record<string, string> = {
    NURSERY: "NS",
    TODDLER: "TD",
    "BEAR CARE": "BC",
    FBC: "FBC",
    SK: "SK",
    JK: "JK",
  };
  const a = abbr[t];
  return a ? [`${a}${yy}`, turma] : [turma];
}

/**
 * TODAS as turmas do lead (suporta IRMÃOS): varre o campo de data de nascimento
 * e quaisquer custom_fields com chave de nascimento (birth/nasc/dob), extrai
 * TODAS as datas dd/mm/aaaa e classifica cada uma. Retorna as turmas únicas.
 * Ex.: dois filhos (21/05/2018 e 01/09/2021) → ["YEAR 2", "NURSERY"].
 * turmaTagForLead (singular) segue existindo para a turma principal.
 */
export function turmaTagsForLead(settings: Record<string, string>, ld: LeadData): string[] {
  if (!agentUsesTurmaClassifier(settings)) return [];
  const refYear = Number(settings.turma_ano_letivo) || 2026;
  const cf = ld.custom_fields ?? {};
  const blobs: string[] = [];
  const dateField = getBookingFields(settings).find(isDateFieldKey);
  if (dateField && typeof cf[dateField.key] === "string") blobs.push(cf[dateField.key]!);
  for (const [k, v] of Object.entries(cf)) {
    if (typeof v === "string" && /birth|nasc|dob/i.test(k)) blobs.push(v);
  }
  const turmas = new Set<string>();
  for (const blob of blobs) {
    // ISO primeiro (não pode competir com o regex DD/MM/AAAA na mesma
    // string — ver parseBirthDateParts sobre por que isso é necessário).
    const dates = blob.match(/\d{4}-\d{1,2}-\d{1,2}|\d{1,2}[\/\-.]\d{1,2}[\/\-.]\d{2,4}/g) ?? [];
    for (const d of dates) {
      const t = classifyMapleBearTurma(d, refYear);
      if (t) turmas.add(t);
    }
  }
  return [...turmas];
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

// ── Nome COMPLETO (nome + sobrenome) ────────────────────────────────────────
//
// Partículas de nome composto ("Ana DE Souza", "João DOS Santos"): sozinhas não
// são sobrenome. Sem esta lista, "Ana de" passaria como nome completo.
const NAME_PARTICLES = new Set([
  "de", "da", "do", "das", "dos", "e", "di", "del", "della", "du", "van", "von",
  "la", "le", "los", "san", "santa", "y", "bin", "el",
]);

function stripAccentsLower(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");
}

/**
 * O texto tem NOME + SOBRENOME? Barreira DETERMINÍSTICA — o prompt sozinho não
 * garante: o proprietário escrevia "peça o nome completo" e o modelo agendava com
 * "Ana", criando cadastro de paciente incompleto na clínica (impossível de achar
 * depois e duplicando pacientes).
 *
 * Conta só tokens que são de fato palavras de nome: descarta partículas ("de",
 * "dos"), iniciais abreviadas ("Luciano T.") e qualquer coisa não-alfabética.
 * Exige 2+ → "Ana" false, "Ana Souza" true, "Ana de Souza" true, "Ana S." false.
 */
export function hasSurname(value: string | null | undefined): boolean {
  return nameWordCount(value) >= 2;
}

function nameWordCount(value: string | null | undefined): number {
  const t = (value ?? "").trim();
  if (!t) return 0;
  return t
    .split(/\s+/)
    .map((w) => w.replace(/[.,;:!?]+$/g, "").trim())
    .filter((w) => w.length >= 2 && /^[\p{L}][\p{L}'’-]*$/u.test(w))
    .filter((w) => !NAME_PARTICLES.has(stripAccentsLower(w))).length;
}

/**
 * Campo de nome que exige sobrenome. Data de nascimento e CPF ficam de fora
 * mesmo quando a chave contém "child"/"nome" (ex.: "child_birth_date"), senão
 * uma data nunca teria "sobrenome" e o campo ficaria eternamente pendente.
 */
function requiresFullName(field: BookingFieldDef): boolean {
  if (field.require_full_name === false) return false;
  if (isDateFieldKey(field) || isCpfField(field)) return false;
  return isNameFieldKey(field);
}

export function getMissingBookingFields(
  fields: BookingFieldDef[],
  ld: LeadData,
): BookingFieldDef[] {
  return fields.filter((f) => {
    if (!f.required) return false;
    const v = getFieldValue(f.key, f.maps_to, ld);
    if (!v) return true;
    // CPF preenchido com valor que não é um CPF válido (ex.: "9h") conta como
    // MISSING — o agente re-pergunta em vez de agendar com CPF inválido.
    if (isCpfField(f) && !isValidCpf(v)) return true;
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
    // Nome sem SOBRENOME conta como MISSING — o agente pergunta o resto do nome
    // antes de agendar, em vez de criar o cadastro do paciente só com "Ana".
    // Com o agendamento JÁ criado não reabrimos o assunto: cobrar sobrenome de
    // quem já está confirmado só atrapalha (o cadastro já foi feito).
    if (!ld.appointment_id && requiresFullName(f) && !hasSurname(v)) return true;
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

/**
 * Pergunta a fazer ao lead pelo campo pendente. Quando o campo de nome já tem o
 * PRIMEIRO nome e só falta o sobrenome, pede o SOBRENOME citando o que já temos
 * ("Ana, me confirma seu sobrenome?") em vez de repetir "me envia seu nome
 * completo" — repetir a pergunta inteira depois de o lead já ter respondido soa
 * como se ninguém tivesse lido a resposta dele.
 */
export function bookingFieldQuestion(field: BookingFieldDef, ld: LeadData): string {
  const current = getFieldValue(field.key, field.maps_to, ld);
  if (!current || !requiresFullName(field) || hasSurname(current)) return field.question;
  if (looksLikeIntentMessage(current)) return field.question;
  const first = current.trim().split(/\s+/)[0] ?? "";
  if (!first) return field.question;
  const isSelfName = field.maps_to === "name" || field.key === "name";
  return isSelfName
    ? `${first}, me confirma seu sobrenome? Preciso do nome completo pro cadastro.`
    : `Qual é o sobrenome de ${first}? Preciso do nome completo pro cadastro.`;
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
    | "not_a_date"
    | "invalid_cpf";
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

    // CPF tem prioridade: valor precisa ser um CPF válido (formato + dígito
    // verificador). Barreira final antes de criar o agendamento.
    if (isCpfField(f)) {
      if (!isValidCpf(v)) issues.push({ key: f.key, value: v, reason: "invalid_cpf" });
      continue;
    }

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
      if (!v) return null;
      // Nome só com o primeiro nome NÃO está pronto — marcamos explicitamente,
      // senão o modelo lê "já coletado" e agenda com o cadastro incompleto.
      const incomplete = !ld.appointment_id && requiresFullName(f) && !hasSurname(v);
      return `- ${f.label} (${f.key}): ${v}${incomplete ? " ⚠️ INCOMPLETO — falta o SOBRENOME" : ""}`;
    })
    .filter(Boolean)
    .join("\n");

  const missing = getMissingBookingFields(fields, ld);
  const missingLines = missing.map((f) => `- ${f.key}: "${bookingFieldQuestion(f, ld)}"`).join("\n");
  const fullNameFields = fields.filter(requiresFullName);

  return `# CAMPOS OBRIGATÓRIOS ANTES DO AGENDAMENTO

${collected ? `Já coletados:\n${collected}\n` : ""}
${missing.length > 0 ? `Ainda faltam (pergunte UM por vez, use lead_data_patch.custom_fields ou name):\n${missingLines}` : "Todos os campos obrigatórios já foram coletados — pode avançar para BOOKING após confirmação de compromisso (se configurada)."}
${
  fullNameFields.length > 0
    ? `
⚠️ NOME COMPLETO (obrigatório): ${fullNameFields.map((f) => f.key).join(", ")} só contam como preenchidos com NOME + SOBRENOME. Se o lead mandar só o primeiro nome ("Ana"), NÃO agende e NÃO avance: agradeça e peça o sobrenome ("Ana, me confirma seu sobrenome?"). O cadastro do paciente e a agenda ficam com esse nome — primeiro nome sozinho não identifica ninguém. Guarde o nome inteiro (primeiro + sobrenome) no mesmo campo.
`
    : ""
}
Regra: salve respostas em lead_data_patch:
- name → lead_data_patch.name
- demais campos → lead_data_patch.custom_fields.{key}

Regra CRÍTICA: se um campo já aparece em "Já coletados" abaixo (e sem ⚠️), NUNCA pergunte de novo.
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
  if (/^\d{4}-\d{1,2}-\d{1,2}$/.test(t)) return true; // ISO — ver parseBirthDateParts
  if (/^\d{1,2}[\/\-.]\d{1,2}[\/\-.]\d{2,4}$/.test(t)) return true;
  if (/^\d{1,2}\s+de\s+[a-zà-ú]+(\s+de\s+\d{2,4})?$/i.test(t)) return true;
  return false;
}

// ── Validação de CPF ────────────────────────────────────────────────────────
//
// CPF sempre tem 11 dígitos. O lead pode informar formatado (000.000.000-00,
// com separadores . e -) OU só os 11 dígitos (00000000000). Validamos apenas
// a contagem de dígitos e sequências repetidas — NÃO o dígito verificador
// oficial do CPF: leads de teste digitam CPFs "genéricos" (ex: 123.456.789-00)
// que falham o checksum mas são intencionais, e o preflight (linha ~516)
// bloqueava o agendamento nesse caso com uma mensagem confusa de "horário
// indisponível" em vez de pedir o CPF de novo. Mantemos os 11 dígitos como
// filtro porque isso ainda barra respostas óbvias que não são CPF, como "9h"
// (era resposta de horário e virou CPF no cadastro em um caso real).

/** Só os dígitos de um texto (remove ".", "-", espaços, etc.). */
export function normalizeCpfDigits(raw: string | null | undefined): string {
  return (raw ?? "").replace(/\D/g, "");
}

/** CPF "válido" para fins de captura: 11 dígitos e não todos iguais.
 *  Não verifica o dígito verificador oficial (ver comentário acima). */
export function isValidCpf(raw: string | null | undefined): boolean {
  const d = normalizeCpfDigits(raw);
  if (d.length !== 11) return false;
  if (/^(\d)\1{10}$/.test(d)) return false; // 000..., 111..., ..., 999...
  return true;
}

/** Formata um CPF (11 dígitos) no padrão 000.000.000-00. Se não tiver 11
 *  dígitos, devolve o texto original aparado (nunca força um formato inválido). */
export function formatCpf(raw: string): string {
  const d = normalizeCpfDigits(raw);
  if (d.length !== 11) return raw.trim();
  return `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6, 9)}-${d.slice(9)}`;
}

/** Chave de custom_field que representa um CPF (cpf, cpf_responsavel, ...). */
function isCpfKey(key: string): boolean {
  return /cpf/i.test(key);
}

/** Campo de booking que coleta CPF (detectado por chave, label ou pergunta). */
export function isCpfField(field: BookingFieldDef): boolean {
  return (
    isCpfKey(field.key) ||
    /\bcpf\b/i.test(field.label ?? "") ||
    /\bcpf\b/i.test(field.question ?? "")
  );
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
    /\b(ol[aá]|oi|bom dia|boa tarde|boa noite|tudo bem|tudo bom|tudo certo|gostaria|gostari[ae]|quero|queria|preciso|posso|pode|poderia|tenho|estou|interesse|interessad[oa]|informa[cç][oõ]es?|saber|sobre|d[uú]vida|escola|consulta|atendiment|servi[cç]o|aula|curso|mensalidad|valor|pre[cç]o|hor[aá]rio|disponibilidade|matr[ií]cul|crian[cç]a|esposa|marido|m[ãa]e|melhor falar|gente|al[ôo])\b/i;
  if (intentWords.test(tl)) return true;

  // "filho"/"filha"/"pai" SÓ contam como intenção quando vêm com determinante
  // ("meu filho", "a filha", "do pai"). Soltos são SOBRENOME — e "Filho" é um
  // dos sobrenomes mais comuns do Brasil.
  //
  // Caso real (Odonto Carioca Campo Grande, 13/08): "Relandy Izabel Filho" e
  // "Jose herminio filho" eram descartados na captura, e o lead ficava preso
  // repetindo o nome. "Neto" e "Junior" passavam; só quem se chama "Filho"
  // era barrado.
  if (
    /\b(?:meu|minha|seu|sua|nosso|nossa|d[oa]|n[oa]|pel[oa]|pr[oa]|para\s+[oa]|com\s+[oa]|o|a)\s+(?:filh[oa]s?|pai)\b/i.test(
      tl,
    )
  ) {
    return true;
  }

  // Mensagens longas costumam ser intent — MAS um nome completo brasileiro passa
  // de 6 palavras com facilidade quando tem duas partículas.
  //
  // Caso real (Odonto Carioca Campo Grande, 21 96543-1529, 07–13/08): "Karla
  // deborah da Silva nunes de lima" tem SETE palavras. O limite antigo (6) a
  // classificava como intenção, a captura descartava o nome, o preflight pedia
  // o nome de novo e a lead reenviou quatro vezes ao longo de SEIS DIAS até
  // desistir ("Desisto", "Ja confirmei tudo e vc nao resolve nada tchau").
  // O limite agora é 10; acima disso já não é nome plausível.
  //
  // A assimetria aqui é o oposto da do agendamento: recusar um nome válido
  // trava a conversa em loop infinito, enquanto aceitar um nome estranho custa
  // uma correção na recepção. Na dúvida, ACEITA.
  const tokens = t.split(/\s+/).filter(Boolean);
  const wordCount = tokens.length;
  const looksLikeNameSequence =
    wordCount <= 10 && tokens.every((w) => /^[\p{L}][\p{L}'.-]*$/u.test(w));
  if (wordCount >= 5 && !looksLikeNameSequence) return true;

  return false;
}

/**
 * Recusa educada / negativa ("não, obrigado", "agora não", "não quero", "desisti",
 * "nenhum dos dois"). NÃO deve virar nome nem resposta de campo de cadastro, e
 * NUNCA deve auto-selecionar/auto-agendar um horário ofertado — casos reais:
 * (1) o lead disse "Não, obrigado." e o sistema capturou como name e AGENDOU
 * sozinho; (2) Clínica Bomfim 09/07: o lead recusou os dois horários ofertados
 * ("Nenhum dos 2") e o sistema agendou um deles mesmo assim.
 */
export function looksLikeDecline(text: string): boolean {
  const t = text
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[.!,;]+$/g, "")
    .trim();
  if (!t) return false;
  if (
    /^(nao|nao obrigad[oa]|nao,? obrigad[oa]|obrigad[oa]|agora nao|melhor nao|nao quero|nao vou querer|sem interesse|nao tenho interesse|nao tenho mais interesse|deixa pra la|deixa quieto|deixa pra depois|vou pensar|talvez depois|depois eu vejo|desisti|nao preciso|por enquanto nao|nao precisa)$/.test(
      t,
    )
  ) {
    return true;
  }
  if (/^nao[, ]+(obrigad|quero|vou|preciso|precisa|tenho interesse)/.test(t)) return true;
  // "Nenhum"/"nenhuma" (dos dois, das opções, desses horários...) recusa TODAS
  // as opções ofertadas — não é escolha de nenhum slot.
  if (/^nenhum[ao]?(\s+(dos?|das?)\s+\S+(\s+\S+)?)?$/.test(t)) return true;
  if (/^nem\s+um\s+nem\s+outro$/.test(t)) return true;
  return false;
}

/**
 * Lead que JÁ tem visita/consulta confirmada sinalizando que NÃO vai conseguir
 * vir, quer cancelar, quer remarcar, ou está repensando seriamente. Usado no
 * estágio CONFIRMED: sem isto, o agente só reafirma "sua visita está
 * confirmada" e ignora a objeção. Caso real (Maple Bear Osasco, Natalie
 * 11 99881-5258): "a logística não vai ficar legal pq eu trabalho na Lapa" e
 * "só vamos colocar ela ano que vem, vou pensar mais um pouquinho" → o agente
 * respondeu só "Sua visita já está confirmada para 21/07 às 11:00".
 */
export function signalsCannotAttendOrChange(text: string): boolean {
  const t = (text ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");
  if (!t.trim()) return false;

  // Impossibilidade de comparecer
  if (/\bnao\s+(vou\s+conseguir|vou\s+poder|vou|consigo|poderei|posso|da\s+pra|da\s+para)\b/.test(t)) return true;
  if (/\bnao\s+(vai|da|dara|vou)\s+(dar|ficar|rolar|dar\s+certo)\b/.test(t)) return true;
  if (/\bnao\s+vai\s+(ficar|dar|rolar)\b/.test(t)) return true;
  if (/\b(logistica|imprevisto|complicou|apertad[oa]|em\s+cima)\b/.test(t)) return true;

  // Cancelar
  if (/\bcancel(ar|a|amento|ei|o)?\b/.test(t)) return true;

  // Remarcar / mudar / outro dia-horário
  if (/\b(remarcar|reagendar|adiar|transferir|mudar|trocar|outro\s+(dia|hor[a]rio)|outra\s+data)\b/.test(t)) return true;

  // Repensar / consultar cônjuge
  if (/\bvou\s+(pensar|repensar)\b/.test(t)) return true;
  if (/\b(preciso|deixa\s+eu|melhor\s+eu)\s+(pensar|repensar|ver\s+direitinho|ver\s+com)\b/.test(t)) return true;
  if (/\bnao\s+sei\s+se\s+(vou|consigo|da|conseguirei)\b/.test(t)) return true;
  if (/\bano\s+que\s+vem\b/.test(t) && /\b(pensar|ver|so\s+vamos|so\s+vou)\b/.test(t)) return true;

  return false;
}

/**
 * Agradecimento / bênção / encerramento ("obrigado", "muito obrigado msm",
 * "valeu", "Deus abençoe", "amém"). NÃO é nome de pessoa — caso real: o lead
 * mandou "Obrigado msm Deus abençoe" e o sistema gravou isso como o nome do
 * paciente (bloqueando o nome real que veio na mensagem seguinte).
 * Diferente da recusa: agradecimento NÃO impede o agendamento — só não pode
 * virar nome, para o nome verdadeiro ser capturado.
 */
export function looksLikeGratitudeOrClosing(text: string): boolean {
  const t = text
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim();
  if (!t) return false;
  // Começa com agradecimento.
  if (/^(muito\s+)?(obrigad[oa]|obg|obgd|obgda|vlw|valeu|agradec|grat[oa]|amem)\b/.test(t)) {
    return true;
  }
  // Contém bênção.
  if (/\bdeus\s+(te\s+|lhe\s+|vos\s+)?(abencoe|abencoa|abencoou|proteja|ilumine|guarde)\b/.test(t)) {
    return true;
  }
  if (/\bque\s+deus\b/.test(t)) return true;
  return false;
}

function looksLikePersonName(text: string): boolean {
  const t = text.trim();
  if (!t || looksLikeBirthDate(t) || looksLikeSchedulingPreference(t)) return false;
  if (/^\d+$/.test(t)) return false;
  // Rejeita mensagens de saudacao/intencao — elas nao sao nome de pessoa.
  if (looksLikeIntentMessage(t)) return false;
  // ...e frases com verbo conjugado ("Ja te mandei", "Jesus já mandei"). Os dois
  // classificadores cobrem buracos DIFERENTES um do outro: o de intenção pega
  // "Gostaria de informações" (que não tem verbo da lista) e o de frase pega
  // "Ja te mandei" (que não tem palavra de intenção). Exigir os dois é o que
  // impede uma frase de virar o nome do paciente — e um nome virado frase é o
  // erro mais caro deste fluxo, porque trava a conversa em loop até o lead
  // desistir. Caso real (21 96543-1529): name ficou preso em "Ja te mandei".
  if (looksLikeSentenceNotName(t)) return false;
  // Rejeita recusas ("não, obrigado", "não quero") — nao sao nome de pessoa.
  if (looksLikeDecline(t)) return false;
  // Rejeita agradecimento/bênção ("obrigado", "Deus abençoe") — nao sao nome.
  if (looksLikeGratitudeOrClosing(t)) return false;
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
  // "Ana, me confirma seu sobrenome?" / "Qual é o sobrenome de Pedro?" — pedido
  // de sobrenome pertence ao campo de nome pendente. Sem isto a resposta
  // ("Souza") não era capturada e o agente repetia a pergunta em loop.
  if (/sobrenome/i.test(t)) {
    const nameField = fields.find(requiresFullName);
    if (nameField) return nameField;
  }
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

/**
 * Limpa do lead_data o campo de nome que o validador (LLM) REJEITOU, para o nome
 * real ser recapturado. Sem isto, um nome inválido persistido trava o
 * NAME_COLLECT em loop: getMissingBookingFields (regex) acha o campo preenchido e
 * nunca recoleta, enquanto validatePatientNameLLM rejeita a cada agendamento.
 * Caso real (21 97486-6018): name ficou preso em "Tudo bem" — que o regex
 * looksLikeIntentMessage não pega, mas o LLM rejeita — e a lead repetiu o nome
 * dezenas de vezes sem efeito. Segue a mesma prioridade de resolveBookingLeadName.
 *
 * IMPORTANTE: limpa com STRING VAZIA, nunca `undefined`. O patch de retorno passa
 * por stripNullishFields no orquestrador (que remove chaves undefined/null antes
 * do merge) — então `{ name: undefined }` era SILENCIOSAMENTE descartado e o nome
 * rejeitado NUNCA era limpo, mantendo o loop de "confirme o nome completo" pra
 * sempre. Caso real (21 97859-4196): name preso em "9 horas" (a lead respondeu o
 * horário quando perguntaram o nome); ela mandou "Marinalva Francisco Fortunato"
 * ~15 vezes sem efeito. "" sobrevive ao strip e conta como campo vazio
 * (getMissingBookingFields/resolveBookingLeadName tratam "" como ausente).
 */
/**
 * Nomes que o lado da CLÍNICA apresentou como sendo DELE ("me chamo Val", "sou
 * a Ana") nas mensagens do assistente. Nunca são o nome do lead.
 *
 * Por que isso vaza: a atendente humana digita pelo WhatsApp da clínica e suas
 * mensagens são gravadas com `role: "assistant"` (origem="humano") — no
 * histórico do LLM ficam INDISTINGUÍVEIS das falas do próprio agente. Caso real
 * (Odonto Carioca Campo Grande, 21 96932-0210, 23/07): a atendente enviou "Olá,
 * bom dia tudo bem? Me chamo Val. Qual é o seu nome?"; o agente gravou
 * lead_data.name = "Val" e passou a conversa inteira chamando a LEAD de Val.
 */
export function attendantSelfIntroducedNames(assistantTexts: string[]): Set<string> {
  const out = new Set<string>();
  // `i` é obrigatório: a frase real começa com "Me chamo…" (maiúscula). A
  // inicial maiúscula do NOME é validada depois, para não capturar palavra comum.
  const patterns = [
    /\bme\s+chamo\s+([\p{L}]{2,21})/giu,
    /\bmeu\s+nome\s+[ée]\s+([\p{L}]{2,21})/giu,
    /\b(?:sou|aqui\s+[ée]|quem\s+fala\s+[ée])\s+(?:a|o)\s+([\p{L}]{2,21})/giu,
  ];
  for (const raw of assistantTexts) {
    const t = raw ?? "";
    for (const re of patterns) {
      for (const m of t.matchAll(re)) {
        const nome = (m[1] ?? "").trim();
        if (!nome) continue;
        // Nome próprio começa com maiúscula — filtra "sou a responsável", etc.
        if (nome[0] !== nome[0]!.toUpperCase()) continue;
        out.add(nome.toLowerCase());
      }
    }
  }
  return out;
}

/**
 * O `name` capturado é, na verdade, o nome de quem ATENDE (agente/atendente) —
 * não do lead. Compara pelo PRIMEIRO nome: o lead informa "Val" ou "Val Souza",
 * e ambos devem ser rejeitados quando a clínica se apresentou como Val.
 */
export function nameIsAttendantSelfIntroduction(
  name: string | null | undefined,
  assistantTexts: string[],
): boolean {
  const n = (name ?? "").trim();
  if (!n) return false;
  const primeiro = n.split(/\s+/)[0]!.toLowerCase();
  return attendantSelfIntroducedNames(assistantTexts).has(primeiro);
}

// Fronteira de palavra ciente de ACENTO. O \b do JS é ASCII: em "Manhães" ele
// enxerga um limite logo depois do "ã" (não-\w) e `\bmanhã\b` casaria dentro do
// SOBRENOME. Descobrimos isso varrendo os 2.684 nomes reais de produção —
// "Silvia Manhães" era reprovado como se fosse frase. Com lookaround de letra
// Unicode o casamento exige palavra inteira de verdade.
const B = (fonte: string) => new RegExp(`(?<!\\p{L})(?:${fonte})(?!\\p{L})`, "iu");

// Palavras de TEMPO/AGENDA. Nenhum nome de pessoa as contém — mas frases de
// correção do lead vivem delas ("pedi pra amanhã", "só na próxima semana").
const TEMPO_NA_FRASE_RE = B(
  "amanh[ãa]|hoje|ontem|semana|m[eê]s|manh[ãa]|tarde|noite|hor[áa]rios?|horas?|agendar?|agendad[oa]|marcar|marcad[oa]|consulta|avalia[çc][ãa]o|segunda|ter[çc]a|quarta|quinta|sexta|s[áa]bado|domingo|cedo",
);

// Verbos conjugados em 1ª/2ª pessoa típicos de correção/pergunta do lead. Um
// nome próprio nunca traz forma verbal conjugada.
const VERBO_CONJUGADO_RE = B(
  "pedi|pedir|quero|queria|consigo|consegue|posso|preciso|prefiro|falando|falou|disse|mandei|marquei|agendei|tava|estava|vou|vai|trabalho|" +
    // 3ª pessoa do plural — o lead fala DA CLÍNICA ("fazem atendimento aos
    // sábados?", "vocês atendem convênio"). Nenhuma dessas é nome, e sem elas a
    // frase escapava dos DOIS classificadores e virava nome do paciente. Caso
    // real encontrado na varredura: name="Fazem atendimento aos sábados".
    "fazem|atendem|aceitam|trabalham|funcionam|abrem|cobram|t[êe]m|possuem",
);

/**
 * O texto é uma FRASE (correção, pergunta, comentário) e não um nome de pessoa.
 *
 * Caso real (Odonto Carioca Campo Grande, 21 97558-2703, 03/08): o lead corrigiu
 * "Pedi pra amanhã" / "não quinta feira"; a captura automática gravou
 * lead_data.name = "Pedi pra amanhã". O validador de nome (corretamente)
 * rejeitava na hora de agendar, o agente repetia "me envia seu nome completo" e
 * a conversa entrou em loop — inclusive DEPOIS de o lead mandar o nome de
 * verdade ("Antonio Fagundes").
 *
 * Assimetria deliberada: rejeitar um nome verdadeiro só custa uma repergunta;
 * aceitar uma frase como nome grava lixo no cadastro do paciente e trava o
 * agendamento. Na dúvida, rejeita.
 */
export function looksLikeSentenceNotName(text: string): boolean {
  const t = (text ?? "").trim();
  if (!t) return false;
  if (TEMPO_NA_FRASE_RE.test(t)) return true;
  if (VERBO_CONJUGADO_RE.test(t)) return true;
  // Negação/adversativa iniciando a frase: "não quinta", "mas eu queria...".
  if (/^(n[ãa]o|nem|mas|porque|por que|s[óo]|hj|j[áa])(?!\p{L})/iu.test(t)) return true;
  // Afirmação curta ("tá bem", "ok", "beleza") — ANCORADA na mensagem inteira,
  // para não reprovar um nome que por acaso contenha a palavra.
  if (
    /^(t[áa]\s*(bem|bom|certo|ok)?|ok|okay|beleza|blz|combinado|fechado|uhum|aham|isso mesmo|pode ser)[.!]*$/i.test(
      t,
    )
  ) {
    return true;
  }
  return false;
}

export function clearRejectedBookingName(leadData: LeadData): Partial<LeadData> {
  if (leadData.name?.trim()) return { name: "" };
  const cf = leadData.custom_fields ?? {};
  if (cf.guardians?.trim()) return { custom_fields: { ...cf, guardians: "" } };
  if (cf.child_name?.trim()) return { custom_fields: { ...cf, child_name: "" } };
  return {};
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

// Separador entre hora e minutos, como o lead escreve no WhatsApp: ":", "h",
// "." e "," — com espaço opcional dos dois lados ("14:30", "14: 30", "14.30",
// "14h30", "14 h 30"). Antes os minutos precisavam vir COLADOS a ":" ou "h", e
// só esses dois separadores valiam: "14: 30" e "14.30" não eram reconhecidos
// como horário em lugar nenhum. Caso real (Costa Lima Recreio, 21 98985-6865):
// a lead aceitou o horário ofertado escrevendo "14: 30 fica bom pra mim" e
// depois "14.30" — selected_slot_iso NUNCA era gravado, o agendamento não saía
// e o agente repetia "tive um problema ao registrar sua visita", em loop.
//
// As guardas de dígito nas bordas — (?<![\d.,]) antes e (?!\d) depois — impedem
// que valor monetário vire horário: em "R$ 1.500" o "1.500" não casa (o "500"
// tem um 3º dígito) e em "1.500,00" o "500,00" tampouco (o "5" vem depois de
// ponto). Sem elas, o "." como separador leria preço como hora.
// Minutos restritos a [0-5]\d: com o "." como separador, `\d{2}` faria "14.75"
// (um decimal/valor) virar "horário".
const HH_MM_SRC = String.raw`(?<![\d.,])(\d{1,2})\s*[:h.,]\s*([0-5]\d)(?!\d)`;
const TIME_WITH_MINUTES_RE = new RegExp(HH_MM_SRC, "i");
// Hora CHEIA, sem minutos: "9h", "9 h", "9hs", "9hrs", "9 horas". O lookahead
// negativo impede de casar "9h30" aqui (esse é o caso acima).
// A vírgula opcional antes do marcador cobre "10, horas" / "10 , h" — jeito
// comum de digitar (e o que a transcrição de áudio produz). Sem ela o horário
// não era reconhecido de forma alguma. Caso real (Sorriso Saúde,
// 27 99922-9610): a lead escreveu "Às 10, horas" três vezes e nunca teve o
// slot selecionado — a conversa entrou em loop até a supervisora agendar à mão.
const BARE_HOUR_RE = /(?:^|[^\d])(\d{1,2})\s*,?\s*h(?:s|rs?|oras?)?(?![\d:])/i;
// Hora cheia anunciada por preposição, sem o marcador "h": "às 9", "as 9".
// Um número solto ("9") NÃO entra: seria ambíguo com dia do mês, idade, etc.
const AS_BARE_HOUR_RE = /(?:^|\s)[àa]s\s+(\d{1,2})(?![\d:h])/i;

/**
 * Normaliza para "HH:MM" qualquer horário escrito pelo lead. Aceita as formas
 * usuais no WhatsApp — "09:00", "9h30", "9h", "9 horas", "às 9".
 *
 * A hora cheia sem minutos era o buraco: o regex antigo exigia `\d{1,2}:\d{2}`,
 * então "9h" virava string vazia e o lead NUNCA tinha o slot selecionado.
 * Caso real (Costa Lima Recreio, 21 97558-2703, 14/07): o lead respondeu "9h"
 * aos horários ofertados (09:00 / 09:45), o `selected_slot_iso` nunca foi
 * gravado e o agente voltou a perguntar "qual horário fica melhor pra você?"
 * mesmo depois de ele já ter confirmado o horário e enviado o nome completo.
 */
function normalizeTimeLabel(raw: string): string {
  const t = (raw ?? "").toLowerCase();
  const withMinutes = t.match(TIME_WITH_MINUTES_RE);
  if (withMinutes) {
    const h = Number(withMinutes[1]);
    const m = Number(withMinutes[2]);
    // Hora/minuto fora da faixa não é horário ("25:99", "14.75"). Sem esta
    // checagem qualquer par de números separados por ponto virava "hora".
    if (h >= 0 && h <= 23 && m >= 0 && m <= 59) {
      return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
    }
    return "";
  }

  const bare = t.match(BARE_HOUR_RE) ?? t.match(AS_BARE_HOUR_RE);
  if (bare) {
    const h = Number(bare[1]);
    if (Number.isInteger(h) && h >= 0 && h <= 23) return `${String(h).padStart(2, "0")}:00`;
  }
  return "";
}

/**
 * TODOS os horários citados num texto, normalizados ("09:00"). normalizeTimeLabel
 * devolve só o primeiro — aqui precisamos do conjunto, para saber quais slots o
 * agente acabou de oferecer de fato ("às 14h ou às 15h30" → {14:00, 15:30}).
 *
 * Usa o MESMO conjunto de separadores de HH_MM_SRC (":", "h", ".", ",", com
 * espaço opcional) — manter um regex de horário próprio aqui é o que faz essa
 * classe de bug voltar em outro ponto do parser.
 *
 * Datas e números de endereço não viram horário: "16/07" não tem separador de
 * minutos válido, e "13.685" (Av. das Américas, 13.685) é barrado pelas guardas
 * de dígito nas bordas — os minutos precisam ser [0-5]\d e não podem ter um 3º
 * dígito colado.
 */
function orderedTimesInText(text: string): string[] {
  const out: string[] = [];
  const re = new RegExp(
    String.raw`(?<![\d.,])(\d{1,2})(?:\s*[:h.,]\s*([0-5]\d)(?!\d)|\s*h(?:s|rs?|oras?)?\b)`,
    "gi",
  );
  for (const m of text.toLowerCase().matchAll(re)) {
    const h = Number(m[1]);
    if (!Number.isInteger(h) || h < 0 || h > 23) continue;
    const t = `${String(h).padStart(2, "0")}:${m[2] ?? "00"}`;
    if (!out.includes(t)) out.push(t);
  }
  return out;
}

function timesInText(text: string): Set<string> {
  return new Set(orderedTimesInText(text));
}

/**
 * Os slots que o agente REALMENTE ofereceu na última fala dele, na ORDEM em que
 * os disse. É a lista de candidatos correta para resolver a escolha do lead —
 * `offered_slots` traz até 6 vagas vindas da agenda, mas o agente só menciona 2
 * por mensagem ("ofereça no máx 2 horários").
 *
 * Sem isso, "o primeiro" pegava offered_slots[0] — um horário que o agente pode
 * NUNCA ter falado. Caso real (Costa Lima Recreio): offered_slots começava em
 * 13:00, o agente ofereceu "14:30 ou 15:15", e "o primeiro" agendaria 13:00.
 */
export function slotsOfferedInLastTurn(
  leadData: LeadData,
  history: { role: "user" | "assistant"; content: string }[],
): OfferedSlot[] {
  const slots = leadData.offered_slots ?? [];
  if (slots.length === 0) return [];

  const lastUserIdx = lastUserIndex(history);
  if (lastUserIdx < 0) return [];

  const turnText = lastAssistantTurnText(history, lastUserIdx);
  if (!turnText.trim()) return [];

  const ordered: OfferedSlot[] = [];
  const seen = new Set<string>();
  for (const time of orderedTimesInText(turnText)) {
    const sameTime = slots.filter((s) => normalizeTimeLabel(s.time_label) === time);
    // Mesmo horário em dias diferentes: fica com os que o agente citou pelo dia.
    const byDay = sameTime.filter((s) => slotMentionedInText(s, turnText));
    for (const s of byDay.length > 0 ? byDay : sameTime) {
      if (!seen.has(s.iso)) {
        seen.add(s.iso);
        ordered.push(s);
      }
    }
  }
  return ordered;
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

const WEEKDAY_STEMS = ["domingo", "segunda", "terca", "quarta", "quinta", "sexta", "sabado"];

/** Segunda-feira da PRÓXIMA semana — sempre a semana seguinte à atual, em BRT.
 *  "próxima semana"/"semana que vem" nunca cai na semana corrente, mesmo se
 *  hoje já for segunda (8 - isoDow ∈ [1..7] → nunca zero). */
function nextWeekMondayBrt(nowMs: number): string {
  const DAY = 86_400_000;
  const abbr = new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    timeZone: "America/Sao_Paulo",
  }).format(new Date(nowMs));
  const isoDow =
    ({ Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 } as Record<string, number>)[
      abbr
    ] ?? 1;
  return dateInBrt(new Date(nowMs + (8 - isoDow) * DAY));
}

/** Primeiro dia do mês SEGUINTE ao atual, em BRT (ex.: 15/07 → 2026-08-01).
 *  Calculado por partes de calendário (não por soma de ms) p/ não estourar o
 *  mês em fusos/horário de verão. A busca de horários a partir daí acha as
 *  primeiras vagas do mês (auto-ampliando a janela se os 1ºs dias estiverem
 *  cheios). */
function firstDayOfNextMonthBrt(nowMs: number): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
  }).formatToParts(new Date(nowMs));
  const y = Number(parts.find((p) => p.type === "year")!.value);
  const m = Number(parts.find((p) => p.type === "month")!.value); // 1..12
  const ny = m === 12 ? y + 1 : y;
  const nm = m === 12 ? 1 : m + 1;
  return `${ny}-${String(nm).padStart(2, "0")}-01`;
}

/** Números por extenso comuns em pedidos de prazo ("daqui a três dias"). */
const NUM_WORDS_PT: Record<string, number> = {
  um: 1,
  uma: 1,
  dois: 2,
  duas: 2,
  tres: 3,
  quatro: 4,
  cinco: 5,
  seis: 6,
  sete: 7,
  oito: 8,
  nove: 9,
  dez: 10,
  quinze: 15,
  vinte: 20,
  trinta: 30,
};

/**
 * Prazo relativo em contagem: "daqui a X dias/semanas", "em X dias", "dentro de
 * X semanas", com X em dígito ou por extenso. Resolve para a data alvo (BRT).
 * Retorna null se não houver. Exige um prefixo de prazo (daqui/em/dentro de)
 * para não casar "faz 3 dias que..." (fato passado). Recebe o texto já sem
 * acento (semNorm).
 */
function relativeCountDateBrt(semNorm: string, nowMs: number): string | null {
  const DAY = 86_400_000;
  const m = semNorm.match(
    /\b(?:daqui|em|dentro\s+de)\b[^\d]*?(\d{1,3}|um|uma|dois|duas|tres|quatro|cinco|seis|sete|oito|nove|dez|quinze|vinte|trinta)\s+(dias?|semanas?)\b/,
  );
  if (!m) return null;
  const n = /^\d+$/.test(m[1]!) ? Number(m[1]) : NUM_WORDS_PT[m[1]!];
  if (!n || n <= 0 || n > 120) return null; // guarda contra absurdos ("daqui a 999 dias")
  const mult = m[2]!.startsWith("semana") ? 7 : 1;
  return dateInBrt(new Date(nowMs + n * mult * DAY));
}

/** Próxima ocorrência (hoje incluído) do dia da semana pedido, em BRT. */
function nextWeekdayDateBrt(weekdayStem: string, nowMs: number): string {
  const DAY = 86_400_000;
  for (let i = 0; i <= 7; i++) {
    const d = new Date(nowMs + i * DAY);
    const diaPt = new Intl.DateTimeFormat("pt-BR", {
      weekday: "long",
      timeZone: "America/Sao_Paulo",
    }).format(d);
    const stem = diaPt
      .replace("-feira", "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .trim();
    if (stem === weekdayStem) return dateInBrt(d);
  }
  return dateInBrt(new Date(nowMs));
}

/**
 * Resolve datas RELATIVAS faladas pelo lead ("hoje", "amanhã", "depois de
 * amanhã", ou um dia da semana explícito como "terça"/"quarta-feira") para a
 * data alvo (YYYY-MM-DD em BRT). Retorna null se não houver.
 * IMPORTANTE: "amanhã" contém "manhã" — por isso o match de turno usa \b.
 */
function relativeTargetDateBrt(t: string): string | null {
  const now = Date.now();
  return immediateRelativeBrt(t, now) ?? weekOrWeekdayTargetBrt(t, now);
}

/** "hoje" / "amanhã" / "depois de amanhã" — os relativos INEQUÍVOCOS.
 *  Separados do resto porque têm precedência sobre a data absoluta; o nome do
 *  dia da semana, não (ver targetDateFromText). */
function immediateRelativeBrt(t: string, now: number): string | null {
  const DAY = 86_400_000;
  // \b só no início: "amanhã" termina em "ã" (não-word), então \b final falha.
  // O \b inicial basta — em "manhã" o "m" abre palavra; dentro de "amanhã" não.
  if (/depois\s+de\s+amanh[aã]/.test(t)) return dateInBrt(new Date(now + 2 * DAY));
  if (/\bamanh[aã]/.test(t)) return dateInBrt(new Date(now + DAY));
  if (/\bhoje\b/.test(t)) return dateInBrt(new Date(now));
  return null;
}

/** Dia da semana, "próxima semana", "mês que vem", "daqui a X dias". */
function weekOrWeekdayTargetBrt(t: string, now: number): string | null {
  const semNorm = t.normalize("NFD").replace(/[̀-ͯ]/g, "");
  // Referências de SEMANA/MÊS/PRAZO. Sem isto o lead pede "próxima semana"/"mês
  // que vem"/"daqui a 10 dias", o LLM não passa data_alvo e a busca ancora em
  // HOJE — ofertando/agendando o dia ERRADO. Caso real (Costa Lima Recreio,
  // Melissa 21 99305-7044): pediu "próxima semana", o sistema agendou quarta
  // 15/07 (desta semana) enquanto todo o texto dizia segunda 20/07. Só valem
  // quando NÃO há um dia da semana citado junto — "quinta da próxima semana"
  // deve resolver pela quinta, não pela segunda.
  const hasWeekday = /\b(domingo|segunda|terca|quarta|quinta|sexta|sabado)(?:-?feira)?\b/.test(
    semNorm,
  );
  if (!hasWeekday) {
    // Prazo em contagem ("daqui a 3 dias", "em 2 semanas") — antes das frases
    // de semana/mês porque "daqui a 2 semanas" cita "semanas" mas é contagem.
    const byCount = relativeCountDateBrt(semNorm, now);
    if (byCount) return byCount;
    if (/\b(?:proxima\s+semana|semana\s+que\s+vem|semana\s+seguinte)\b/.test(semNorm)) {
      return nextWeekMondayBrt(now);
    }
    if (/\b(?:proximo\s+mes|mes\s+que\s+vem|mes\s+seguinte)\b/.test(semNorm)) {
      return firstDayOfNextMonthBrt(now);
    }
  }

  // Dia da semana citado explicitamente. Sem isto, quando o lead pede um dia
  // DIFERENTE do que foi ofertado (ex.: ofertou segunda, lead pede "terça
  // feira... às 15:00"), targetDate ficava null e o filtro adiante só olhava
  // o TURNO (tarde) dentro dos slots JÁ ofertados — escolhia silenciosamente
  // um horário de SEGUNDA (dia errado) como se fosse o pedido do lead. Casos
  // reais (Clínica Bomfim, 10/07, leads Michele e Sandro): ambos pediram um
  // dia da semana diferente do ofertado e foram agendados no dia ERRADO sem
  // nunca terem confirmado isso.
  const normalized = t.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  const weekdayMatch = normalized.match(
    /\b(domingo|segunda|terca|quarta|quinta|sexta|sabado)(?:-?feira)?\b/,
  );
  if (weekdayMatch && WEEKDAY_STEMS.includes(weekdayMatch[1]!)) {
    return nextWeekdayDateBrt(weekdayMatch[1]!, now);
  }
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

/**
 * O lead está NEGANDO disponibilidade ("não posso", "não dá", "não vou
 * conseguir", "amanhã não dá", "impossível") — a mensagem NÃO é escolha de
 * horário, mesmo que cite um dia. Caso real (11 98945-0106): "não vou conseguir
 * ir amanhã".
 */
export function mentionsUnavailability(text: string): boolean {
  const t = text.toLowerCase();
  return (
    /\bn[ãa]o\s+(posso|poderei|consigo|vou\s+conseguir|vou\s+poder|vou|d[áa]\s+pra|d[áa]|da|rola|tenho\s+como)/.test(
      t,
    ) ||
    /amanh[ãa]\s+n[ãa]o\b/.test(t) ||
    /\bimposs[íi]vel\b/.test(t) ||
    mentionsTravelReturn(t)
  );
}

/**
 * O lead está VIAJANDO / de férias e cita o dia da VOLTA ("volto dia 07", "só
 * chego dia X", "estou viajando", "de férias"). Essa data é quando ele fica
 * DISPONÍVEL, não quando quer a consulta — não pode virar âncora de
 * agendamento nem ser lida como escolha. Caso real (Costa Lima Recreio, Wagner
 * 21 99401-9696): "estou viajando de férias volto o rio dia 07 de agosto" fez o
 * sistema ofertar/agendar justamente o 07/08 (dia da volta, à noite).
 */
export function mentionsTravelReturn(text: string): boolean {
  const t = (text ?? "").toLowerCase();
  if (!t) return false;
  return (
    /\bviaj/.test(t) || // viajar, viajando, viagem
    /\bde\s+f[ée]rias\b/.test(t) ||
    /\bs[óo]\s+(volto|chego|retorno|regresso)\b/.test(t) ||
    /\b(volto|chego|retorno|regresso)\s+(dia|no\s+dia|em|s[óo]|de|ao?)\b/.test(t)
  );
}

/** Pergunta neutra usada no lugar de uma oferta de horário INVENTADA. */
export const NEUTRAL_SLOT_PREFERENCE_QUESTION =
  "Pra eu já te trazer os horários certinhos da agenda: você prefere de manhã ou à tarde?";

/** Faixas de funcionamento ("das 8h às 18h", "de 08:00 até 18:00") — não são
 *  oferta de horário; removidas antes da detecção pra não gerar falso positivo. */
const TIME_RANGE_RE =
  /\bd[ae]s?\s*\d{1,2}(?::\d{2}|h(?:\d{2})?)?\s*(?:[àa]s|at[ée])\s*\d{1,2}(?::\d{2}|h(?:\d{2})?)?/gi;

/** Oferta CONCRETA de dia+horário ("segunda às 14h", "amanhã às 10:30").
 *  Atenção: \b não funciona antes de acento em JS ("à" ∉ \w) — por isso o
 *  "às" é ancorado por \s, não \b. */
const CONCRETE_TIME_OFFER_RE =
  /\b(?:segunda|ter[çc]a|quarta|quinta|sexta|s[áa]bado|domingo|amanh[ãa]|hoje)(?:-feira)?[^.!?\n]{0,40}?\s[àa]s\s*\d{1,2}(?::\d{2}|h(?:\d{2})?)?\b/i;

/** Horários citados dentro de uma frase, em minutos do dia: "9h" → 540,
 *  "9h30" → 570, "às 14" → 840, "10:30" → 630. Faixas de funcionamento já saem
 *  antes (TIME_RANGE_RE), então "das 8h às 18h" não entra aqui. */
const CITED_TIME_RE = /(?:[àa]s\s*)?(\d{1,2})(?::(\d{2})|h(\d{2})|h)(?![\d:])|[àa]s\s*(\d{1,2})\b/gi;

function citedTimesInMinutes(sentence: string): number[] {
  const out: number[] = [];
  for (const m of sentence.matchAll(CITED_TIME_RE)) {
    const h = Number(m[1] ?? m[4]);
    const min = Number(m[2] ?? m[3] ?? 0);
    if (h >= 0 && h <= 23 && min >= 0 && min <= 59) out.push(h * 60 + min);
  }
  return out;
}

/** Slot ofertado, no mínimo que este arquivo precisa ler. */
type OfferedTimeLike = { date_label?: string; time_label?: string };

/**
 * Remove de uma resposta ofertas de dia+horário que o agente NÃO pode sustentar.
 *
 * Dois cenários, um mesmo estrago (o lead recebe um horário que não existe):
 *
 *  1. `offered` vazio — o qualifier não tem agenda (listar_horarios é do
 *     scheduler), então qualquer "segunda às 14h" é INVENTADO e pode cair em dia
 *     bloqueado. Caso real (18/07, Costa Lima Recreio): "segunda-feira às 14h ou
 *     terça-feira às 10h" com a segunda bloqueada.
 *  2. `offered` preenchido mas a resposta cita um horário que NÃO está nele — o
 *     agente consultou a agenda e mesmo assim deslocou o horário, tipicamente
 *     para a hora que o lead pediu. Caso real (04/08/2026, Implanto Master Venda
 *     Nova, Sérgio 31 98727-1682): a agenda devolveu 08:00 e 08:30, o lead tinha
 *     pedido "as 9:00 horas" e o agente ofertou "amanhã às 9h ou às 9h30" —
 *     horários que nunca existiram. A trava antiga não pegava: ela só rodava com
 *     offered_slots VAZIO, e a chamada da tool no mesmo turn já os preenchia.
 *
 * Estratégia: mantém tudo ANTES da primeira frase ofensora (o pitch de valor
 * fica), corta dali em diante (a pergunta "qual desses?" que referencia a oferta
 * cai junto) e fecha ofertando os horários REAIS — ou, quando não há nenhum em
 * mãos, com uma pergunta neutra de preferência, deixando o scheduler ofertar de
 * verdade no turno seguinte. Menções a horário de funcionamento ("das 8h às
 * 18h") não disparam o corte.
 */
export function scrubInventedTimeOffers(
  reply: string,
  offered?: OfferedTimeLike[] | null,
): { reply: string; scrubbed: boolean } {
  const original = reply ?? "";
  if (!original.trim()) return { reply: original, scrubbed: false };

  const reais = (offered ?? []).filter((s) => s?.time_label);
  const minutosReais = new Set(reais.map((s) => minutesOfDayFromLabel(s.time_label!)));

  /** A frase oferta dia+hora que não podemos sustentar? */
  const ofensiva = (texto: string): boolean => {
    const limpo = texto.replace(TIME_RANGE_RE, "");
    if (!CONCRETE_TIME_OFFER_RE.test(limpo)) return false;
    // Sem horários reais em mãos, qualquer oferta concreta é inventada.
    if (minutosReais.size === 0) return true;
    // Com horários reais, só é ofensiva se citar um que não está entre eles.
    const citados = citedTimesInMinutes(limpo);
    return citados.length > 0 && citados.some((m) => !minutosReais.has(m));
  };

  if (!ofensiva(original)) return { reply: original, scrubbed: false };

  const fechamento = reais.length
    ? `Os horários que consigo são ${reais
        .slice(0, 2)
        .map((s) => `${s.date_label ?? ""} às ${s.time_label}`.trim())
        .join(" ou ")}. Qual deles fica melhor pra você? 😊`
    : NEUTRAL_SLOT_PREFERENCE_QUESTION;

  const lines = original.split("\n");
  let cutLine = -1;
  let cutCol = -1;
  outer: for (let i = 0; i < lines.length; i++) {
    for (const sentence of lines[i]!.split(/(?<=[.!?…])\s+/)) {
      if (ofensiva(sentence)) {
        cutLine = i;
        cutCol = lines[i]!.indexOf(sentence);
        break outer;
      }
    }
  }
  // Detectou no texto inteiro mas não numa frase isolada (quebra atípica):
  // fail-safe corta tudo e fica só o fechamento.
  if (cutLine === -1) return { reply: fechamento, scrubbed: true };

  const kept = [...lines.slice(0, cutLine), lines[cutLine]!.slice(0, Math.max(0, cutCol)).trim()]
    .filter((l) => l.trim())
    .join("\n");
  return {
    reply: kept ? `${kept}\n\n${fechamento}` : fechamento,
    scrubbed: true,
  };
}

/**
 * A data relativa está sendo AFIRMADA como fato / explicação, não pedida como
 * horário ("08/07 será amanhã", "amanhã é feriado", "seria amanhã"). Nesse caso
 * não é escolha de slot. Caso real (11 98945-0106): "08/07 será amanhã" (=
 * "o dia 8 é amanhã, por isso não dá") auto-selecionava 08/07 09:00 e reagendava
 * justamente o dia recusado. Cuidado: "pode ser amanhã" (pedido real) NÃO casa —
 * "ser " não é "será".
 */
export function relativeDateIsExplanatory(text: string): boolean {
  const t = text.toLowerCase();
  // "<algo> será/seria/foi/era amanhã" — data afirmada como fato.
  if (/(ser[áa]|seria|foi|era)\s+(hoje|amanh[ãa]|depois\s+de\s+amanh[ãa])/.test(t)) return true;
  // "amanhã é feriado", "amanhã será", "amanhã vai ser" — data como sujeito.
  if (/\b(hoje|amanh[ãa])\s+(é|ser[áa]|seria|vai\s+ser|foi|era)/.test(t)) return true;
  return false;
}

// ── Datas ABSOLUTAS ("12 de agosto", "12/08", "dia 12") ────────────────────
//
// relativeTargetDateBrt cobre só o vocabulário RELATIVO (hoje/amanhã/dia da
// semana/próxima semana/mês que vem/daqui a X). A forma mais explícita que um
// lead pode usar — a data em si — não era reconhecida por NINGUÉM.
//
// Caso real (Odonto Carioca Campo Grande, 21 99826-0816, 11/08/2026): o lead viu
// no Instagram o evento "Resgatando Sorrisos" do dia 12 e escreveu "Posso agendar
// uma consulta para o dia 12 de agosto?". O LLM chamou listar_horarios 3× sem
// data_alvo; a rede determinística devolveu null (não sabia ler "12 de agosto"),
// a busca ancorou em HOJE e o corte de 6 vagas encheu com quinta 13/08 — que
// tinha 33 vagas contra 2 no dia 12 (11:00 e 11:15, confirmadas na agenda).
// O agente então INVENTOU a justificativa: "a agenda de amanhã já está fechada
// para novos agendamentos". O lead foi atraído por uma campanha e ouviu que o
// dia da campanha estava fechado.

/** Ano/mês/dia de "agora" no fuso de Brasília. */
function brtYmd(nowMs: number): { y: number; m: number; d: number } {
  const p = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(nowMs));
  const g = (k: string) => Number(p.find((x) => x.type === k)!.value);
  return { y: g("year"), m: g("month"), d: g("day") };
}

/** "YYYY-MM-DD" se o trio existe no calendário, senão null (barra 31/02, 29/02
 *  em ano comum). Date.UTC normaliza silenciosamente — por isso conferimos. */
function isoValidoBrt(y: number, m: number, d: number): string | null {
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

// Uma data já passada NESTE ano só vira o ano seguinte quando está BEM para trás
// — o caso legítimo é o lead pedindo "5 de janeiro" em dezembro. Data recém-
// passada ("10 de agosto" dito no dia 11) é ambígua: engano de digitação ou
// referência ao passado. Aí devolvemos null e o agente pergunta — errar para
// 2027 seria muito pior do que uma re-pergunta.
const DIAS_ATE_VIRAR_O_ANO = 60;

/** Dia+mês (e ano, se o lead disse) → "YYYY-MM-DD" BRT futuro, ou null. */
function resolveDiaMesBrt(
  d: number,
  m: number,
  anoExplicito: number | null,
  nowMs: number,
): string | null {
  const hoje = brtYmd(nowMs);
  const hojeIso = isoValidoBrt(hoje.y, hoje.m, hoje.d)!;

  if (anoExplicito != null) {
    // Ano fora de [hoje, hoje+2] é data de NASCIMENTO ("15/03/1990") ou lixo
    // ("15/03/90" → 2090). Nunca é pedido de agendamento.
    if (anoExplicito < hoje.y || anoExplicito > hoje.y + 2) return null;
    const iso = isoValidoBrt(anoExplicito, m, d);
    return iso && iso >= hojeIso ? iso : null;
  }

  const esteAno = isoValidoBrt(hoje.y, m, d);
  if (esteAno && esteAno >= hojeIso) return esteAno;
  if (esteAno) {
    const diasAtras = (Date.parse(hojeIso) - Date.parse(esteAno)) / 86_400_000;
    if (diasAtras <= DIAS_ATE_VIRAR_O_ANO) return null;
  }
  return isoValidoBrt(hoje.y + 1, m, d);
}

/** "dia 12" sem mês → próxima ocorrência desse dia do mês, em BRT. */
function proximoDiaDoMesBrt(d: number, nowMs: number): string | null {
  const hoje = brtYmd(nowMs);
  if (d >= hoje.d) {
    const esteMes = isoValidoBrt(hoje.y, hoje.m, d);
    if (esteMes) return esteMes;
  }
  const y = hoje.m === 12 ? hoje.y + 1 : hoje.y;
  const m = hoje.m === 12 ? 1 : hoje.m + 1;
  return isoValidoBrt(y, m, d);
}

/**
 * Data ABSOLUTA pedida pelo lead → "YYYY-MM-DD" em BRT, ou null.
 * Formas aceitas: "12/08/2026", "12/08", "12 de agosto", "12 agosto",
 * "12 de agosto de 2026", "dia 12". Sempre resolve para o FUTURO.
 *
 * O que NÃO casa, de propósito:
 *  - horário ("14:30", "9h30") — separador ":"/"h", nunca "/";
 *  - telefone/CPF ("99826-0816") — mês precisa ser 1-12 e não pode haver dígito
 *    colado antes/depois do par;
 *  - endereço/valor ("Av. das Américas, 13.685") — ponto não é separador aqui;
 *  - data de nascimento ("15/03/1990") — ano explícito fora da janela.
 */
function absoluteComMesBrt(t: string, nowMs: number): string | null {
  if (!t) return null;

  // 1) Numérica COM ano: "12/08/2026", "12-08-26".
  const comAno = t.match(/(?<![\d/.-])(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})(?![\d/-])/);
  if (comAno) {
    const d = Number(comAno[1]);
    const m = Number(comAno[2]);
    const yy = comAno[3]!;
    const y = yy.length <= 2 ? 2000 + Number(yy) : Number(yy);
    if (d >= 1 && d <= 31 && m >= 1 && m <= 12) return resolveDiaMesBrt(d, m, y, nowMs);
    return null;
  }

  // 2) Numérica SEM ano: "12/08", "dia 12/8".
  const num = t.match(/(?<![\d/.-])(\d{1,2})[/-](\d{1,2})(?![\d/.-])/);
  if (num) {
    const d = Number(num[1]);
    const m = Number(num[2]);
    // "2/3 anos", "1/2 hora" — a barra ali é intervalo/fração, não data. Caso
    // real: "Não sei o certo, 2/3 anos" virava 2 de março.
    const unidade = /^\s*(anos?|mes(?:es)?|semanas?|dias?|horas?|h|min)\b/.test(
      t.slice(num.index! + num[0].length),
    );
    if (!unidade && d >= 1 && d <= 31 && m >= 1 && m <= 12) {
      return resolveDiaMesBrt(d, m, null, nowMs);
    }
  }

  // 3) Textual: "12 de agosto", "12 agosto", "12 de agosto de 2026".
  // matchAll (e não match) porque a primeira ocorrência de "<número> <palavra>"
  // pode não ser mês ("12 horas", "2 semanas") — seguimos procurando.
  const semAcc = t.normalize("NFD").replace(/[̀-ͯ]/g, "");
  for (const mt of semAcc.matchAll(/(?<!\d)(\d{1,2})\s*(?:de\s+)?([a-z]+)(?:\s+de\s+(\d{2,4}))?/g)) {
    const mes = MONTHS_PT[mt[2]!];
    const d = Number(mt[1]);
    if (!mes || d < 1 || d > 31) continue;
    const yy = mt[3];
    const y = yy == null ? null : yy.length <= 2 ? 2000 + Number(yy) : Number(yy);
    return resolveDiaMesBrt(d, mes, y, nowMs);
  }

  return null;
}

/** Só o dia do mês: "dia 12", "no dia 5". Exige a palavra "dia" — um número
 *  solto não dá pra distinguir de idade, quantidade ou horário. Sinal FRACO:
 *  sem o mês, "dia 8" pode ser o mês que vem. */
function absoluteSoDiaBrt(t: string, nowMs: number): string | null {
  const m = t.match(/\bdia\s+(\d{1,2})(?![\d/:.h-])/);
  if (!m) return null;
  // "dia 31 de fevereiro" não é "dia 31": o lead DEU o mês, e a data não existe.
  // Sem esta guarda o ramo forte devolvia null e este aqui reinterpretava como
  // dia 31 do mês corrente — inventando uma data que o lead não pediu.
  const depois = t.slice(m.index! + m[0].length).match(/^\s*(?:de\s+)?([a-zà-ú]+)/);
  if (depois && MONTHS_PT[depois[1]!.normalize("NFD").replace(/[̀-ͯ]/g, "")]) {
    return null;
  }
  const d = Number(m[1]);
  return d >= 1 && d <= 31 ? proximoDiaDoMesBrt(d, nowMs) : null;
}

/**
 * Data pedida pelo lead, combinando todos os sinais. A ORDEM é o que importa,
 * porque o lead frequentemente cita mais de um e eles se contradizem:
 *
 *  1. "hoje"/"amanhã"/"depois de amanhã" — inequívocos, ganham de tudo.
 *  2. Data absoluta COM mês ("20/08/26", "12 de agosto") — o sinal mais
 *     específico que existe. Ganha do nome do dia da semana: caso real
 *     "Pode se possível dia 20/08/26 quinta feira" — a próxima quinta era 13/08
 *     e o pedido era 20/08 (que também é quinta, uma semana depois).
 *  3. Dia da semana / "próxima semana" / "mês que vem" / "daqui a X dias".
 *  4. "dia 12" solto — fica por ÚLTIMO justamente por ser fraco. Caso real
 *     "Terça-feira, dia 8, às 10 horas": o dia 8 já tinha passado, e resolver
 *     por ele jogaria a busca pro mês seguinte; a terça-feira é a leitura certa.
 */
const CITA_DIA_DA_SEMANA_RE =
  /\b(?:domingo|segunda|terca|quarta|quinta|sexta|sabado)(?:-?feira)?\b/;

/** Dia da semana ("2026-08-25" → 2 = terça), em BRT. -1 se inválido. */
function diaDaSemanaBrt(iso: string): number {
  const d = new Date(`${iso}T12:00:00-03:00`);
  if (isNaN(d.getTime())) return -1;
  const abbr = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Sao_Paulo",
    weekday: "short",
  }).format(d);
  return ({ Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 } as Record<string, number>)[
    abbr
  ] ?? -1;
}

function targetDateFromText(t: string): string | null {
  const now = Date.now();
  const imediato = immediateRelativeBrt(t, now);
  if (imediato) return imediato;

  const comMes = absoluteComMesBrt(t, now);
  if (comMes) return comMes;

  const porSemana = weekOrWeekdayTargetBrt(t, now);
  const soDia = absoluteSoDiaBrt(t, now);

  // "a partir do dia 25 terça-feira": os DOIS sinais dizem terça, mas só o
  // número diz QUAL terça. Resolver pelo dia da semana pegava 18/08 — uma
  // semana antes do que a lead pediu. Caso real (Escudero Odontologia,
  // 12 98114-1612, 12/08).
  //
  // A condição de "dia N ainda não passou neste mês" é o que separa este caso
  // do outro real que fixou a ordem original — "Terça-feira, dia 8, às 10
  // horas", com o dia 8 já vencido. A armadilha ali é que 08/09/2026 TAMBÉM é
  // uma terça: sem exigir o mês corrente, a busca pularia um mês inteiro.
  if (
    soDia &&
    porSemana &&
    soDia !== porSemana &&
    CITA_DIA_DA_SEMANA_RE.test(t.normalize("NFD").replace(/[̀-ͯ]/g, "")) &&
    soDia.slice(0, 7) === dateInBrt(new Date(now)).slice(0, 7) &&
    diaDaSemanaBrt(soDia) === diaDaSemanaBrt(porSemana)
  ) {
    return soDia;
  }

  return porSemana ?? soDia;
}

/**
 * Data (YYYY-MM-DD BRT) que o lead PEDIU numa mensagem, se houver: dia da
 * semana ("quinta", "quinta-feira"), relativo ("amanhã", "hoje") ou absoluto
 * ("12 de agosto", "12/08", "dia 12"). Null se não houver.
 * Ignora negação ("quinta não dá") e afirmação-fato ("amanhã é feriado").
 * Usada pelo scheduler para ancorar a busca de horários no dia certo quando o
 * LLM esquece de passar data_alvo — sem isso a busca começa em "hoje" e oferta
 * um dia DIFERENTE do pedido.
 */
export function requestedDateFromText(text: string): string | null {
  const t = (text ?? "").trim().toLowerCase();
  if (!t) return null;
  if (mentionsUnavailability(t) || relativeDateIsExplanatory(t)) return null;
  // Data de NASCIMENTO completa ("15/03/1990", "15 de março de 1990") é resposta
  // de cadastro, não pedido de dia. requestedDateFromHistory varre o histórico
  // inteiro de trás pra frente — sem isto, a data de nascimento informada no
  // BOOKING viraria a âncora da próxima busca de horários.
  // Só bloqueia quando o ANO é passado: "14 de agosto de 2026" tem a mesma forma
  // de uma data de nascimento e é um pedido de agendamento legítimo.
  const nasc = parseBirthDateParts(text);
  if (nasc && nasc.year < brtYmd(Date.now()).y) return null;
  return targetDateFromText(t);
}

/** DD/MM (zero-padded, fuso BRT) de um instante ISO. "" se inválido. */
export function ddmmInBrt(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  return new Intl.DateTimeFormat("pt-BR", {
    timeZone: "America/Sao_Paulo",
    day: "2-digit",
    month: "2-digit",
  }).format(d); // "15/07"
}

/**
 * Data ABSOLUTA (DD/MM zero-padded) que o lead escreveu numa mensagem, ou null.
 * Reconhece "11/08", "dia 11/08", "11/8", "dia 11 de agosto", "11 de agosto".
 * relativeTargetDateBrt só entende relativo/dia-da-semana — não datas absolutas.
 *
 * NÃO casa horário ("14:30" — separador ":"/"h", não "/") nem valor/endereço
 * ("13.685" — ponto, e o mês precisa ser 1-12). Usada para detectar quando o
 * lead pede uma data que NÃO está entre os slots ofertados (ver
 * requestedDdMmFromRecentUser / o guard em tryAutoSelectOfferedSlot).
 */
export function absoluteDdMmFromText(text: string): string | null {
  const t = (text ?? "").toLowerCase();
  if (!t) return null;
  // Numérica: "11/08", "dia 11/8". Barra ou hífen; NÃO ponto (evita "13.685").
  const num = t.match(/\b(\d{1,2})[/-](\d{1,2})(?![/\-.]?\d)/);
  if (num) {
    const d = Number(num[1]);
    const m = Number(num[2]);
    if (d >= 1 && d <= 31 && m >= 1 && m <= 12) {
      return `${String(d).padStart(2, "0")}/${String(m).padStart(2, "0")}`;
    }
  }
  // Textual: "11 de agosto", "11 agosto".
  const semAcc = t.normalize("NFD").replace(/[̀-ͯ]/g, "");
  const txt = semAcc.match(/\b(\d{1,2})\s*(?:de\s+)?([a-z]+)\b/);
  if (txt) {
    const d = Number(txt[1]);
    const m = MONTHS_PT[txt[2]!];
    if (m && d >= 1 && d <= 31) {
      return `${String(d).padStart(2, "0")}/${String(m).padStart(2, "0")}`;
    }
  }
  return null;
}

/**
 * Datas (DD/MM, zero-padded) que o AGENTE afirmou ao lead nas mensagens dadas.
 * Usada para travar o booking quando o slot escolhido cai num dia que NUNCA foi
 * mostrado ao lead no texto — sinal de que o modelo reescreveu a data dos slots.
 * Caso real (Costa Lima Recreio, Melissa 21 99305-7044): a tool devolveu slots
 * de quarta 15/07, mas o agente escreveu "segunda-feira, 20/07"; o "13h" do lead
 * casou o slot oculto de 15/07 e agendou o dia ERRADO com o lead achando 20/07.
 * Ignora números com ponto/milhar (ex.: "Av. das Américas, 13.685") — só casa
 * DD/MM com barra.
 */
export function affirmedDatesFromAssistant(texts: string[]): Set<string> {
  const out = new Set<string>();
  for (const raw of texts) {
    const matches = (raw ?? "").matchAll(/\b(\d{1,2})\/(\d{1,2})(?:\/\d{2,4})?\b/g);
    for (const m of matches) {
      const dd = Number(m[1]);
      const mm = Number(m[2]);
      if (dd >= 1 && dd <= 31 && mm >= 1 && mm <= 12) {
        out.add(`${String(dd).padStart(2, "0")}/${String(mm).padStart(2, "0")}`);
      }
    }
  }
  return out;
}

/**
 * Turno ("manha"/"tarde"/"noite") que o lead PEDIU numa mensagem, ou null.
 * Mesma detecção usada por pickSlotByPreference. O \b inicial em manh[aã] evita
 * casar "amanhã" (o "m" ali é precedido de "a"; em "manhã"/"de manhã" o "m"
 * abre palavra). Usada pelo scheduler para filtrar a busca pelo turno certo
 * quando o LLM esquece de passar `periodo` — sem isso a busca traz só os
 * horários mais cedo e diz "não tem de manhã/à tarde" mesmo com o turno livre.
 */
/**
 * Um turno citado numa cláusula de TRABALHO ou NEGAÇÃO é indisponibilidade, não
 * o desejo. "trabalho de manhã", "de manhã não dá", "não posso de manhã" → a
 * manhã está EXCLUÍDA. Usado para desambiguar quando a frase cita dois turnos.
 */
function periodoExcluido(t: string, palavra: string): boolean {
  const p = palavra; // "manh[ãa]" | "tarde" | "noite"
  return (
    new RegExp(`(?:trabalh|ocupad|aula|estud|curso|escola|faculdad)\\w*\\s*(?:de|pela|pelo|[àa]|no|na)?\\s*${p}`).test(t) ||
    new RegExp(`${p}[^,.;]*\\bn[ãa]o\\b`).test(t) ||
    new RegExp(`\\bn[ãa]o\\b[^,.;]*(?:posso|consigo|d[áa]|vou|tenho)?[^,.;]*${p}`).test(t)
  );
}

/**
 * Turno ("manha"/"tarde"/"noite") que o lead DESEJA numa mensagem, ou null.
 *
 * Quando a frase cita DOIS turnos ("trabalho de manhã, só posso de tarde"), o
 * detector antigo pegava o PRIMEIRO ("manhã") e ofertava manhã — o oposto do
 * pedido. Caso real (Costa Lima Recreio, Luciano 32 99160-7088). Agora: se um
 * turno aparece numa cláusula de trabalho/negação, ele é EXCLUÍDO; sobra o
 * desejado. Se ainda ambíguo, vale o ÚLTIMO citado (costuma ser o operativo).
 */
/**
 * Extrai da anotação do caso (lead_data.notes) a marca de que o agendamento
 * inclui OUTRA pessoa / acompanhante no mesmo número — pra GARANTIR que essa
 * informação chegue nas observações do agendamento (o resumo por IA remove
 * nomes próprios e cortaria isso). Não dá pra cadastrar 2 pacientes com o mesmo
 * número: a equipe cadastra o acompanhante no local, então a observação precisa
 * avisar. Retorna "" quando não há acompanhante. Requisito do usuário (21/07).
 */
export function extractCompanionAppointmentNote(notes: string | undefined | null): string {
  const raw = (notes ?? "").trim();
  if (!raw) return "";
  for (const part of raw.split(/[\n;]+/).map((p) => p.trim())) {
    if (
      /\b(outra pessoa|acompanhante)\b/i.test(part) ||
      /\b(vai|vir[áa]?|vem|ir|indo|leva(?:r|ndo)?)\b[^.;\n]*\bjunto\b/i.test(part) ||
      /\bjunto\s+(comigo|com\s+ela|com\s+ele)\b/i.test(part)
    ) {
      return part.slice(0, 140);
    }
  }
  return "";
}

/** Data YYYY-MM-DD (fuso de Brasília) de um horário ISO. "" se vazio/inválido. */
export function slotDayBrt(iso: string | undefined | null): string {
  const s = (iso ?? "").trim();
  if (!s) return "";
  const d = new Date(s);
  if (isNaN(d.getTime())) return "";
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(d);
}

/**
 * O lead está pedindo um DIA diferente do horário que já escolheu?
 * `requestedDay` = YYYY-MM-DD que o lead pediu (do data_alvo ou do histórico).
 * Usado pra decidir se listar_horarios deve buscar de novo mesmo com
 * selected_slot_iso setado (ex.: já agendado na quarta, pede "tem quinta?").
 */
export function isAskingDifferentDay(
  selectedSlotIso: string | undefined | null,
  requestedDay: string | null | undefined,
): boolean {
  const req = (requestedDay ?? "").slice(0, 10);
  if (!req) return false;
  const sel = slotDayBrt(selectedSlotIso);
  if (!sel) return false;
  return req !== sel;
}

/**
 * "boa tarde" / "boa noite" — a SAUDAÇÃO, não uma preferência de turno.
 *
 * Caso real (Odonto Carioca Campo Grande, 21 99272-7525, 11/08): o lead escreveu
 * "Boa tarde, gostaria de agendar uma avaliação para amanhã". A âncora de data
 * acertou (12/08), mas o "tarde" da SAUDAÇÃO virou filtro de turno. A agenda do
 * dia 12 tinha uma única vaga — 11:15, de manhã — que o filtro removeu; a busca
 * reportou "SEM VAGA em 2026-08-12" e ofereceu quinta 13/08. A prova está na
 * própria oferta: o dia 13 tinha 30 vagas a partir das 09:00 e o agente citou
 * 12:00, 12:15, 13:15, 13:30, 13:45, 14:00 — nenhuma de manhã.
 *
 * Em 20.000 mensagens de lead, 665 dos 1.182 turnos detectados (56%) vinham só
 * da saudação, afetando 557 conversas. E requestedPeriodoFromHistory varre o
 * histórico inteiro: um "Boa tarde" na primeira mensagem filtrava toda busca da
 * conversa daí em diante. "Bom dia" escapava por acaso — "dia" não é turno.
 *
 * Mascara com espaços do MESMO tamanho para preservar os offsets: o desempate
 * "último turno citado vence" usa a posição de cada ocorrência.
 */
const SAUDACAO_RE = /\bbo(?:a|as)\s*-?\s*(?:tardes?|noites?)\b/g;

/**
 * Marcos do dia que implicam um TURNO. Exigem direção ("depois de", "antes de")
 * de propósito: `almoço` sozinho é quase sempre narrativa, não preferência.
 *
 * "na volta do almoço" foi TESTADO e REMOVIDO: na varredura de produção era o
 * único padrão que gerava falso positivo — "vou falar com ela na volta do
 * almoço" fala de quando alguém RETORNA, não de quando o lead quer ser
 * atendido, e virava filtro de tarde.
 */
const MARCOS_DO_DIA: Array<{ key: "manha" | "tarde" | "noite"; src: string }> = [
  // → TARDE
  { key: "tarde", src: String.raw`(?:depois|ap[oó]s|passad[oa])\s+(?:(?:d[oe]|[oa])\s+)?almo[cç]o` },
  { key: "tarde", src: String.raw`p[oó]s[-\s]*almo[cç]o` },
  { key: "tarde", src: String.raw`(?:depois|ap[oó]s)\s+(?:de\s+)?(?:que\s+)?(?:eu\s+)?almo[cç]ar` },
  { key: "tarde", src: String.raw`(?:depois|ap[oó]s)\s+(?:(?:d[oe]|[oa])\s+)?meio[-\s]?dia` },
  // → MANHÃ
  { key: "manha", src: String.raw`antes\s+(?:d[oe]|[oa])\s+almo[cç]o` },
  { key: "manha", src: String.raw`antes\s+de\s+almo[cç]ar` },
  { key: "manha", src: String.raw`antes\s+(?:d[oe]|[oa])\s+meio[-\s]?dia` },
  // → NOITE
  { key: "noite", src: String.raw`(?:depois|ap[oó]s)\s+(?:(?:d[oe]|[oa])\s+)?jantar` },
];

export function requestedPeriodoFromText(text: string): "manha" | "tarde" | "noite" | null {
  // Só a ocorrência da saudação sai — "Boa tarde, prefiro de tarde" continua
  // sendo tarde.
  const t = (text ?? "").toLowerCase().replace(SAUDACAO_RE, (s) => " ".repeat(s.length));
  if (!t.trim()) return null;
  const present: Array<{ key: "manha" | "tarde" | "noite"; re: string; idx: number }> = [];
  const m = t.search(/\bmanh[aã]/);
  const ta = t.search(/\btarde/);
  const n = t.search(/\bnoite/);
  if (m >= 0) present.push({ key: "manha", re: "manh[ãa]", idx: m });
  if (ta >= 0) present.push({ key: "tarde", re: "tarde", idx: ta });
  if (n >= 0) present.push({ key: "noite", re: "noite", idx: n });

  // Marcos do dia: muita gente organiza a agenda por REFEIÇÃO, não por turno.
  // Entram aqui como se o turno tivesse sido dito, na posição em que aparecem —
  // assim o desempate "último turno citado vence" e o periodoExcluido
  // ("não posso depois do almoço") continuam valendo.
  //
  // Caso real (Odonto Carioca Campo Grande, 21 99027-0086, 12/08): o lead disse
  // "Pode ser depois do almoço." e recebeu 09:30 e 09:45. O turno ficava nulo, a
  // busca não filtrava nada e a oferta vinha com os horários mais cedo da agenda.
  //
  // A DIREÇÃO é obrigatória ("depois de", "antes de"): "almoço" solto quase
  // sempre é narrativa — "Ontem no almoço a dentadura quebrou", "Estou fazendo o
  // almoço" — e virar filtro de tarde nesses casos seria pior que não detectar.
  for (const marco of MARCOS_DO_DIA) {
    for (const hit of t.matchAll(new RegExp(marco.src, "g"))) {
      present.push({ key: marco.key, re: marco.src, idx: hit.index ?? 0 });
    }
  }

  if (present.length === 0) return null;
  if (present.length === 1) return present[0]!.key;

  // Dois+ turnos: remove os que estão em cláusula de trabalho/negação.
  const restantes = present.filter((p) => !periodoExcluido(t, p.re));
  if (restantes.length === 1) return restantes[0]!.key;
  const pool = restantes.length > 0 ? restantes : present;
  // Ainda ambíguo: o último turno citado costuma ser o operativo.
  return pool.reduce((a, b) => (b.idx > a.idx ? b : a)).key;
}

/**
 * Hora exata (0-23) que o lead PEDIU numa mensagem, ou null. Exige sufixo de
 * hora explícito ("16h", "16 horas", "16:00") para não casar números soltos
 * de data ("dia 23"). Usada pelo scheduler para priorizar, dentro do turno
 * filtrado, os horários mais PRÓXIMOS da hora pedida antes do corte de 6 —
 * sem isso o corte pega sempre os 6 mais cedo do turno (ex: 12:00-14:30) e
 * nunca alcança um horário pedido mais tarde no mesmo turno (ex: 16:00),
 * mesmo com esse horário livre (caso real: lead pediu 16h repetidas vezes,
 * agenda da semana seguinte vazia, mas o corte só oferecia até 14:30).
 *
 * O lead fala como brasileiro, não em 24h: "4 horas da tarde" é 16, não 4. Sem
 * converter, o ranking priorizava os horários mais próximos das 4h — ou seja, a
 * MANHÃ — para quem só pode no fim da tarde. Caso real (16/07, Costa Lima
 * Recreio, Eliane 21 97256-0633): "só saio 4 horas da tarde" → ofertaram 09:00,
 * 09:45 e 10:30; a clínica teve de resolver por telefone.
 */
export function requestedHoraFromText(text: string): number | null {
  const t = (text ?? "").toLowerCase();
  if (!t) return null;
  // "às 16", "as 16 horas" (o "às" já indica hora, sufixo opcional) OU
  // "16h"/"16 horas"/"16:00" (sufixo de hora obrigatório sem "às") OU
  // "5 da tarde" (o turno logo depois já indica que o número é hora).
  const m = t.match(
    /\b(?:[àa]s\s*(\d{1,2})(?:\s*h(?:oras?)?)?|(\d{1,2})\s*(?:h(?:oras?)?|:00)|(\d{1,2})(?=\s*d[aeo]\s*(?:manh[ãa]|tarde|noite)))\b/,
  );
  if (!m) return null;
  const h = Number(m[1] ?? m[2] ?? m[3]);
  if (!(h >= 0 && h <= 23)) return null;

  // Turno dito logo APÓS a hora ("4 horas da tarde", "7 da noite").
  const after = t.slice((m.index ?? 0) + m[0].length);
  const periodo = after.match(/^\s*d[aeo]\s*(manh[ãa]|tarde|noite)/)?.[1];
  if (periodo) {
    if (periodo.startsWith("manh")) return h === 12 ? 0 : h; // "12 da manhã" = meia-noite
    if (periodo === "noite" && h === 12) return 0; // "12 da noite" = meia-noite
    return h < 12 ? h + 12 : h; // "5 da tarde" → 17; "16 da tarde" segue 16
  }
  // Sem turno explícito, 1h-6h é quase sempre PM na fala ("saio 4 horas"):
  // nenhuma clínica atende de madrugada, e ler ao pé da letra jogava a oferta
  // para a manhã. 7h-11h fica como está (7h/9h da manhã são plausíveis).
  return h >= 1 && h <= 6 ? h + 12 : h;
}

/**
 * Ordena os horários pela PROXIMIDADE da hora que o lead pediu, para que o corte
 * de N seguinte fique com os mais próximos do pedido — e não sempre com os mais
 * cedo do turno. Sem hora pedida devolve a lista intacta (ordem cronológica).
 *
 * `minutosDoDia` extrai o minuto do dia de cada slot (ex.: "16:45" → 1005), o
 * que desempata dentro da mesma hora: pedindo 17h, 16:45 vem antes de 16:00.
 *
 * `diaDoSlot` (YYYY-MM-DD) é o que impede o ranking de COMER O DIA PEDIDO. Sem
 * ele a ordenação é global: pedindo 9h, um 08:30 de sábado (3 dias à frente)
 * passa na frente do 16:00 de HOJE, e com o corte de 6 o dia pedido some da
 * lista inteira — o agente então conclui "hoje não temos vaga" com a agenda de
 * hoje livre. Caso real (04/08/2026, Implanto Master Venda Nova, Sérgio
 * 31 98727-1682): lead disse "quero as 9:00 horas" e depois "Hoje"; as 6 vagas
 * ofertadas eram de quarta e sábado, nenhuma de terça — e a clínica tinha 16:00
 * e 17:30 livres naquela terça.
 *
 * Com `diaDoSlot`, os dias entram em ordem CRONOLÓGICA e o ranking por hora vale
 * DENTRO de cada dia; a saída intercala os dias em rodadas de 2, de modo que
 * todo dia com vaga sobrevive ao corte enquanto couber.
 *
 * Vive aqui (e não no ramo de um provedor) porque os quatro provedores precisam
 * do MESMO comportamento: o ranking existia só no Clinicorp, então Google
 * Calendar e Clinic Experts ignoravam a hora pedida e ofertavam sempre o começo
 * do turno.
 */
export function rankSlotsByRequestedHour<T>(
  slots: readonly T[],
  hora: number | null | undefined,
  minutosDoDia: (slot: T) => number,
  diaDoSlot?: (slot: T) => string,
): T[] {
  if (hora == null) return [...slots];
  const alvo = hora * 60;
  const porProximidade = (a: T, b: T) =>
    Math.abs(minutosDoDia(a) - alvo) - Math.abs(minutosDoDia(b) - alvo);
  if (!diaDoSlot) return [...slots].sort(porProximidade);

  const porDia = new Map<string, T[]>();
  for (const s of slots) {
    const chave = diaDoSlot(s);
    const fila = porDia.get(chave);
    if (fila) fila.push(s);
    else porDia.set(chave, [s]);
  }
  // Chaves YYYY-MM-DD ordenam lexicograficamente = cronologicamente.
  const dias = [...porDia.keys()].sort();
  for (const d of dias) porDia.get(d)!.sort(porProximidade);

  // 2 por rodada: o dia pedido entra com um PAR de opções (é o que o agente
  // oferta) sem que um único dia cheio consuma o corte inteiro.
  const POR_RODADA = 2;
  const out: T[] = [];
  for (let rodada = 0; out.length < slots.length; rodada++) {
    const antes = out.length;
    for (const d of dias) {
      const fila = porDia.get(d)!;
      const ini = rodada * POR_RODADA;
      for (let i = ini; i < ini + POR_RODADA && i < fila.length; i++) out.push(fila[i]!);
    }
    if (out.length === antes) break;
  }
  return out;
}

/** "16:45" / "16h45" / "9:00" → minutos do dia (1005, 1005, 540). -1 se inválido. */
export function minutesOfDayFromLabel(label: string): number {
  const m = /(\d{1,2})[:h.](\d{2})/.exec(label ?? "");
  if (m) {
    const h = Number(m[1]);
    const mi = Number(m[2]);
    if (h >= 0 && h <= 23 && mi >= 0 && mi <= 59) return h * 60 + mi;
    return -1;
  }
  const onlyHour = /^\s*(\d{1,2})\s*h?\s*$/.exec(label ?? "");
  if (onlyHour) {
    const h = Number(onlyHour[1]);
    if (h >= 0 && h <= 23) return h * 60;
  }
  return -1;
}

function pickSlotByPreference(
  slots: OfferedSlot[],
  text: string,
  assistantText: string,
  lastTurnText: string,
): Partial<LeadData> | null {
  const t = text.toLowerCase();

  // Negação/explicação de data NÃO é escolha de horário — não auto-selecionar.
  if (mentionsUnavailability(t) || relativeDateIsExplanatory(t)) return null;

  // PERGUNTA ABERTA nunca é escolha. "eu trabalho até esse horário, tem mais
  // tarde?" é um pedido de OPÇÕES da tarde — o path de turno selecionava o
  // primeiro slot da tarde (13:00) como se o lead tivesse escolhido, e o
  // booking ia atrás desse horário mesmo o lead aceitando depois OUTRO (16:45).
  // Caso real (Costa Lima Recreio, Luciano 32 99160-7088, 15/07). O agente deve
  // RESPONDER a pergunta (listar as opções), não travar uma escolha.
  if (/\btem\s+(mais|outro|outra|algum|alguma)\b/.test(t)) return null;

  // ...MAS terminar em "?" não basta para desqualificar: em português pedir
  // educadamente é interrogativo. "Consegue confirmar uma avaliação para amanhã
  // às 09:15?" é uma ESCOLHA explícita (dia + hora) com verniz de cortesia.
  // Caso real (Odonto Carioca Campo Grande, Marco 21 97457-6765, 03/08): o "?"
  // final zerou a auto-seleção, criar_agendamento falhou por slot ausente, o
  // agente re-ofereceu os MESMOS horários que o lead tinha acabado de escolher
  // e um humano precisou assumir para agendar.
  //
  // A exceção é estreita de propósito: só quando a pergunta cita um horário que
  // BATE com um slot realmente ofertado. Pergunta genuína de opções ("tem mais
  // tarde?", "e de manhã?") não cita horário ofertado e continua barrada acima
  // ou aqui.
  if (/\?\s*$/.test(t)) {
    const horariosCitados = timesInText(t);
    const citaHorarioOfertado = slots.some((s) => {
      const time = normalizeTimeLabel(s.time_label);
      return time !== "" && horariosCitados.has(time);
    });
    if (!citaHorarioOfertado) return null;
  }

  // Data relativa ("amanhã", "hoje", "depois de amanhã"). O \b em relativo
  // evita o bug clássico: "amanhã" contém "manhã".
  // Absoluta também ("dia 12/08 às 14h"): sem ela a data era ignorada e o filtro
  // olhava só o HORÁRIO — "14h" casava o slot das 14h de QUALQUER dia ofertado.
  // Aqui a data só pode ESTREITAR a escolha: se nenhum slot cai nela, filtered
  // zera e não se auto-seleciona nada (o guard leadRequestedUnofferedDate já
  // barra antes o pedido de um dia que não foi ofertado).
  const targetDate = targetDateFromText(t);

  // Turno do dia. \b inicial impede "amanhã" de casar como "manhã": o "m"
  // dentro de "amanhã" é precedido por "a" (sem boundary); em "manhã"/"de
  // manhã" o "m" abre palavra.
  // Turno DESEJADO com desambiguação: "trabalho de manhã, só posso de tarde"
  // quer TARDE, não manhã (requestedPeriodoFromText remove o turno que está em
  // cláusula de trabalho/negação). Sem isto, o auto-select filtrava por manhã.
  const desejado = requestedPeriodoFromText(t);
  const wantMorning = desejado === "manha";
  const wantAfternoon = desejado === "tarde";
  const wantEvening = desejado === "noite";

  if (!targetDate && !wantMorning && !wantAfternoon && !wantEvening) return null;

  const mentioned = slots.filter((s) => slotMentionedInText(s, assistantText));
  const hasMentioned = mentioned.length > 0;

  // Slots cujo HORÁRIO o agente disse em voz alta NO ÚLTIMO TURNO ("às 17h",
  // "14:00"). É o único sinal confiável de "estes aqui foram OFERECIDOS agora":
  // slotMentionedInText casa por DIA DA SEMANA em qualquer ponto do texto —
  // inclusive quando o agente fala da INDISPONIBILIDADE do lead — e a janela
  // larga (últimas 4 mensagens) ainda arrastaria ofertas já RECUSADAS.
  const turnTimes = timesInText(lastTurnText);
  const offeredNow = slots.filter((s) => {
    const time = normalizeTimeLabel(s.time_label);
    return time !== "" && turnTimes.has(time);
  });

  let pool = offeredNow.length > 0 ? offeredNow : hasMentioned ? mentioned : slots;

  // Preferência de TURNO pura ("manhã"/"tarde", sem data) dita ANTES de o agente
  // ofertar horários específicos NÃO é escolha de slot — é só um filtro. Não
  // auto-seleciona (deixa o agente LISTAR os horários reais e o lead escolher).
  // Evita o bug: lead pede "dia 7", agenda só tem 13/07, lead diz "tarde" e o
  // sistema travava 13/07 13:00 achando que era a escolha.
  //
  // O gate agora é offeredNow (horário dito), NÃO hasMentioned (dia da semana
  // solto). Caso real (Clínica Bomfim, 21 96416-7887, 13/07): o agente ofertou
  // "hoje 17h ou 18h", o lead RECUSOU ("tenho compromisso de segunda a quarta
  // nesse horário") e o agente respondeu "como de SEGUNDA a quarta fica mais
  // difícil, que tal quinta? … prefere manhã ou tarde?". A palavra "segunda"
  // nessa frase — que fala da recusa do lead — fez slotMentionedInText casar os
  // slots velhos de segunda-feira 13/07, hasMentioned virou true e este guard
  // foi desarmado. O "Tarde" seguinte (resposta ao "manhã ou tarde?", ou seja um
  // FILTRO para quinta) auto-selecionou 13/07 17:00 — justamente o horário
  // recusado — e o booking determinístico criou o agendamento na Clinicorp sem
  // o lead nunca ter confirmado nada.
  if (!targetDate && offeredNow.length === 0 && (wantMorning || wantAfternoon || wantEvening)) {
    return null;
  }

  let filtered = pool;

  // Horário EXPLÍCITO na mensagem do lead ("quinta às 15h30") manda sobre o
  // resto: sem isto, um pedido com dia + hora caía no filtro só por data e
  // pegava o slot MAIS CEDO do dia, agendando um horário que o lead não pediu.
  const userTime = normalizeTimeLabel(t);
  if (userTime) {
    filtered = filtered.filter((s) => normalizeTimeLabel(s.time_label) === userTime);
    if (filtered.length === 0) return null;
  }
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

export function sanitizeLeadDataPatch(
  patch: Partial<LeadData>,
  opts?: { current?: LeadData; lastAssistantText?: string },
): Partial<LeadData> {
  const next: Partial<LeadData> = { ...patch };
  const current = opts?.current;
  const lastAssistantAskedForSurname = /sobrenome/i.test(opts?.lastAssistantText ?? "");
  if (next.custom_fields) {
    const cleaned: Record<string, string> = {};
    for (const [k, v] of Object.entries(next.custom_fields)) {
      if (typeof v !== "string") continue;
      // CPF: só aceita valor que seja um CPF válido e normaliza p/ 000.000.000-00.
      // Um valor não-CPF (ex.: "9h") é descartado — o agente re-pergunta.
      if (isCpfKey(k)) {
        if (isValidCpf(v)) cleaned[k] = formatCpf(v);
        continue;
      }
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
    if (
      looksLikeSchedulingPreference(next.name) ||
      looksLikeIntentMessage(next.name) ||
      looksLikeDecline(next.name) ||
      looksLikeGratitudeOrClosing(next.name) ||
      // mentionsUnavailability já existia e acerta ("hoje não consigo"), mas não
      // era consultado aqui — nomes assim entravam no cadastro do paciente.
      mentionsUnavailability(next.name) ||
      looksLikeSentenceNotName(next.name)
    ) {
      delete next.name;
    }
  }
  // Pedimos o SOBRENOME e o modelo devolveu name="Souza", jogando fora o "Ana"
  // que já tínhamos. Junta os dois — sem isto o campo nunca fica completo e o
  // agente repete a pergunta. Só quando o assistente ACABOU de pedir o sobrenome:
  // fora desse caso um nome novo é correção do lead ("na verdade é Bia") e deve
  // substituir, não grudar.
  if (
    typeof next.name === "string" &&
    next.name.trim() &&
    current?.name?.trim() &&
    lastAssistantAskedForSurname
  ) {
    next.name = mergePartialName(current.name, next.name);
  }
  return next;
}

function slotMentionedInText(slot: OfferedSlot, text: string): boolean {
  const hay = text.toLowerCase();
  const time = normalizeTimeLabel(slot.time_label);
  const userTime = normalizeTimeLabel(hay);
  // Compara NORMALIZADO, não como substring: o slot guarda "09:00" e o lead
  // escreve "9h" / "9 horas" / "às 9". O `includes` literal nunca casava essas
  // formas e o slot ficava sem ser reconhecido como mencionado.
  if (time && (hay.includes(time) || userTime === time)) return true;

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

/**
 * Só as mensagens do agente do ÚLTIMO turno — as que vieram depois da mensagem
 * anterior do lead. É a esse turno que o lead está respondendo.
 *
 * recentAssistantContext (as últimas 4 mensagens) é uma janela larga demais para
 * decidir "quais horários acabaram de ser oferecidos": ela arrasta ofertas
 * ANTIGAS, inclusive as que o lead já recusou, para dentro do contexto.
 */
/** Índice da última mensagem do lead no histórico (-1 se não houver). */
function lastUserIndex(history: { role: "user" | "assistant"; content: string }[]): number {
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i]!.role === "user") return i;
  }
  return -1;
}

function lastAssistantTurnText(
  history: { role: "user" | "assistant"; content: string }[],
  beforeIdx: number,
): string {
  const turn: string[] = [];
  for (let i = beforeIdx - 1; i >= 0; i--) {
    if (history[i]!.role === "user") break;
    turn.unshift(history[i]!.content);
  }
  return turn.join("\n");
}

/**
 * As mensagens do lead do ÚLTIMO turno (a rajada final de mensagens do lead, sem
 * fala do agente no meio). O lead costuma quebrar um pedido em várias mensagens
 * seguidas ("Pode ser dia 11/08" + "Na parte da manhã") — olhar só a última
 * perderia a data que veio na mensagem anterior da mesma rajada.
 */
function lastUserBurst(
  history: { role: "user" | "assistant"; content: string }[],
): string[] {
  const out: string[] = [];
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i]!.role !== "user") break;
    out.unshift(history[i]!.content);
  }
  return out;
}

export function patchFromSlot(slot: OfferedSlot): Partial<LeadData> {
  return {
    selected_slot_iso: slot.iso,
    ...(slot.dentist_person_id != null ? { dentist_person_id: slot.dentist_person_id } : {}),
  };
}

/**
 * true quando o lead, na sua rajada final de mensagens, pediu uma DATA absoluta
 * ("dia 11/08") que NÃO corresponde a nenhum slot ofertado — sinal de que ele
 * quer MUDAR de dia, não escolher entre os horários já oferecidos. Nesse caso
 * nenhuma escolha (nem determinística, nem por LLM) deve finalizar um slot: o
 * agente precisa re-listar na data pedida. Caso real (Costa Lima Recreio,
 * Wagner 21 99401-9696): ofertou 07/08 e 08/08, o lead pediu "dia 11/08" + "de
 * manhã", e o "manhã" agendava 07/08 09:00 — o dia que ele acabara de recusar.
 * O lead costuma quebrar "dia 11/08" e "de manhã" em duas mensagens seguidas,
 * por isso olhamos a rajada inteira, não só a última.
 */
export function leadRequestedUnofferedDate(
  leadData: LeadData,
  history: { role: "user" | "assistant"; content: string }[],
): boolean {
  const slots = leadData.offered_slots ?? [];
  if (slots.length === 0) return false;
  const offeredDdMm = new Set(slots.map((s) => ddmmInBrt(s.iso)).filter(Boolean));
  for (const msg of lastUserBurst(history)) {
    const ddmm = absoluteDdMmFromText(msg);
    if (ddmm && !offeredDdMm.has(ddmm)) return true;
  }
  return false;
}

// Um horário citado NO MEIO de uma frase, em qualquer forma: "09:00", "9h30",
// "9h", "9 horas". Antes só `\d{1,2}:\d{2}` era considerado horário, então
// "pode ser 9h" / "sexta 9h" não eram lidos como aceite.
// Mesmos separadores/espaçamento de HH_MM_SRC ("14:30", "14: 30", "14.30",
// "14h30") — antes só ":"/"h" colados aos minutos valiam aqui também.
// O `,?` antes do marcador de hora aceita "10, horas" (ver BARE_HOUR_RE). A
// alternativa com minutos vem primeiro, então "10,30" continua sendo 10:30.
const TIME_IN_TEXT_SRC = String.raw`(?<![\d.,])\d{1,2}(?:\s*[:h.,]\s*[0-5]\d(?!\d)|\s*,?\s*h(?:s|rs?|oras?)?\b)`;
const TIME_IN_TEXT_RE = new RegExp(TIME_IN_TEXT_SRC, "i");
// A mensagem inteira é SÓ um horário: "18:20", "14.30", "às 18:20", "9h",
// "9 horas", "às 9". Um número solto ("9") fica de fora de propósito — sem o
// marcador de hora ou a preposição não dá pra distinguir de dia do mês/idade.
const ONLY_TIME_RE = new RegExp(
  String.raw`^(?:(?:[àa]s?\s+)?\d{1,2}(?:\s*[:h.,]\s*[0-5]\d|\s*,?\s*h(?:s|rs?|oras?)?)|[àa]s\s+\d{1,2})\s*[.!?]?$`,
  "i",
);

// Escolha por ORDEM ("o primeiro", "quero esse primeiro horário", "a 2ª opção").
//
// O ordinal SOZINHO no meio da frase não basta: em "primeiro preciso saber o
// valor" / "primeiro me diz o preço" o "primeiro" é ADVÉRBIO, não escolha — e
// casar isso agendaria o horário 0 em cima de quem só queria informação. Por
// isso exigimos um sinal de escolha junto do ordinal:
//   a) determinante antes — "o/esse/este/aquele primeiro"; ou
//   b) substantivo depois — "primeiro horário", "primeira opção"; ou
//   c) o ordinal sozinho, ancorado, como a mensagem inteira — "o primeiro".
const ordinalRe = (n: 1 | 2) => {
  const word = n === 1 ? String.raw`primeir[oa]` : String.raw`segund[oa]`;
  const num = n === 1 ? String.raw`1[ªº]|1a\b` : String.raw`2[ªº]|2a\b`;
  const noun = String.raw`(?:hor[áa]rio|op[cç][ãa]o|vaga|hora)`;
  const det = String.raw`(?:o|a|os|as|esse|essa|este|esta|aquele|aquela)`;
  return new RegExp(
    // "o primeiro" / "primeiro" — o ordinal é a mensagem INTEIRA. Ancorado no
    // fim de propósito: sem isso "primeiro preciso saber o valor" (advérbio)
    // casava e agendava o horário 0 em cima de quem só queria informação.
    String.raw`(?:^\s*(?:${det}\s+)?${word}\s*[.!?]*$)` +
      String.raw`|(?:\b${det}\s+${word}\b)` + // "quero ESSE PRIMEIRO ..."
      String.raw`|(?:\b${word}\s+${noun}\b)` + // "... PRIMEIRO HORÁRIO"
      String.raw`|(?:${num})|(?:op[cç][ãa]o\s*${n})`,
    "i",
  );
};
const FIRST_ORDINAL_RE = ordinalRe(1);
const SECOND_ORDINAL_RE = ordinalRe(2);

export function isSlotAcceptanceMessage(text: string): boolean {
  const t = text.trim().toLowerCase();
  // Recusa ("nenhum dos 2") ou indisponibilidade ("só largo às 18:00") NUNCA é
  // aceite de horário, mesmo contendo um padrão HH:MM — sem este guard o
  // fallback de horário solto (normalizeTimeLabel, no fim da função) lia
  // qualquer hora mencionada como se fosse a escolha do lead. Caso real
  // (Clínica Bomfim 09/07): o lead recusou os dois horários ofertados e disse
  // "Só largo as 18:00" — o sistema entendeu como aceite e agendou.
  if (looksLikeDecline(text) || mentionsUnavailability(t)) return false;
  if (
    new RegExp(
      String.raw`^(pode ser|sim|ok|blz|beleza|confirmo|confirmado|esse|essa|este|esta|perfeito|funciona|pode|vamos|top|fechado|combinado|fica\s+(?:sim|bom|[óo]timo|perfeito|certo|excelente)|serve)(?:\s+(?:as?|às|o|a|no|na|em)\s+${TIME_IN_TEXT_SRC})?[!.?\s]*$`,
      "i",
    ).test(t)
  ) {
    return true;
  }
  // Aceite FORTE abrindo a mensagem, com texto extra depois: "Confirmado.
  // Moro no viena (justinópolis), então é próximo daqui. Obg". O ramo acima
  // exige que a mensagem seja SÓ a palavra de aceite, então esse caso — muito
  // comum, o lead confirma e emenda um comentário — não era reconhecido e o
  // slot nunca era selecionado. Caso real (Implanto Master Venda Nova, Jose
  // Francisco 31 99757-0449, 11/08): 1 único horário ofertado, o lead
  // respondeu "Confirmado …" e o agente se despediu sem criar o agendamento.
  // Só vale para palavras INEQUÍVOCAS de fechamento (não "pode"/"vamos", que
  // aparecem em pergunta) e no INÍCIO da mensagem. Recusa e indisponibilidade
  // já foram barradas no topo da função.
  if (/^(confirmad[oa]|confirmo|confirmar|fechado|combinado|isso mesmo|pode confirmar|pode marcar|pode agendar)\b/i.test(t)) {
    return true;
  }
  if (FIRST_ORDINAL_RE.test(t)) return true;
  if (SECOND_ORDINAL_RE.test(t)) return true;
  if (
    TIME_IN_TEXT_RE.test(t) &&
    // "se for possível" / "por favor" são PEDIDOS educados acompanhando o
    // horário escolhido ("Às 10, horas Se for possível") — aceite, não recusa.
    // A forma condicional é exigida de propósito: "não é possível" continua
    // fora, e "impossível" já é barrado por mentionsUnavailability acima.
    /(pode ser|sim|ok|confirmo|esse|essa|este|esta|funciona|prefiro|quero|otimo|ótimo|t[aá] otimo|t[aá] ótimo|legal|bom|maravilha|certo|fechado|perfeito|marcar|agendar|se\s+for\s+poss[íi]vel|se\s+poss[íi]vel|por\s+favor|por\s+gentileza)/i.test(
      t,
    )
  ) {
    return true;
  }
  if (
    TIME_IN_TEXT_RE.test(t) &&
    /(segunda|ter[cç]a|quarta|quinta|sexta|s[aá]bado|domingo)/i.test(t)
  ) {
    return true;
  }
  // Fallback final: a mensagem é SÓ um horário (ex.: "18:20", "às 18:20", "9h"),
  // sem texto adicional. Texto extra ao redor do horário (ex.: "Só largo às
  // 18:00" — uma RESTRIÇÃO, não uma escolha) não deve cair aqui. Caso real
  // (Clínica Bomfim, 09/07): "Só largo as 18:00" tinha "18:00" mas era recusa
  // dos horários ofertados, não aceite — o fallback antigo lia qualquer HH:MM
  // solto na frase como escolha.
  return ONLY_TIME_RE.test(t);
}

/**
 * Quando o lead aceita um horário ("Pode ser", "Sim", "14:40"), grava
 * selected_slot_iso a partir de offered_slots — evita reservar slot antigo/errado.
 */
// Emoji de APONTAR: ☝ (com/sem variation selector e tom de pele), 👆, ⬆, 🔝.
const PONTEIRO_RE = /[☝⬆]️?[\u{1F3FB}-\u{1F3FF}]?|\u{1F446}[\u{1F3FB}-\u{1F3FF}]?|\u{1F51D}/gu;
// Palavras que, ao lado do emoji, não acrescentam informação de escolha.
// "primeiro"/"segundo" NÃO entram: são ordinais e têm caminho próprio.
const PONTEIRO_FILLER = new Set([
  "esse", "essa", "este", "esta", "isso", "aquele", "aquela",
  "o", "a", "os", "as", "esses", "essas", "sim", "ok", "eh", "e",
]);

/**
 * A mensagem é APENAS um gesto de apontar ("☝🏼", "👆👆", "esse ☝🏼").
 *
 * O gesto é AMBÍGUO por natureza — tem pelo menos duas leituras:
 *   a) "a opção acima" (o horário que o agente ofereceu), ou
 *   b) "o que EU disse acima" (a própria mensagem anterior do lead).
 *
 * Caso real (Odonto Carioca Campo Grande, 21 97558-2703, 03/08): o lead pediu
 * "amanhã às 09:15", ouviu que não tinha, e respondeu "👆👆" querendo dizer
 * "eu pedi AMANHÃ". A IA leu como (a), travou quinta 06/08 09:00 e seguiu para
 * o nome — o lead passou as mensagens seguintes tentando corrigir.
 *
 * Por isso o gesto NUNCA seleciona sozinho: quem responde é a pergunta fechada
 * de pointingConfirmationReply().
 */
export function isPointingGesture(text: string): boolean {
  const raw = (text ?? "").trim();
  if (!raw) return false;
  PONTEIRO_RE.lastIndex = 0;
  if (!PONTEIRO_RE.test(raw)) {
    PONTEIRO_RE.lastIndex = 0;
    return false;
  }
  PONTEIRO_RE.lastIndex = 0;
  const resto = raw
    .replace(PONTEIRO_RE, " ")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  PONTEIRO_RE.lastIndex = 0;
  return resto.every((w) => PONTEIRO_FILLER.has(w));
}

/**
 * Pergunta FECHADA para o gesto de apontar. Nomeia o(s) horário(s) que o agente
 * acabou de falar e devolve a decisão ao lead — que é a única fonte confiável
 * do que ele quis dizer. Com um horário vira confirmação ("você quer X?"), com
 * vários vira escolha ("você quer X ou Y?").
 *
 * Isso resolve as DUAS leituras do gesto: se ele apontava para a oferta, um
 * "sim" fecha; se apontava para o próprio pedido, ele corrige aqui — em vez de
 * descobrir depois que foi agendado no dia errado.
 *
 * Retorna null quando não há horário para nomear (o fluxo normal segue).
 */
export function pointingConfirmationReply(spokenSlots: OfferedSlot[]): string | null {
  const opcoes = spokenSlots.slice(0, 3);
  if (opcoes.length === 0) return null;
  const rotulos = opcoes.map((s) => `${s.date_label} às ${s.time_label}`);
  if (rotulos.length === 1) {
    return `Só pra eu não marcar errado 😊 você quer confirmar ${rotulos[0]}?`;
  }
  const ultimo = rotulos.pop()!;
  return `Só pra eu não marcar errado 😊 você quer ${rotulos.join(", ")} ou ${ultimo}?`;
}

export function tryAutoSelectOfferedSlot(
  stage: string,
  leadData: LeadData,
  history: { role: "user" | "assistant"; content: string }[],
): Partial<LeadData> {
  if (stage !== "SLOT_OFFER" && stage !== "NAME_COLLECT" && stage !== "BOOKING") return {};

  const slots = leadData.offered_slots ?? [];
  if (slots.length === 0) return {};

  const lastUserIdx = lastUserIndex(history);
  if (lastUserIdx < 0) return {};

  const lastUser = history[lastUserIdx]!.content.trim();
  if (!lastUser) return {};

  // GUARD: o lead pediu uma DATA que NÃO está entre os slots ofertados. Ele
  // está tentando MUDAR de dia — não finalize nenhum slot (nem por turno).
  if (leadRequestedUnofferedDate(leadData, history)) return {};

  const assistantText = recentAssistantContext(history, lastUserIdx);
  const lastTurnText = lastAssistantTurnText(history, lastUserIdx);

  const prefPatch = pickSlotByPreference(slots, lastUser, assistantText, lastTurnText);
  if (prefPatch) return prefPatch;

  // GESTO DE APONTAR ("☝🏼", "👆👆"): NUNCA escolhe sozinho, nem quando só um
  // horário foi ofertado. O gesto pode apontar para a oferta OU para o pedido
  // anterior do próprio lead (ver isPointingGesture) — e agendar no dia errado
  // é o erro mais caro nesta base. Quem responde é o guard de confirmação no
  // orquestrador, com pergunta fechada.
  if (isPointingGesture(lastUser)) return {};

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
    // O lead digitou um horário EXPLÍCITO (ex.: "10:00") que não bate com
    // NENHUM slot em offered_slots (ou continua ambíguo entre vários). NÃO cai
    // nos fallbacks abaixo — mentionedInAssistant, em particular, ignora o
    // horário pedido e casa QUALQUER slot atual que a última mensagem do
    // assistente tenha mencionado, podendo "confirmar" um horário TOTALMENTE
    // DIFERENTE do que o lead pediu. Caso real (MF Beauty BSB): listar_horarios
    // foi chamado 3x no mesmo turn, offered_slots final não tinha mais o
    // "10:00" que o agente tinha acabado de oferecer (resultado de uma chamada
    // anterior, já stale) — só "13:30" sobreviveu — e o lead respondendo
    // "10:00" acabou agendado às 13:30 sem nunca ter pedido esse horário.
    return {};
  }

  // Ordinal ("o primeiro", "a 2ª opção") se refere à ordem em que o AGENTE
  // falou os horários, não à ordem de offered_slots (que traz até 6 vagas da
  // agenda, das quais o agente só citou 2). Ver slotsOfferedInLastTurn.
  const spoken = slotsOfferedInLastTurn(leadData, history);
  const ordinalPool = spoken.length > 0 ? spoken : slots;
  if (FIRST_ORDINAL_RE.test(lastUser.toLowerCase()) && ordinalPool[0]) {
    return patchFromSlot(ordinalPool[0]);
  }
  if (SECOND_ORDINAL_RE.test(lastUser.toLowerCase()) && ordinalPool[1]) {
    return patchFromSlot(ordinalPool[1]);
  }

  // Aceite sem hora ("fica sim", "pode ser"): o lead está respondendo à
  // proposta do ÚLTIMO turno do agente. Se o agente propôs exatamente UM
  // horário ali ("...às 16:45. Fica bom?"), é ESSE — mesmo que um slot antigo
  // tenha ficado selecionado antes. Caso real (Costa Lima Recreio, Luciano
  // 32 99160-7088): "fica sim" ao 16:45 e o booking foi atrás do 13:00 velho.
  if (spoken.length === 1) {
    return patchFromSlot(spoken[0]!);
  }

  const mentionedInAssistant = slots.filter((s) => slotMentionedInText(s, assistantText));
  if (mentionedInAssistant.length === 1) {
    return patchFromSlot(mentionedInAssistant[0]!);
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

  const missing = getMissingBookingFields(fields, leadData);
  if (missing.length === 0) return {};

  // CPF: se o assistente perguntou por um campo de CPF, só captura um CPF válido
  // (11 dígitos, não todos iguais). Fica ANTES dos guards de telefone/horário
  // porque um CPF de 11 dígitos passaria por looksLikePhoneNumber. Resposta que
  // não é CPF (ex.: "9h") não é capturada — o campo segue pendente.
  const cpfQuestionField = matchFieldFromAssistantQuestion(assistantText, missing);
  if (cpfQuestionField && isCpfField(cpfQuestionField)) {
    return isValidCpf(lastUser)
      ? { custom_fields: { [cpfQuestionField.key]: formatCpf(lastUser) } }
      : {};
  }

  if (isSlotAcceptanceMessage(lastUser)) return {};
  if (looksLikeSchedulingPreference(lastUser)) return {};
  if (looksLikePhoneNumber(lastUser)) return {};

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
    return { name: mergePartialName(leadData.name, lastUser, field) };
  }

  // Campos de nome (crianca / responsaveis) exigem que o conteudo
  // pareca nome de pessoa — nao texto livre.
  if (isChildNameField(field) || isGuardiansField(field)) {
    if (!looksLikePersonName(lastUser)) return {};
    return {
      custom_fields: {
        [field.key]: mergePartialName(leadData.custom_fields?.[field.key], lastUser, field),
      },
    };
  }

  return {
    custom_fields: {
      [field.key]: lastUser,
    },
  };
}

/**
 * O lead respondeu o primeiro nome ("Ana") e, quando pedimos o sobrenome,
 * respondeu só "Souza". Sem juntar, a captura sobrescreveria "Ana" por "Souza",
 * o campo continuaria sem sobrenome e o agente perguntaria PARA SEMPRE — o
 * mesmo loop do nome rejeitado (21 97859-4196). Só junta quando o valor guardado
 * ainda está incompleto e a nova resposta não repete o que já temos.
 */
export function mergePartialName(
  existing: string | null | undefined,
  answer: string,
  field?: BookingFieldDef,
): string {
  const prev = (existing ?? "").trim();
  const next = answer.trim();
  if (!prev) return next;
  if (field && !requiresFullName(field)) return next;
  // Já estava completo, ou o lead repetiu o nome inteiro → a resposta nova manda.
  if (hasSurname(prev) || hasSurname(next)) return next;
  const p = stripAccentsLower(prev);
  const n = stripAccentsLower(next);
  if (p === n || n.includes(p) || p.includes(n)) return next;
  return `${prev} ${next}`;
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
