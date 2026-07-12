// Testes unitarios dos classificadores e do fluxo de captura de campos de
// booking. Sao funcoes puras — protegem o codebase de regressoes silenciosas
// (ex: M1 do lead virando nome de crianca, "25/07/2019" sendo classificada
// como preferencia de horario, etc.).
//
// Rode com: `npm test`

import { describe, expect, it } from "vitest";

import {
  agentUsesTurmaClassifier,
  backfillBookingFieldsFromHistory,
  buildTemplateVars,
  classifyMapleBearTurma,
  clearBookingFields,
  clearRejectedBookingName,
  formatCpf,
  getMissingBookingFields,
  mentionsUnavailability,
  relativeDateIsExplanatory,
  requestedDateFromText,
  tryAutoSelectOfferedSlot,
  isReadyForBooking,
  isSlotAcceptanceMessage,
  isValidCpf,
  looksLikeBirthDate,
  looksLikeDecline,
  looksLikeIntentMessage,
  looksLikeSchedulingPreference,
  preflightBookingFields,
  renderBookingTemplate,
  resolveCollectedPhone,
  turmaTagForLead,
  sanitizeLeadDataPatch,
  tagGateMissingField,
  type BookingFieldDef,
} from "./booking-template";
import type { AgentContext } from "./agents/context";
import { normalizeBrazilPhone } from "./conversation-channel.server";
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
    ["2025-06-20", true], // ISO — regressao caso real 08/07 (Maple Bear Osasco)
    ["2025-03-20", true],
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

  it("detecta saudacao/ack curto 'tudo bem' (nao e nome) — regressao 21 97486-6018", () => {
    expect(looksLikeIntentMessage("Tudo bem")).toBe(true);
    expect(looksLikeIntentMessage("tudo bom")).toBe(true);
    expect(looksLikeIntentMessage("Tudo certo")).toBe(true);
    // nome real continua nao sendo intent
    expect(looksLikeIntentMessage("Ana Lucia Valentim do Nascimento")).toBe(false);
  });
});

// ── clearRejectedBookingName (destrava NAME_COLLECT em loop) ──────────────

describe("clearRejectedBookingName", () => {
  it("limpa o campo name quando preenchido (caso 'Tudo bem' preso)", () => {
    expect(clearRejectedBookingName({ name: "Tudo bem" })).toEqual({ name: undefined });
  });

  it("limpa guardians quando o nome veio de guardians", () => {
    const out = clearRejectedBookingName({ custom_fields: { guardians: "Obrigado" } });
    expect(out.custom_fields?.guardians).toBe("");
  });

  it("limpa child_name quando o nome veio de child_name", () => {
    const out = clearRejectedBookingName({ custom_fields: { child_name: "manhã" } });
    expect(out.custom_fields?.child_name).toBe("");
  });

  it("prioriza name > guardians > child_name (igual a resolveBookingLeadName)", () => {
    const out = clearRejectedBookingName({
      name: "Tudo bem",
      custom_fields: { guardians: "X", child_name: "Y" },
    });
    expect(out).toEqual({ name: undefined });
  });

  it("no-op quando nao ha nome preenchido", () => {
    expect(clearRejectedBookingName({})).toEqual({});
    expect(clearRejectedBookingName({ custom_fields: {} })).toEqual({});
  });
});

// ── Auto-seleção de slot: negação/explicação de data NÃO é escolha ────────
// Regressão do caso (11) 98945-0106: "08/07 será amanhã" (explicação de que
// não dá) auto-selecionava 08/07 09:00 e reagendava o dia recusado.

describe("mentionsUnavailability", () => {
  it("detecta negação de disponibilidade", () => {
    expect(mentionsUnavailability("eu não vou conseguir ir amanhã")).toBe(true);
    expect(mentionsUnavailability("não posso amanhã")).toBe(true);
    expect(mentionsUnavailability("amanhã não dá")).toBe(true);
    expect(mentionsUnavailability("não consigo nesse dia")).toBe(true);
    expect(mentionsUnavailability("tá impossível essa semana")).toBe(true);
  });
  it("NÃO bloqueia pedidos reais", () => {
    expect(mentionsUnavailability("pode ser amanhã")).toBe(false);
    expect(mentionsUnavailability("quero amanhã de manhã")).toBe(false);
    expect(mentionsUnavailability("prefiro dia 15")).toBe(false);
  });
});

describe("relativeDateIsExplanatory", () => {
  it("detecta data relativa afirmada como fato (não é pedido)", () => {
    expect(relativeDateIsExplanatory("08/07 será amanhã")).toBe(true);
    expect(relativeDateIsExplanatory("amanhã é feriado")).toBe(true);
    expect(relativeDateIsExplanatory("mas amanhã seria muito corrido")).toBe(true);
  });
  it("NÃO bloqueia pedidos reais com data relativa", () => {
    expect(relativeDateIsExplanatory("pode ser amanhã")).toBe(false);
    expect(relativeDateIsExplanatory("quero amanhã de manhã")).toBe(false);
    expect(relativeDateIsExplanatory("prefiro amanhã à tarde")).toBe(false);
  });
});

describe("tryAutoSelectOfferedSlot — negação/explicação não seleciona", () => {
  const slots08 = [
    { iso: "2026-07-08T09:00:00-03:00", date_label: "quarta-feira, 08/07", time_label: "09:00" },
    { iso: "2026-07-08T14:00:00-03:00", date_label: "quarta-feira, 08/07", time_label: "14:00" },
  ];

  it("'08/07 será amanhã' NÃO auto-seleciona 08/07 09:00 (caso 11 98945-0106)", () => {
    const patch = tryAutoSelectOfferedSlot(
      "SLOT_OFFER",
      { offered_slots: slots08 },
      [{ role: "user", content: "08/07 será amanhã" }],
    );
    expect(patch).toEqual({});
  });

  it("'não vou conseguir ir amanhã' NÃO auto-seleciona", () => {
    const patch = tryAutoSelectOfferedSlot(
      "SLOT_OFFER",
      { offered_slots: slots08 },
      [{ role: "user", content: "eu não vou conseguir ir amanhã" }],
    );
    expect(patch).toEqual({});
  });

  // Caso real (Clínica Bomfim, 10/07, leads Michele e Sandro): o agente
  // ofertou horários numa data (ex.: segunda) e o lead pediu um DIA DA SEMANA
  // diferente + turno (ex.: "terça-feira... à tarde"). relativeTargetDateBrt
  // não reconhecia nomes de dia da semana — só "amanhã"/"hoje" — então
  // targetDate ficava null e o filtro de turno escolhia silenciosamente um
  // slot do dia ERRADO (o único disponível em offered_slots) como se fosse o
  // pedido do lead. Os dois foram agendados no dia que recusaram, sem nunca
  // terem confirmado isso.
  it("lead pede um dia da semana diferente do ofertado + turno → não cai num slot do dia errado", () => {
    function weekdayNameBrt(d: Date): string {
      return new Intl.DateTimeFormat("pt-BR", {
        weekday: "long",
        timeZone: "America/Sao_Paulo",
      })
        .format(d)
        .replace("-feira", "");
    }
    const now = Date.now();
    const DAY = 86_400_000;
    const tomorrow = new Date(now + DAY);
    const offeredWeekday = weekdayNameBrt(tomorrow);
    const isoDate = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(
      tomorrow,
    );
    const offeredSlots = [
      { iso: `${isoDate}T13:00:00-03:00`, date_label: `${offeredWeekday}, 00/00`, time_label: "13:00" },
      { iso: `${isoDate}T14:30:00-03:00`, date_label: `${offeredWeekday}, 00/00`, time_label: "14:30" },
    ];
    let otherWeekdayName = "";
    for (let i = 2; i <= 8; i++) {
      const candidate = weekdayNameBrt(new Date(now + i * DAY));
      if (candidate !== offeredWeekday) {
        otherWeekdayName = candidate;
        break;
      }
    }
    expect(otherWeekdayName).not.toBe("");

    const patch = tryAutoSelectOfferedSlot(
      "SLOT_OFFER",
      { offered_slots: offeredSlots },
      [
        {
          role: "assistant",
          content: `Tenho dois horários excelentes ${offeredWeekday}: às 13h00 ou às 14h30.`,
        },
        { role: "user", content: `Deixa para ${otherWeekdayName}-feira à tarde` },
      ],
    );
    expect(patch).toEqual({});
  });

  // Caso real (MF Beauty BSB, 10/07): listar_horarios foi chamado 3x no mesmo
  // turn e o offered_slots FINAL persistido não tinha mais o "10:00" que o
  // agente acabou de oferecer ao lead (resultado de uma chamada anterior, já
  // stale) — só "13:30" sobreviveu. O lead respondeu "10:00" (horário que
  // literalmente NÃO existe em offered_slots) e o fallback mentionedInAssistant
  // (que ignora o horário pedido e casa qualquer slot atual mencionado na
  // última msg do assistente) "confirmava" 13:30 — o lead nunca pediu esse
  // horário e foi agendado nele mesmo assim.
  it("horário explícito que NÃO bate com offered_slots não deve cair no fallback mentionedInAssistant", () => {
    const staleOfferSlots = [
      { iso: "2026-07-11T12:00:00-03:00", date_label: "sábado, 11/07", time_label: "12:00" },
      { iso: "2026-07-11T12:30:00-03:00", date_label: "sábado, 11/07", time_label: "12:30" },
      { iso: "2026-07-11T13:00:00-03:00", date_label: "sábado, 11/07", time_label: "13:00" },
      { iso: "2026-07-11T13:30:00-03:00", date_label: "sábado, 11/07", time_label: "13:30" },
      { iso: "2026-07-11T14:00:00-03:00", date_label: "sábado, 11/07", time_label: "14:00" },
      { iso: "2026-07-11T14:30:00-03:00", date_label: "sábado, 11/07", time_label: "14:30" },
    ];
    const patch = tryAutoSelectOfferedSlot(
      "SLOT_OFFER",
      { offered_slots: staleOfferSlots },
      [
        {
          role: "assistant",
          content:
            "Consegui dois horários para sua avaliação gratuita: amanhã, sábado (11/07), às 10:00 ou às 13:30. Qual fica melhor para você?",
        },
        { role: "user", content: "10:00" },
      ],
    );
    expect(patch).toEqual({});
  });
});

// ── requestedDateFromText (âncora de data pro listar_horarios) ─────────────

describe("requestedDateFromText", () => {
  function weekdayStemBrt(iso: string): string {
    return new Intl.DateTimeFormat("pt-BR", { weekday: "long", timeZone: "America/Sao_Paulo" })
      .format(new Date(`${iso}T12:00:00-03:00`))
      .replace("-feira", "")
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "");
  }

  it("reconhece dia da semana explícito (quinta-feira → próxima quinta)", () => {
    const d = requestedDateFromText("Sim. Teria para quinta-feira?");
    expect(d).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(weekdayStemBrt(d!)).toBe("quinta");
  });

  it("reconhece dia da semana sem 'feira' (terça)", () => {
    const d = requestedDateFromText("pode ser terça de manhã");
    expect(weekdayStemBrt(d!)).toBe("terca");
  });

  it("mensagem só com horário ('11h') não resolve data", () => {
    expect(requestedDateFromText("11h")).toBeNull();
    expect(requestedDateFromText("Manhã, por volta das 11h")).toBeNull();
  });

  it("negação de dia não vira pedido ('quinta não dá pra mim')", () => {
    expect(requestedDateFromText("quinta não dá pra mim")).toBeNull();
  });

  it("mensagem sem dia nenhum → null", () => {
    expect(requestedDateFromText("Sônia Mara Flauzino da Silva")).toBeNull();
    expect(requestedDateFromText("")).toBeNull();
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

  it("trata name='Tudo bem' como MISSING (regressao 21 97486-6018)", () => {
    const NAME_FIELD: BookingFieldDef[] = [
      { key: "name", label: "Nome", question: "Qual seu nome?", required: true, maps_to: "name" },
    ];
    expect(getMissingBookingFields(NAME_FIELD, { name: "Tudo bem" }).map((f) => f.key)).toEqual([
      "name",
    ]);
    // nome real preenchido → nao falta nada
    expect(
      getMissingBookingFields(NAME_FIELD, { name: "Ana Lucia Valentim do Nascimento" }),
    ).toEqual([]);
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
    // Caso real (Clínica Bomfim, 09/07): recusa/indisponibilidade com um HH:MM
    // dentro NÃO é aceite, mesmo batendo o regex de horário solto.
    ["Nenhum dos 2", false],
    ["Só largo as 18:00", false],
    ["não posso às 15:00", false],
  ])("isSlotAcceptanceMessage(%j) → %s", (input, expected) => {
    expect(isSlotAcceptanceMessage(input)).toBe(expected);
  });
});

describe("looksLikeDecline", () => {
  it.each([
    ["Não, obrigado.", true],
    ["Nenhum dos 2", true],
    ["nenhuma das duas", true],
    ["nenhum", true],
    ["nem um nem outro", true],
    ["não quero", true],
    ["sim", false],
    ["Helena Silva", false],
    ["15:00", false],
  ])("looksLikeDecline(%j) → %s", (input, expected) => {
    expect(looksLikeDecline(input)).toBe(expected);
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

// ── resolveCollectedPhone ──────────────────────────────────────────────────
// Bug "telefone ausente" (13/06/2026): o lead informava o WhatsApp na conversa
// (salvo em custom_fields), mas o agendamento ignorava e dizia "telefone
// ausente" porque o contato de teste nao tinha numero no CRM.

describe("resolveCollectedPhone", () => {
  const PHONE_FIELD: BookingFieldDef = {
    key: "whatsapp_phone",
    label: "WhatsApp",
    question: "Qual seu WhatsApp?",
    required: true,
  };

  it("acha telefone no campo de booking declarado", () => {
    const ld: LeadData = { custom_fields: { whatsapp_phone: "(32) 99160-7088" } };
    expect(resolveCollectedPhone([PHONE_FIELD], ld, normalizeBrazilPhone)).toBe(
      "32991607088",
    );
  });

  it("normaliza numero com prefixo 55", () => {
    const ld: LeadData = { custom_fields: { whatsapp_phone: "5532991607088" } };
    expect(resolveCollectedPhone([PHONE_FIELD], ld, normalizeBrazilPhone)).toBe(
      "32991607088",
    );
  });

  it("acha por chave que parece telefone mesmo sem campo declarado", () => {
    const ld: LeadData = { custom_fields: { telefone_contato: "32991607088" } };
    expect(resolveCollectedPhone([], ld, normalizeBrazilPhone)).toBe("32991607088");
  });

  it("ignora valor que nao parece telefone BR", () => {
    const ld: LeadData = { custom_fields: { whatsapp_phone: "nao tenho" } };
    expect(resolveCollectedPhone([PHONE_FIELD], ld, normalizeBrazilPhone)).toBeNull();
  });

  it("retorna null sem custom_fields", () => {
    const ld: LeadData = {};
    expect(resolveCollectedPhone([PHONE_FIELD], ld, normalizeBrazilPhone)).toBeNull();
  });

  it("nao confunde campo de nome com telefone", () => {
    const ld: LeadData = { name: "Luciano", custom_fields: { child_name: "Helena" } };
    expect(resolveCollectedPhone(SCHOOL_FIELDS, ld, normalizeBrazilPhone)).toBeNull();
  });
});

// ── classifyMapleBearTurma (determinístico) ────────────────────────────────
// Tabela 2026, corte 31/03. Tira do LLM a decisão de qual turma etiquetar.

describe("classifyMapleBearTurma (ref 2026)", () => {
  it.each([
    ["25/07/2019", "YEAR 1"], // 01/04/2019–31/03/2020
    ["15/02/2019", "YEAR 2"], // jan–mar → cohort do ano anterior (2018)
    ["10/05/2018", "YEAR 2"], // 01/04/2018–31/03/2019
    ["01/04/2020", "SK"],
    ["31/03/2021", "SK"], // ainda na janela 2020
    ["10/06/2021", "JK"],
    ["10/06/2022", "NURSERY"],
    ["10/06/2023", "TODDLER"],
    ["10/06/2024", "BEAR CARE"], // abr–out/2024
    ["15/11/2024", "FBC"], // a partir de 01/11 → futuro bear care
    ["10/01/2025", "FBC"],
    ["10/06/2017", "YEAR 3"], // não atendida em 2026, mas ainda etiqueta
    ["10/06/2008", "YEAR 12"],
    ["10/03/2008", null], // ≤ 31/03/2008 → não atende, sem tag
  ])("classifyMapleBearTurma(%s) → %s", (input, expected) => {
    expect(classifyMapleBearTurma(input, 2026)).toBe(expected);
  });

  it("aceita formato textual e com hifen", () => {
    expect(classifyMapleBearTurma("25 de julho de 2019", 2026)).toBe("YEAR 1");
    expect(classifyMapleBearTurma("25-07-2019", 2026)).toBe("YEAR 1");
  });

  it("aceita ISO (AAAA-MM-DD) com o mesmo resultado do formato BR — regressao caso real 08/07 (Maple Bear Osasco)", () => {
    expect(classifyMapleBearTurma("2019-07-25", 2026)).toBe("YEAR 1");
    expect(classifyMapleBearTurma("2025-03-20", 2026)).toBe(
      classifyMapleBearTurma("20/03/2025", 2026),
    );
  });

  it("data invalida → null", () => {
    expect(classifyMapleBearTurma("nao sei", 2026)).toBeNull();
    expect(classifyMapleBearTurma("", 2026)).toBeNull();
  });

  it("avanca de turma no ano letivo seguinte (2027)", () => {
    expect(classifyMapleBearTurma("25/07/2019", 2027)).toBe("YEAR 2"); // YEAR 1 em 2026
    expect(classifyMapleBearTurma("10/06/2021", 2027)).toBe("SK"); // JK em 2026
  });
});

describe("turmaTagForLead / agentUsesTurmaClassifier", () => {
  const TURMA_SETTINGS = {
    booking_fields_json: JSON.stringify(SCHOOL_FIELDS),
    turma_auto: "true",
  };

  it("agentUsesTurmaClassifier só com turma_auto=true", () => {
    expect(agentUsesTurmaClassifier({})).toBe(false);
    expect(agentUsesTurmaClassifier({ turma_auto: "true" })).toBe(true);
  });

  it("retorna a turma quando turma_auto ligado e ha data de nascimento", () => {
    const ld: LeadData = { custom_fields: { child_birth_date: "25/07/2019" } };
    expect(turmaTagForLead(TURMA_SETTINGS, ld)).toBe("YEAR 1");
  });

  it("sem turma_auto → null (nao afeta outros agentes)", () => {
    const ld: LeadData = { custom_fields: { child_birth_date: "25/07/2019" } };
    expect(turmaTagForLead({ booking_fields_json: JSON.stringify(SCHOOL_FIELDS) }, ld)).toBeNull();
  });

  it("respeita turma_ano_letivo configuravel", () => {
    const ld: LeadData = { custom_fields: { child_birth_date: "25/07/2019" } };
    expect(turmaTagForLead({ ...TURMA_SETTINGS, turma_ano_letivo: "2027" }, ld)).toBe("YEAR 2");
  });

  it("sem data de nascimento → null", () => {
    expect(turmaTagForLead(TURMA_SETTINGS, { custom_fields: {} })).toBeNull();
  });
});

// ── tagGateMissingField ────────────────────────────────────────────────────
// Bug "etiqueta cedo demais" (14/06/2026): o agente da escola (MB Osasco)
// etiquetava a turma antes de ter a data de nascimento. A trava
// settings.tag_gate_field bloqueia a tag ate o dado existir.

describe("tagGateMissingField", () => {
  // ── Automático (sem config): escola gateia na data de nascimento ──────────

  it("escola (auto): sem data de nascimento → trava em child_birth_date", () => {
    const ld: LeadData = { custom_fields: { child_name: "Helena" } };
    expect(tagGateMissingField(SCHOOL_SETTINGS, ld)).toBe("child_birth_date");
  });

  it("escola (auto): data de nascimento valida → libera (null)", () => {
    const ld: LeadData = { custom_fields: { child_birth_date: "25/07/2019" } };
    expect(tagGateMissingField(SCHOOL_SETTINGS, ld)).toBeNull();
  });

  it("escola (auto) via company_type → trava na data", () => {
    const settings = { company_type: "escola bilingue" };
    expect(tagGateMissingField(settings, { custom_fields: {} })).toBe("child_birth_date");
  });

  it("clinica (auto): so 'name', sem campo de data → sem trava", () => {
    const ld: LeadData = {};
    expect(tagGateMissingField({}, ld)).toBeNull();
  });

  it("campo de data ausente → retorna a chave faltante", () => {
    const settings = { tag_gate_field: "child_birth_date" };
    const ld: LeadData = { custom_fields: {} };
    expect(tagGateMissingField(settings, ld)).toBe("child_birth_date");
  });

  it("campo de data preenchido com lixo → ainda falta (exige data valida)", () => {
    const settings = { tag_gate_field: "child_birth_date" };
    const ld: LeadData = { custom_fields: { child_birth_date: "nao sei" } };
    expect(tagGateMissingField(settings, ld)).toBe("child_birth_date");
  });

  it("campo de data com data valida → libera (null)", () => {
    const settings = { tag_gate_field: "child_birth_date" };
    const ld: LeadData = { custom_fields: { child_birth_date: "25/07/2019" } };
    expect(tagGateMissingField(settings, ld)).toBeNull();
  });

  it("multiplas chaves: retorna a primeira que falta", () => {
    const settings = { tag_gate_field: "name, child_birth_date" };
    const ld: LeadData = { custom_fields: { child_birth_date: "25/07/2019" } };
    expect(tagGateMissingField(settings, ld)).toBe("name");
  });

  it("chave 'name' usa lead_data.name", () => {
    const settings = { tag_gate_field: "name" };
    expect(tagGateMissingField(settings, { name: "Luciano" })).toBeNull();
    expect(tagGateMissingField(settings, {})).toBe("name");
  });

  it("campo nao-data so exige presenca (nao valida formato)", () => {
    const settings = { tag_gate_field: "turno" };
    const ld: LeadData = { custom_fields: { turno: "manha" } };
    expect(tagGateMissingField(settings, ld)).toBeNull();
  });
});

// ── buildTemplateVars / renderBookingTemplate ──────────────────────────────
// Bug "{cpf} literal na agenda" (16/06/2026): custom_fields só eram expostos
// como {custom.cpf}; o proprietario escreveu {cpf} (igual a {child_name}) e o
// placeholder ficava literal no evento.

describe("buildTemplateVars + custom fields", () => {
  const ctx = {
    agentSettings: { company_name: "Maple Bear" },
    leadData: {
      name: "Luciano Trindade",
      custom_fields: {
        child_name: "Helena",
        child_birth_date: "25/07/2019",
        guardians: "Luciano",
        cpf: "123.456.789-00",
      },
    },
    effectivePhone: "32991607088",
    conversationPhone: "32991607088",
    helenaContact: { name: "Luciano" },
  } as unknown as AgentContext;

  it("expoe custom field como chave crua ({cpf}) e como {custom.cpf}", () => {
    const vars = buildTemplateVars(ctx);
    expect(vars["cpf"]).toBe("123.456.789-00");
    expect(vars["custom.cpf"]).toBe("123.456.789-00");
  });

  it("renderiza {cpf} no template (nao deixa literal)", () => {
    const vars = buildTemplateVars(ctx);
    const out = renderBookingTemplate("{guardians} - {cpf}", vars);
    expect(out).toBe("Luciano - 123.456.789-00");
  });

  it("nao deixa a var padrao ser sobrescrita por custom field homonimo", () => {
    const vars = buildTemplateVars(ctx);
    // child_name e var padrao — continua resolvendo normalmente
    expect(vars["child_name"]).toBe("Helena");
  });
});

// ── Validação de CPF ────────────────────────────────────────────────────────
// Bug: ao pedir CPF, o lead respondeu "9h" (era resposta de horário) e o valor
// virou CPF no cadastro. CPF exige 11 dígitos e não todos iguais — NÃO valida
// o dígito verificador oficial (leads de teste usam CPFs "genéricos" que
// falham o checksum mas são intencionais; ver comentário em isValidCpf).

const CPF_FIELDS: BookingFieldDef[] = [
  { key: "name", label: "Nome", question: "Qual seu nome?", required: true, maps_to: "name" },
  { key: "cpf", label: "CPF", question: "Qual o seu CPF?", required: true },
];

describe("isValidCpf", () => {
  it("aceita CPF valido formatado e so digitos", () => {
    expect(isValidCpf("414.087.718-96")).toBe(true);
    expect(isValidCpf("41408771896")).toBe(true);
    expect(isValidCpf("529.982.247-25")).toBe(true);
  });

  it("rejeita resposta que nao e CPF", () => {
    expect(isValidCpf("9h")).toBe(false);
    expect(isValidCpf("As 9h")).toBe(false);
    expect(isValidCpf("")).toBe(false);
    expect(isValidCpf(undefined)).toBe(false);
  });

  it("rejeita contagem de digitos errada", () => {
    expect(isValidCpf("123456789")).toBe(false); // 9 digitos
    expect(isValidCpf("4140877189")).toBe(false); // 10 digitos
    expect(isValidCpf("414087718961")).toBe(false); // 12 digitos
  });

  it("rejeita sequencias repetidas", () => {
    expect(isValidCpf("111.111.111-11")).toBe(false);
    expect(isValidCpf("00000000000")).toBe(false);
  });

  it("aceita 11 digitos mesmo com digito verificador oficial invalido", () => {
    expect(isValidCpf("414.087.718-00")).toBe(true); // DV errado, mas 11 digitos e nao repetido
    expect(isValidCpf("12345678900")).toBe(true); // CPF "generico" de teste
  });
});

describe("formatCpf", () => {
  it("normaliza 11 digitos para 000.000.000-00", () => {
    expect(formatCpf("41408771896")).toBe("414.087.718-96");
    expect(formatCpf("414.087.718-96")).toBe("414.087.718-96");
  });

  it("nao força formato quando nao ha 11 digitos", () => {
    expect(formatCpf("9h")).toBe("9h");
  });
});

describe("CPF no pipeline de booking", () => {
  it("getMissingBookingFields: CPF invalido conta como pendente", () => {
    const invalido: LeadData = { name: "Laís", custom_fields: { cpf: "9h" } };
    expect(getMissingBookingFields(CPF_FIELDS, invalido).map((f) => f.key)).toContain("cpf");

    const valido: LeadData = { name: "Laís", custom_fields: { cpf: "414.087.718-96" } };
    expect(getMissingBookingFields(CPF_FIELDS, valido)).toHaveLength(0);
  });

  it("sanitizeLeadDataPatch: descarta CPF invalido e normaliza o valido", () => {
    expect(sanitizeLeadDataPatch({ custom_fields: { cpf: "9h" } }).custom_fields?.cpf).toBeUndefined();
    expect(sanitizeLeadDataPatch({ custom_fields: { cpf: "41408771896" } }).custom_fields?.cpf).toBe(
      "414.087.718-96",
    );
  });

  it("preflightBookingFields: aponta issue invalid_cpf", () => {
    const res = preflightBookingFields(CPF_FIELDS, {
      name: "Laís",
      custom_fields: { cpf: "9h" },
    });
    expect(res.ok).toBe(false);
    expect(res.issues.some((i) => i.key === "cpf" && i.reason === "invalid_cpf")).toBe(true);
  });
});
