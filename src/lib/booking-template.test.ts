// Testes unitarios dos classificadores e do fluxo de captura de campos de
// booking. Sao funcoes puras — protegem o codebase de regressoes silenciosas
// (ex: M1 do lead virando nome de crianca, "25/07/2019" sendo classificada
// como preferencia de horario, etc.).
//
// Rode com: `npm test`

import { describe, expect, it } from "vitest";

import {
  backfillBookingFieldsFromHistory,
  clearBookingFields,
  getMissingBookingFields,
  isReadyForBooking,
  isSlotAcceptanceMessage,
  looksLikeBirthDate,
  looksLikeIntentMessage,
  looksLikeSchedulingPreference,
  preflightBookingFields,
  sanitizeLeadDataPatch,
  type BookingFieldDef,
} from "./booking-template";
import type { LeadData } from "./agents/stage";

const SCHOOL_FIELDS: BookingFieldDef[] = [
  {
    key: "child_name",
    label: "Nome da criança",
    question: "Qual o nome completo da criança?",
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
    question: "Qual o nome completo dos responsáveis?",
    required: true,
  },
];

const SCHOOL_SETTINGS = {
  booking_fields_json: JSON.stringify(SCHOOL_FIELDS),
};

// ── looksLikeBirthDate ────────────────────────────────────────────────────

describe("looksLikeBirthDate", () => {
  it.each([
    ["25/07/2019", true],
    ["1/1/2020", true],
    ["25-07-2019", true],
    ["25.07.2019", true],
    ["25 de julho de 2019", true],
    ["Helena", false],
    ["sim", false],
    ["manhã", false],
    ["", false],
    ["25/07", false], // sem ano nao e considerado birth date completo
    ["telefone 32991607088", false],
  ])("looksLikeBirthDate(%j) → %s", (input, expected) => {
    expect(looksLikeBirthDate(input)).toBe(expected);
  });
});

// ── looksLikeSchedulingPreference (regressao do bug 25/07/2019) ───────────

describe("looksLikeSchedulingPreference", () => {
  it("aceita preferencias claras", () => {
    expect(looksLikeSchedulingPreference("manhã")).toBe(true);
    expect(looksLikeSchedulingPreference("de manhã")).toBe(true);
    expect(looksLikeSchedulingPreference("segunda de manhã")).toBe(true);
    expect(looksLikeSchedulingPreference("tarde")).toBe(true);
  });

  it("NAO classifica data de nascimento como preferencia (bug 27/05)", () => {
    expect(looksLikeSchedulingPreference("25/07/2019")).toBe(false);
    expect(looksLikeSchedulingPreference("01/01/2020")).toBe(false);
    expect(looksLikeSchedulingPreference("25-07-2019")).toBe(false);
  });

  it("NAO classifica horarios HH:MM como preferencia", () => {
    expect(looksLikeSchedulingPreference("11:20")).toBe(false);
    expect(looksLikeSchedulingPreference("3:20pm")).toBe(false);
  });

  it("NAO classifica nomes como preferencia", () => {
    expect(looksLikeSchedulingPreference("Helena Silva")).toBe(false);
    expect(looksLikeSchedulingPreference("Luciano")).toBe(false);
  });
});

// ── looksLikeIntentMessage (regressao do bug "Olá gostaria...") ───────────

describe("looksLikeIntentMessage", () => {
  it("detecta saudacoes e mensagens de intencao", () => {
    expect(looksLikeIntentMessage("Olá gostaria de mais informações sobre a escola")).toBe(true);
    expect(looksLikeIntentMessage("Oi, tudo bem?")).toBe(true);
    expect(looksLikeIntentMessage("Bom dia")).toBe(true);
    expect(looksLikeIntentMessage("Quero saber sobre as mensalidades")).toBe(true);
    expect(looksLikeIntentMessage("Tenho interesse em matricular meu filho")).toBe(true);
    expect(looksLikeIntentMessage("Como faço para agendar?")).toBe(true);
  });

  it("NAO classifica nomes de pessoa como intent", () => {
    expect(looksLikeIntentMessage("Helena Silva")).toBe(false);
    expect(looksLikeIntentMessage("Luciano")).toBe(false);
    expect(looksLikeIntentMessage("Maria José")).toBe(false);
  });

  it("NAO classifica datas/numeros como intent", () => {
    expect(looksLikeIntentMessage("25/07/2019")).toBe(false);
    expect(looksLikeIntentMessage("11:20")).toBe(false);
  });
});

// ── sanitizeLeadDataPatch (defesa em profundidade) ────────────────────────

describe("sanitizeLeadDataPatch", () => {
  it("remove intent message gravada como child_name pelo LLM", () => {
    const patch = {
      custom_fields: {
        child_name: "Olá gostaria de mais informações sobre a escola",
        child_birth_date: "25/07/2019",
      },
    };
    const out = sanitizeLeadDataPatch(patch);
    expect(out.custom_fields?.child_name).toBeUndefined();
    expect(out.custom_fields?.child_birth_date).toBe("25/07/2019");
  });

  it("remove intent message gravada como guardians", () => {
    const patch = {
      custom_fields: {
        guardians: "Olá gostaria de mais informações sobre a escola",
      },
    };
    const out = sanitizeLeadDataPatch(patch);
    expect(out.custom_fields?.guardians).toBeUndefined();
  });

  it("preserva nomes validos", () => {
    const patch = {
      custom_fields: {
        child_name: "Helena Silva",
        guardians: "Luciano e Carolina",
      },
    };
    const out = sanitizeLeadDataPatch(patch);
    expect(out.custom_fields?.child_name).toBe("Helena Silva");
    expect(out.custom_fields?.guardians).toBe("Luciano e Carolina");
  });

  it("rejeita preferencia de horario gravada como child_name", () => {
    const patch = { custom_fields: { child_name: "manhã" } };
    const out = sanitizeLeadDataPatch(patch);
    expect(out.custom_fields?.child_name).toBeUndefined();
  });

  it("permite data de nascimento valida em child_birth_date", () => {
    const patch = { custom_fields: { child_birth_date: "25/07/2019" } };
    const out = sanitizeLeadDataPatch(patch);
    expect(out.custom_fields?.child_birth_date).toBe("25/07/2019");
  });
});

// ── getMissingBookingFields (regressao final pre-booking) ─────────────────

describe("getMissingBookingFields", () => {
  it("retorna todos quando lead_data vazio", () => {
    const missing = getMissingBookingFields(SCHOOL_FIELDS, {});
    expect(missing.map((f) => f.key)).toEqual([
      "child_name",
      "child_birth_date",
      "guardians",
    ]);
  });

  it("considera campo de nome com intent message como MISSING", () => {
    const ld: LeadData = {
      custom_fields: {
        child_name: "Olá gostaria de mais informações sobre a escola",
        child_birth_date: "25/07/2019",
        guardians: "Luciano e Carolina",
      },
    };
    const missing = getMissingBookingFields(SCHOOL_FIELDS, ld);
    expect(missing.map((f) => f.key)).toEqual(["child_name"]);
  });

  it("retorna vazio quando tudo preenchido com valores validos", () => {
    const ld: LeadData = {
      custom_fields: {
        child_name: "Helena Silva",
        child_birth_date: "25/07/2019",
        guardians: "Luciano e Carolina",
      },
    };
    expect(getMissingBookingFields(SCHOOL_FIELDS, ld)).toEqual([]);
  });
});

// ── isReadyForBooking ─────────────────────────────────────────────────────

describe("isReadyForBooking", () => {
  const baseLD: LeadData = {
    name: "Luciano",
    selected_slot_iso: "2026-06-03T18:20:00.000Z",
    custom_fields: {
      child_name: "Helena Silva",
      child_birth_date: "25/07/2019",
      guardians: "Luciano e Carolina",
    },
  };

  it("true quando tudo preenchido + slot + telefone + integracao", () => {
    expect(
      isReadyForBooking(baseLD, SCHOOL_SETTINGS, {
        hasPhone: true,
        hasBookingIntegration: true,
        channel: "whatsapp",
        effectivePhone: "5532991607088",
      }),
    ).toBe(true);
  });

  it("false quando child_name esta com intent message", () => {
    const ld: LeadData = {
      ...baseLD,
      custom_fields: {
        ...(baseLD.custom_fields ?? {}),
        child_name: "Olá gostaria de mais informações sobre a escola",
      },
    };
    expect(
      isReadyForBooking(ld, SCHOOL_SETTINGS, {
        hasPhone: true,
        hasBookingIntegration: true,
        channel: "whatsapp",
        effectivePhone: "5532991607088",
      }),
    ).toBe(false);
  });

  it("false sem slot escolhido", () => {
    const ld: LeadData = { ...baseLD, selected_slot_iso: undefined };
    expect(
      isReadyForBooking(ld, SCHOOL_SETTINGS, {
        hasPhone: true,
        hasBookingIntegration: true,
        channel: "whatsapp",
        effectivePhone: "5532991607088",
      }),
    ).toBe(false);
  });
});

// ── isSlotAcceptanceMessage ───────────────────────────────────────────────

describe("isSlotAcceptanceMessage", () => {
  it.each([
    ["Pode ser as 11:20", true],
    ["11:20", true],
    ["sim", true],
    ["pode ser", true],
    ["quero 14:00 de quarta", true],
    ["Olá gostaria de mais informações sobre a escola", false],
    ["Helena Silva", false],
    ["25/07/2019", false],
  ])("isSlotAcceptanceMessage(%j) → %s", (input, expected) => {
    expect(isSlotAcceptanceMessage(input)).toBe(expected);
  });
});

// ── backfillBookingFieldsFromHistory (cenarios criticos) ──────────────────

describe("backfillBookingFieldsFromHistory", () => {
  it("NAO captura M1 como child_name (bug 27/05/2026)", () => {
    const history = [
      { role: "user" as const, content: "Olá gostaria de mais informações sobre a escola" },
      { role: "assistant" as const, content: "Oi! Que ótimo seu interesse. Como prefere que eu te chame?" },
      { role: "user" as const, content: "Luciano" },
    ];
    const patch = backfillBookingFieldsFromHistory({}, history, SCHOOL_SETTINGS);
    // Nao pode ter gravado "Olá gostaria..." em lugar nenhum
    const v = JSON.stringify(patch);
    expect(v.toLowerCase()).not.toContain("gostaria");
    expect(v.toLowerCase()).not.toContain("informações");
  });

  it("captura corretamente respostas DEPOIS de pergunta especifica do assistente", () => {
    const history = [
      { role: "user" as const, content: "Olá gostaria de informações" },
      { role: "assistant" as const, content: "Como você se chama?" },
      { role: "user" as const, content: "Luciano" },
      { role: "assistant" as const, content: "Qual o nome completo da criança?" },
      { role: "user" as const, content: "Helena Silva" },
      { role: "assistant" as const, content: "E qual é a data de nascimento dela?" },
      { role: "user" as const, content: "25/07/2019" },
      { role: "assistant" as const, content: "Qual o nome completo dos responsáveis?" },
      { role: "user" as const, content: "Luciano e Carolina" },
    ];
    const patch = backfillBookingFieldsFromHistory({}, history, SCHOOL_SETTINGS);
    expect(patch.custom_fields?.child_name).toBe("Helena Silva");
    expect(patch.custom_fields?.child_birth_date).toBe("25/07/2019");
    expect(patch.custom_fields?.guardians).toBe("Luciano e Carolina");
  });

  it("ignora historico vazio", () => {
    expect(backfillBookingFieldsFromHistory({}, [], SCHOOL_SETTINGS)).toEqual({});
  });

  it("ignora historico sem nenhuma pergunta de campo", () => {
    const history = [
      { role: "user" as const, content: "Olá" },
      { role: "assistant" as const, content: "Oi, como posso ajudar?" },
      { role: "user" as const, content: "Quero matricular" },
    ];
    const patch = backfillBookingFieldsFromHistory({}, history, SCHOOL_SETTINGS);
    expect(patch).toEqual({});
  });

  it("captura data de nascimento mesmo quando assistente perguntou nome (regressao)", () => {
    // Caso: assistente perguntou child_name mas user enviou direto a data.
    // Formato de data e inequivoco — deve gravar em child_birth_date.
    const history = [
      { role: "assistant" as const, content: "Qual o nome completo da criança?" },
      { role: "user" as const, content: "25/07/2019" },
    ];
    const patch = backfillBookingFieldsFromHistory({}, history, SCHOOL_SETTINGS);
    expect(patch.custom_fields?.child_birth_date).toBe("25/07/2019");
    expect(patch.custom_fields?.child_name).toBeUndefined();
  });
});

// ── preflightBookingFields (ultima barreira pre-criar_agendamento) ────────

describe("preflightBookingFields", () => {
  it("ok=true quando todos campos validos", () => {
    const ld: LeadData = {
      custom_fields: {
        child_name: "Helena Silva",
        child_birth_date: "25/07/2019",
        guardians: "Luciano e Carolina",
      },
    };
    const res = preflightBookingFields(SCHOOL_FIELDS, ld);
    expect(res.ok).toBe(true);
    expect(res.issues).toEqual([]);
  });

  it("detecta intent message gravada como child_name", () => {
    const ld: LeadData = {
      custom_fields: {
        child_name: "Olá gostaria de mais informações sobre a escola",
        child_birth_date: "25/07/2019",
        guardians: "Luciano e Carolina",
      },
    };
    const res = preflightBookingFields(SCHOOL_FIELDS, ld);
    expect(res.ok).toBe(false);
    expect(res.issues).toEqual([
      expect.objectContaining({
        key: "child_name",
        reason: "intent_message_in_name",
      }),
    ]);
  });

  it("detecta preferencia de horario gravada como nome", () => {
    const ld: LeadData = {
      custom_fields: {
        child_name: "manhã",
        child_birth_date: "25/07/2019",
        guardians: "Luciano e Carolina",
      },
    };
    const res = preflightBookingFields(SCHOOL_FIELDS, ld);
    expect(res.ok).toBe(false);
    expect(res.issues[0]?.reason).toBe("scheduling_text_in_name");
  });

  it("detecta frase muito longa como nome", () => {
    const ld: LeadData = {
      custom_fields: {
        child_name: "Marcos Andre Joaquim Pedro Felipe Lucas Caio",
        child_birth_date: "25/07/2019",
        guardians: "Luciano",
      },
    };
    const res = preflightBookingFields(SCHOOL_FIELDS, ld);
    expect(res.ok).toBe(false);
    expect(res.issues[0]?.reason).toBe("too_many_words_in_name");
  });

  it("detecta texto nao-data em campo de data", () => {
    const ld: LeadData = {
      custom_fields: {
        child_name: "Helena Silva",
        child_birth_date: "amanhã",
        guardians: "Luciano",
      },
    };
    const res = preflightBookingFields(SCHOOL_FIELDS, ld);
    expect(res.ok).toBe(false);
    expect(res.issues[0]).toEqual(
      expect.objectContaining({ key: "child_birth_date", reason: "not_a_date" }),
    );
  });

  it("ignora campos opcionais nao preenchidos", () => {
    const optionalField: BookingFieldDef = {
      key: "observation",
      label: "Observação",
      question: "Algo a observar?",
      required: false,
    };
    const ld: LeadData = {
      custom_fields: {
        child_name: "Helena Silva",
        child_birth_date: "25/07/2019",
        guardians: "Luciano",
      },
    };
    const res = preflightBookingFields([...SCHOOL_FIELDS, optionalField], ld);
    expect(res.ok).toBe(true);
  });
});

describe("clearBookingFields", () => {
  it("remove chaves suspeitas de custom_fields", () => {
    const ld: LeadData = {
      custom_fields: {
        child_name: "Olá gostaria...",
        child_birth_date: "25/07/2019",
        guardians: "Luciano",
      },
    };
    const cleaned = clearBookingFields(ld, [SCHOOL_FIELDS[0]!]);
    expect(cleaned.custom_fields?.child_name).toBeUndefined();
    expect(cleaned.custom_fields?.child_birth_date).toBe("25/07/2019");
    expect(cleaned.custom_fields?.guardians).toBe("Luciano");
  });

  it("remove lead_data.name quando field eh maps_to=name", () => {
    const nameField: BookingFieldDef = {
      key: "lead_name",
      label: "Nome",
      question: "Como te chamo?",
      required: true,
      maps_to: "name",
    };
    const ld: LeadData = {
      name: "Olá gostaria de informações",
      custom_fields: { child_name: "Helena" },
    };
    const cleaned = clearBookingFields(ld, [nameField]);
    expect(cleaned.name).toBeUndefined();
    expect(cleaned.custom_fields?.child_name).toBe("Helena");
  });

  it("e idempotente quando lista vazia", () => {
    const ld: LeadData = { custom_fields: { child_name: "Helena" } };
    expect(clearBookingFields(ld, [])).toEqual(ld);
  });
});
