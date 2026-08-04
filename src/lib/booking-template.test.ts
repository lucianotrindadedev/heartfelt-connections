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
  hasSurname,
  mergePartialName,
  bookingFieldQuestion,
  tryAutoCaptureBookingAnswer,
  mentionsUnavailability,
  absoluteDdMmFromText,
  relativeDateIsExplanatory,
  requestedDateFromText,
  attendantSelfIntroducedNames,
  nameIsAttendantSelfIntroduction,
  requestedPeriodoFromText,
  isAskingDifferentDay,
  slotDayBrt,
  extractCompanionAppointmentNote,
  requestedHoraFromText,
  rankSlotsByRequestedHour,
  minutesOfDayFromLabel,
  affirmedDatesFromAssistant,
  ddmmInBrt,
  tryAutoSelectOfferedSlot,
  slotsOfferedInLastTurn,
  isReadyForBooking,
  isSlotAcceptanceMessage,
  isPointingGesture,
  pointingConfirmationReply,
  isValidCpf,
  looksLikeBirthDate,
  looksLikeDecline,
  signalsCannotAttendOrChange,
  looksLikeIntentMessage,
  looksLikeSchedulingPreference,
  looksLikeSentenceNotName,
  preflightBookingFields,
  renderBookingTemplate,
  resolveCollectedPhone,
  turmaTagForLead,
  sanitizeLeadDataPatch,
  scrubInventedTimeOffers,
  tagGateMissingField,
  type BookingFieldDef,
} from "./booking-template";
import type { AgentContext } from "./agents/context";
import { normalizeBrazilPhone } from "./conversation-channel.server";
import { stripNullishFields } from "./agents/parse-llm-json.server";
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
  it("limpa o campo name com STRING VAZIA, não undefined (caso '9 horas'/'Tudo bem' preso)", () => {
    // "" (não undefined) porque o patch passa por stripNullishFields no
    // orquestrador — undefined seria removido e o nome rejeitado NUNCA limparia.
    expect(clearRejectedBookingName({ name: "Tudo bem" })).toEqual({ name: "" });
    expect(clearRejectedBookingName({ name: "9 horas" })).toEqual({ name: "" });
  });

  it("o clear de name sobrevive ao stripNullishFields (regressão 21 97859-4196)", () => {
    const patch = clearRejectedBookingName({ name: "9 horas" });
    const afterStrip = stripNullishFields(patch as Record<string, unknown>);
    // A chave 'name' PRECISA continuar presente (com "") após o strip — senão o
    // merge no orquestrador não limpa o nome preso e o loop volta.
    expect("name" in afterStrip).toBe(true);
    expect(afterStrip.name).toBe("");
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
    expect(out).toEqual({ name: "" });
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
  // Data de VOLTA de viagem = indisponível até lá, não é pedido de agendamento.
  // Caso real (Costa Lima Recreio, Wagner 21 99401-9696).
  it("detecta viagem / volta como indisponibilidade", () => {
    expect(mentionsUnavailability("estou viajando de férias volto o rio dia 07 de agosto")).toBe(true);
    expect(mentionsUnavailability("só chego dia 07")).toBe(true);
    expect(mentionsUnavailability("volto dia 11")).toBe(true);
    expect(mentionsUnavailability("tô de férias")).toBe(true);
  });
  it("NÃO confunde pedido real de data com viagem", () => {
    expect(mentionsUnavailability("pode ser dia 11/08")).toBe(false);
    expect(mentionsUnavailability("na parte da manhã")).toBe(false);
  });
});

// absoluteDdMmFromText — data absoluta escrita pelo lead (não relativa).
describe("absoluteDdMmFromText", () => {
  it("reconhece DD/MM e 'DD de mês'", () => {
    expect(absoluteDdMmFromText("pode ser dia 11/08")).toBe("11/08");
    expect(absoluteDdMmFromText("11/8")).toBe("11/08");
    expect(absoluteDdMmFromText("dia 11 de agosto")).toBe("11/08");
    expect(absoluteDdMmFromText("07 de agosto")).toBe("07/08");
  });
  it("NÃO confunde horário, endereço, idade ou período com data", () => {
    expect(absoluteDdMmFromText("14:30")).toBeNull();
    expect(absoluteDdMmFromText("Av. das Américas, 13.685")).toBeNull();
    expect(absoluteDdMmFromText("1 ano")).toBeNull();
    expect(absoluteDdMmFromText("de manhã")).toBeNull();
  });
});

// Guard: lead pede data que não está entre os slots ofertados → não finaliza.
// Caso real (Costa Lima Recreio, Wagner 21 99401-9696): ofertou 07/08 e 08/08,
// lead pediu "dia 11/08" + "de manhã", o "manhã" agendava 07/08 09:00 (o dia da
// volta de viagem, que ele recusou).
describe("tryAutoSelectOfferedSlot — data pedida fora dos slots ofertados (Wagner)", () => {
  const SLOTS = [
    { iso: "2026-08-07T09:00:00-03:00", date_label: "sexta-feira, 07/08", time_label: "09:00" },
    { iso: "2026-08-07T09:45:00-03:00", date_label: "sexta-feira, 07/08", time_label: "09:45" },
    { iso: "2026-08-08T09:00:00-03:00", date_label: "sábado, 08/08", time_label: "09:00" },
  ];
  const oferta = "consigo te encaixar em 07/08 às 09:00 ou 09:45. Qual prefere?";

  it("'Pode ser dia 11/08' + 'Na parte da manhã' NÃO seleciona 07/08 09:00", () => {
    const patch = tryAutoSelectOfferedSlot("SLOT_OFFER", { offered_slots: SLOTS }, [
      { role: "assistant", content: oferta },
      { role: "user", content: "Pode ser dia 11/08" },
      { role: "user", content: "Na parte da manhã" },
    ]);
    expect(patch).toEqual({});
  });

  it("pedir uma data que EXISTE nos slots (07/08) segue selecionando por turno", () => {
    const patch = tryAutoSelectOfferedSlot("SLOT_OFFER", { offered_slots: SLOTS }, [
      { role: "assistant", content: oferta },
      { role: "user", content: "Na parte da manhã" },
    ]);
    expect(patch.selected_slot_iso).toBe("2026-08-07T09:00:00-03:00");
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

// ── signalsCannotAttendOrChange (objeção no CONFIRMED) ────────────────────
describe("signalsCannotAttendOrChange", () => {
  it("detecta impossibilidade de comparecer (caso Natalie, Maple Bear Osasco)", () => {
    expect(signalsCannotAttendOrChange("a logística não vai ficar legal pq eu trabalho na Lapa")).toBe(true);
    expect(signalsCannotAttendOrChange("não vou conseguir ir amanhã")).toBe(true);
    expect(signalsCannotAttendOrChange("não vai dar certo esse horário")).toBe(true);
    expect(signalsCannotAttendOrChange("surgiu um imprevisto")).toBe(true);
  });

  it("detecta cancelar / remarcar / outro dia", () => {
    expect(signalsCannotAttendOrChange("quero cancelar")).toBe(true);
    expect(signalsCannotAttendOrChange("dá pra remarcar?")).toBe(true);
    expect(signalsCannotAttendOrChange("tem outro dia?")).toBe(true);
    expect(signalsCannotAttendOrChange("consigo mudar o horário")).toBe(true);
  });

  it("detecta repensar / ano que vem", () => {
    expect(signalsCannotAttendOrChange("vou pensar mais um pouquinho")).toBe(true);
    expect(signalsCannotAttendOrChange("como só vamos colocar ela ano que vem vou pensar")).toBe(true);
    expect(signalsCannotAttendOrChange("preciso ver com meu marido")).toBe(true);
  });

  it("NÃO dispara em confirmação/positivo", () => {
    expect(signalsCannotAttendOrChange("Ok")).toBe(false);
    expect(signalsCannotAttendOrChange("Perfeito, estarei lá!")).toBe(false);
    expect(signalsCannotAttendOrChange("pode confirmar sim")).toBe(false);
    expect(signalsCannotAttendOrChange("obrigada!")).toBe(false);
    expect(signalsCannotAttendOrChange("")).toBe(false);
  });
});

// ── isAskingDifferentDay / slotDayBrt ─────────────────────────────────────
//
// Regressão (Odonto Carioca Campo Grande, 21 98725-2074): lead já agendada na
// quarta 22/07 pediu quinta 23/07 pra ir com a irmã. listar_horarios devolvia
// só o slot já escolhido (early-return por selected_slot_iso) e nunca buscava a
// quinta — o agente disse "não temos disponibilidade" sendo que a quinta tinha
// 35 vagas. Distinguir "pediu outro dia" é o que reabre a busca.
describe("isAskingDifferentDay", () => {
  const quarta0915 = "2026-07-22T09:15:00-03:00";

  it("true quando o dia pedido difere do dia do slot escolhido", () => {
    expect(isAskingDifferentDay(quarta0915, "2026-07-23")).toBe(true);
  });

  it("false quando o dia pedido é o MESMO do slot escolhido", () => {
    expect(isAskingDifferentDay(quarta0915, "2026-07-22")).toBe(false);
  });

  it("false quando não há dia pedido ou não há slot escolhido", () => {
    expect(isAskingDifferentDay(quarta0915, null)).toBe(false);
    expect(isAskingDifferentDay(quarta0915, "")).toBe(false);
    expect(isAskingDifferentDay("", "2026-07-23")).toBe(false);
    expect(isAskingDifferentDay(undefined, "2026-07-23")).toBe(false);
  });

  it("slotDayBrt extrai a data no fuso de Brasília", () => {
    expect(slotDayBrt(quarta0915)).toBe("2026-07-22");
    expect(slotDayBrt("")).toBe("");
    expect(slotDayBrt(undefined)).toBe("");
    expect(slotDayBrt("lixo")).toBe("");
  });
});

// ── extractCompanionAppointmentNote (acompanhante no mesmo número) ─────────
describe("extractCompanionAppointmentNote", () => {
  it("acha a linha que marca outra pessoa/acompanhante", () => {
    expect(
      extractCompanionAppointmentNote(
        "Implante superior; Inclui outra pessoa (acompanhante): Iraci — equipe cadastrar no local",
      ),
    ).toMatch(/acompanhante.*Iraci/i);
    expect(
      extractCompanionAppointmentNote("Quer avaliar\nA irmã vai junto também"),
    ).toMatch(/junto/i);
  });

  it("retorna '' quando não há acompanhante", () => {
    expect(extractCompanionAppointmentNote("Implante superior, dor há 1 semana")).toBe("");
    expect(extractCompanionAppointmentNote("")).toBe("");
    expect(extractCompanionAppointmentNote(undefined)).toBe("");
  });
});

// ── requestedDateFromText (âncora de data pro listar_horarios) ─────────────

// Caso real (Clínica Bomfim, agente "Assistente Virtual", lead 21 96416-7887,
// 13/07/2026). O agente ofertou "hoje às 17h ou 18h", o lead RECUSOU ("tenho
// compromisso de segunda a quarta nesse horário"), o agente propôs quinta e
// perguntou "manhã ou tarde?" — e o "Tarde" do lead auto-selecionou o slot de
// SEGUNDA 13/07 17:00 (o horário recusado). O booking determinístico criou o
// agendamento na Clinicorp e marcou stage=CONFIRMED sem o lead ter confirmado
// nada — e sem nem avisá-lo.
//
// A palavra "segunda" na frase do agente sobre a RECUSA ("como de segunda a
// quarta fica mais difícil") fez slotMentionedInText casar os slots velhos de
// segunda-feira, desarmando o guard de "turno puro não é escolha de slot".
describe("tryAutoSelectOfferedSlot — turno puro não pode ressuscitar slot recusado (Clínica Bomfim)", () => {
  const slotsSegunda = [
    { iso: "2026-07-13T17:00:00-03:00", date_label: "segunda-feira, 13/07", time_label: "17:00" },
    { iso: "2026-07-13T17:30:00-03:00", date_label: "segunda-feira, 13/07", time_label: "17:30" },
    { iso: "2026-07-13T18:00:00-03:00", date_label: "segunda-feira, 13/07", time_label: "18:00" },
  ];

  it("'Tarde' (resposta a 'manhã ou tarde?') NÃO seleciona o slot de segunda que o lead recusou", () => {
    const patch = tryAutoSelectOfferedSlot("SLOT_OFFER", { offered_slots: slotsSegunda }, [
      { role: "assistant", content: "Tenho dois horários próximos: hoje às 17h ou hoje às 18h." },
      { role: "user", content: "Tenho compromisso de segunda a quarta nesse horário" },
      {
        role: "assistant",
        content:
          "Entendo! Como de segunda a quarta fica mais difícil no fim do dia, que tal quinta-feira?",
      },
      {
        role: "assistant",
        content:
          "Para quinta-feira, dia 16/07, ficaria melhor um horário na parte da manhã ou na parte da tarde?",
      },
      { role: "user", content: "Tarde" },
    ]);
    expect(patch).toEqual({});
  });

  it("o dia da semana citado numa frase de RECUSA não conta como slot oferecido", () => {
    const patch = tryAutoSelectOfferedSlot("SLOT_OFFER", { offered_slots: slotsSegunda }, [
      {
        role: "assistant",
        content: "Como de segunda a quarta fica mais difícil, que tal quinta?",
      },
      { role: "user", content: "de tarde" },
    ]);
    expect(patch).toEqual({});
  });

  it("mas 'tarde' AINDA seleciona quando o agente acabou de dizer os horários", () => {
    const patch = tryAutoSelectOfferedSlot("SLOT_OFFER", { offered_slots: slotsSegunda }, [
      { role: "assistant", content: "Tenho hoje às 17:00 ou às 18:00. Qual prefere?" },
      { role: "user", content: "tarde" },
    ]);
    expect(patch.selected_slot_iso).toBe("2026-07-13T17:00:00-03:00");
  });

  it("horário explícito do lead manda sobre o filtro de data (não pega o mais cedo do dia)", () => {
    const slotsQuinta = [
      { iso: "2026-07-16T14:00:00-03:00", date_label: "quinta-feira, 16/07", time_label: "14:00" },
      { iso: "2026-07-16T15:30:00-03:00", date_label: "quinta-feira, 16/07", time_label: "15:30" },
    ];
    const patch = tryAutoSelectOfferedSlot("SLOT_OFFER", { offered_slots: slotsQuinta }, [
      { role: "assistant", content: "Consigo quinta 16/07 às 14h ou às 15h30. Qual prefere?" },
      { role: "user", content: "quinta às 15h30" },
    ]);
    expect(patch.selected_slot_iso).toBe("2026-07-16T15:30:00-03:00");
  });
});

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

  // Referência de SEMANA — caso Costa Lima Recreio, Melissa (21) 99305-7044:
  // pediu "próxima semana", o sistema ancorou em HOJE e agendou quarta 15/07
  // (desta semana) enquanto o texto dizia segunda 20/07.
  it("reconhece 'próxima semana' → segunda-feira da semana seguinte", () => {
    const today = dateInBrtLocal(new Date());
    for (const frase of [
      "Sim. Se possível, para a próxima semana",
      "pode ser semana que vem?",
      "só consigo na semana seguinte",
    ]) {
      const d = requestedDateFromText(frase);
      expect(d, frase).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(weekdayStemBrt(d!), frase).toBe("segunda");
      expect(d! > today, `${frase} → ${d} deve ser futuro (hoje ${today})`).toBe(true);
    }
  });

  it("'próxima quinta' resolve pela quinta, não pela segunda da semana", () => {
    const d = requestedDateFromText("pode ser na próxima quinta?");
    expect(weekdayStemBrt(d!)).toBe("quinta");
  });

  it("reconhece 'mês que vem' → dia 01 do mês seguinte", () => {
    const now = new Date();
    const y = Number(
      new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo", year: "numeric" }).format(
        now,
      ),
    );
    const m = Number(
      new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo", month: "2-digit" }).format(
        now,
      ),
    );
    const esperado = `${m === 12 ? y + 1 : y}-${String(m === 12 ? 1 : m + 1).padStart(2, "0")}-01`;
    for (const frase of ["pode ser mês que vem?", "só no próximo mês", "fica pro mês seguinte"]) {
      expect(requestedDateFromText(frase), frase).toBe(esperado);
    }
  });

  it("reconhece prazo 'daqui a X dias/semanas' (dígito e por extenso)", () => {
    const DAY = 86_400_000;
    const dISO = (offsetDays: number) =>
      dateInBrtLocal(new Date(Date.now() + offsetDays * DAY));
    expect(requestedDateFromText("consigo daqui a 3 dias")).toBe(dISO(3));
    expect(requestedDateFromText("pode ser em 10 dias")).toBe(dISO(10));
    expect(requestedDateFromText("dentro de 2 semanas")).toBe(dISO(14));
    expect(requestedDateFromText("daqui a uma semana")).toBe(dISO(7));
    expect(requestedDateFromText("daqui uns três dias")).toBe(dISO(3));
  });

  it("prazo passado/absurdo não vira pedido", () => {
    // "faz 3 dias" = fato passado, sem prefixo daqui/em/dentro de
    expect(requestedDateFromText("faz 3 dias que estou com dor")).toBeNull();
    // negação já é barrada antes (mentionsUnavailability)
    expect(requestedDateFromText("daqui a 3 dias não posso")).toBeNull();
    // fora do limite sensato
    expect(requestedDateFromText("daqui a 999 dias")).toBeNull();
  });
});

// helper local: data YYYY-MM-DD (BRT) de um instante — só p/ comparação nos testes
function dateInBrtLocal(d: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

// ── ddmmInBrt / affirmedDatesFromAssistant (guard de data no booking) ──────

describe("ddmmInBrt", () => {
  it("extrai DD/MM zero-padded no fuso BRT", () => {
    expect(ddmmInBrt("2026-07-15T13:00:00-03:00")).toBe("15/07");
    expect(ddmmInBrt("2026-07-20T09:00:00-03:00")).toBe("20/07");
  });
  it("ISO inválido → string vazia", () => {
    expect(ddmmInBrt("não-é-iso")).toBe("");
    expect(ddmmInBrt("")).toBe("");
  });
});

describe("affirmedDatesFromAssistant", () => {
  it("coleta as datas DD/MM afirmadas pelo agente (padroniza zero-padding)", () => {
    const set = affirmedDatesFromAssistant([
      "Para a próxima semana, tenho segunda-feira, dia 20/07:",
      "• Segunda-feira, 20/07 às 11:30\n• Segunda-feira, 20/07 às 13:00",
    ]);
    expect([...set]).toEqual(["20/07"]);
  });

  it("dia de um dígito vira zero-padded (3/7 → 03/07)", () => {
    expect([...affirmedDatesFromAssistant(["tenho vaga dia 3/7"])]).toEqual(["03/07"]);
  });

  it("ignora números com ponto/milhar (endereço não é data)", () => {
    const set = affirmedDatesFromAssistant([
      "Av. das Américas, 13.685, Loja 149 - Barra da Tijuca",
    ]);
    expect(set.size).toBe(0);
  });

  it("mismatch do caso real: agente disse 20/07, slot é 15/07", () => {
    const affirmed = affirmedDatesFromAssistant([
      "Perfeito, Melissa! Data: Segunda-feira, 20/07 Horário: 13:00",
    ]);
    const slot = ddmmInBrt("2026-07-15T13:00:00-03:00");
    expect(affirmed.size).toBeGreaterThan(0);
    expect(affirmed.has(slot)).toBe(false); // → guard bloqueia o agendamento
  });

  it("oferta multi-data: o slot escolhido está entre as afirmadas → não bloqueia", () => {
    const affirmed = affirmedDatesFromAssistant([
      "Tenho terça 15/07 e quarta 16/07, qual prefere?",
    ]);
    expect(affirmed.has(ddmmInBrt("2026-07-15T13:00:00-03:00"))).toBe(true);
    expect(affirmed.has(ddmmInBrt("2026-07-16T13:00:00-03:00"))).toBe(true);
  });
});

// ── requestedPeriodoFromText (âncora de turno pro listar_horarios) ─────────

describe("requestedPeriodoFromText", () => {
  it("detecta manhã (caso Costa Lima Madureira 21 99150-4698)", () => {
    expect(requestedPeriodoFromText("de manha mas eu so posso as terças e sabados")).toBe("manha");
    expect(requestedPeriodoFromText("amanha, tem pela manha?")).toBe("manha");
    expect(requestedPeriodoFromText("prefiro de manhã")).toBe("manha");
  });

  it("detecta tarde e noite", () => {
    expect(requestedPeriodoFromText("pode ser à tarde")).toBe("tarde");
    expect(requestedPeriodoFromText("só consigo de noite")).toBe("noite");
  });

  it("'amanhã' sozinho NÃO vira manhã (\\b evita casar 'amanhã')", () => {
    expect(requestedPeriodoFromText("pode ser amanhã")).toBeNull();
  });

  it("sem turno → null", () => {
    expect(requestedPeriodoFromText("quinta-feira")).toBeNull();
    expect(requestedPeriodoFromText("")).toBeNull();
  });

  // Dois turnos na frase: o que está em cláusula de TRABALHO/negação é a
  // indisponibilidade, não o desejo. Caso real (Costa Lima Recreio, Luciano
  // 32 99160-7088): "trabalho de manhã, só posso de tarde" era lido como manhã.
  it("desambigua 'trabalho de manhã, só posso de tarde' → tarde", () => {
    expect(requestedPeriodoFromText("eu trabalho de manha só posso de tarde")).toBe("tarde");
    expect(requestedPeriodoFromText("trabalho de manhã, só posso à tarde")).toBe("tarde");
    expect(requestedPeriodoFromText("de manhã não dá, tem que ser de tarde")).toBe("tarde");
    expect(requestedPeriodoFromText("trabalho a tarde, quero de manha")).toBe("manha");
  });
});

// ── requestedHoraFromText (prioridade de hora exata pro corte de 6 vagas) ──

describe("requestedHoraFromText", () => {
  it("detecta hora com 'às'/'as' sem sufixo (caso Jacqueline Gomes 21 96563-2113)", () => {
    expect(requestedHoraFromText("Só posso na parte da tarde as 16")).toBe(16);
    expect(requestedHoraFromText("Dia 23 só dá pra mim esse horário às 16 horas")).toBe(16);
    expect(
      requestedHoraFromText("Se não tiver dia 23, pode ser no dia 24, às 16 horas, não tem problema"),
    ).toBe(16);
  });

  it("detecta hora com sufixo explícito sem 'às'", () => {
    expect(requestedHoraFromText("Como já disse só posso no horário das 16 horas")).toBe(16);
    expect(requestedHoraFromText("pode ser 16:00")).toBe(16);
    expect(requestedHoraFromText("tem vaga 9h?")).toBe(9);
  });

  it("não confunde número de data solto com hora", () => {
    expect(requestedHoraFromText("dia 23/07")).toBeNull();
    expect(requestedHoraFromText("tenho 23 anos")).toBeNull();
    expect(requestedHoraFromText("")).toBeNull();
  });

  it("converte hora coloquial da TARDE/NOITE para 24h (caso Eliane 21 97256-0633)", () => {
    // Ela trabalha até as 16h e precisa de horário DEPOIS disso. Lido como 4 da
    // manhã, o ranking priorizava os slots mais próximos das 4h → ofertava 09:00,
    // 09:45 e 10:30 (manhã) justamente para quem só pode no fim da tarde.
    expect(requestedHoraFromText("só saio 4 horas da tarde")).toBe(16);
    expect(requestedHoraFromText("Sexta-feira eu não vou conseguir sair 4 horas")).toBe(16);
    expect(requestedHoraFromText("Só depois das 7 da noite")).toBe(19);
    expect(requestedHoraFromText("pode ser 5 da tarde?")).toBe(17);
    expect(requestedHoraFromText("umas 8 da noite")).toBe(20);
  });

  it("não desloca hora já em 24h nem a manhã explícita", () => {
    expect(requestedHoraFromText("às 16 horas")).toBe(16);
    expect(requestedHoraFromText("pode ser 9 da manhã")).toBe(9);
    expect(requestedHoraFromText("tem vaga 9h?")).toBe(9);
    expect(requestedHoraFromText("meio-dia, 12 horas")).toBe(12);
    // "12 da noite" = meia-noite, não 24h
    expect(requestedHoraFromText("12 da noite")).toBe(0);
  });
});

// ── rankSlotsByRequestedHour (paridade entre provedores) ──────────────────

describe("rankSlotsByRequestedHour", () => {
  const slots = ["09:00", "09:45", "10:30", "14:30", "16:00", "16:45", "17:15"];
  const rank = (hora: number | null) =>
    rankSlotsByRequestedHour(slots, hora, minutesOfDayFromLabel);

  it("prioriza os horários mais próximos da hora pedida antes do corte", () => {
    // Caso Eliane: pediu depois das 16h. O corte de 6 sem ranking pegava a manhã.
    expect(rank(16).slice(0, 3)).toEqual(["16:00", "16:45", "17:15"]);
  });

  it("usa o minuto, não só a hora: pedindo 17h, 16:45 vem antes de 16:00", () => {
    // Comparando só a hora (como o Clinicorp fazia), 16:45 e 16:00 empatavam em
    // |16-17|=1 e o desempate caía no mais cedo — 16:00 na frente de 16:45.
    expect(rank(17).indexOf("16:45")).toBeLessThan(rank(17).indexOf("16:00"));
    // 16:45 e 17:15 ficam a 15 min dos 17h: empate real, resolvido pelo mais cedo.
    expect(rank(17).slice(0, 2)).toEqual(["16:45", "17:15"]);
  });

  it("sem hora pedida devolve a ordem cronológica intacta", () => {
    expect(rank(null)).toEqual(slots);
  });

  it("não muta o array de entrada", () => {
    const orig = [...slots];
    rank(16);
    expect(slots).toEqual(orig);
  });
});

describe("minutesOfDayFromLabel", () => {
  it("lê os formatos que os provedores devolvem", () => {
    expect(minutesOfDayFromLabel("16:45")).toBe(1005);
    expect(minutesOfDayFromLabel("9:00")).toBe(540);
    expect(minutesOfDayFromLabel("16h45")).toBe(1005);
    expect(minutesOfDayFromLabel("16")).toBe(960);
  });

  it("devolve -1 no que não é hora", () => {
    expect(minutesOfDayFromLabel("")).toBe(-1);
    expect(minutesOfDayFromLabel("banana")).toBe(-1);
    expect(minutesOfDayFromLabel("99:99")).toBe(-1);
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
    // Caso real (Costa Lima Recreio, 21 97558-2703, 14/07): hora CHEIA, sem
    // minutos. O regex antigo exigia `\d{1,2}:\d{2}`, então "9h" não era aceite
    // de horário — o lead escolheu "9h" duas vezes e o slot nunca foi gravado.
    ["9h", true],
    ["9 h", true],
    ["9hs", true],
    ["9 horas", true],
    ["às 9", true],
    ["as 9", true],
    ["9h30", true],
    ["eu já falei que pode marcar 9h", true],
    ["sexta 9h", true],
    // Número solto continua NÃO sendo horário: seria ambíguo com dia do mês,
    // idade, quantidade de filhos, etc.
    ["9", false],
    ["1 ano", false],
    // Indisponibilidade em hora cheia continua sendo recusa, não aceite.
    ["só saio do trabalho as 18h", false],
    // Caso real (Costa Lima Recreio, 21 98985-6865, 14/07): a lead aceitou o
    // horário ofertado escrevendo "14: 30" (espaço depois do ":") e depois
    // "14.30" (ponto). Os minutos precisavam vir COLADOS a ":"/"h", então
    // nenhum dos dois era horário — o slot nunca era gravado e o agente
    // repetia "tive um problema ao registrar sua visita", em loop.
    ["14: 30 fica bom pra mim", true],
    ["14.30", true],
    ["14 : 30", true],
    ["14,30", true],
    ["pode ser 14.30", true],
    // Valor monetário NÃO é horário (guardas de dígito nas bordas do regex).
    ["o valor de 1.500 ficou bom", false],
    ["ficou bom, R$ 1.500,00", false],
    // Hora/minuto fora da faixa não é horário.
    ["14.75", false],
  ])("isSlotAcceptanceMessage(%j) → %s", (input, expected) => {
    expect(isSlotAcceptanceMessage(input)).toBe(expected);
  });
});

// Caso real (Costa Lima Recreio, agente "Assistente Virtual", lead 21
// 97558-2703, 14/07/2026). O agente ofertou "sexta 09:00 / 09:45", o lead
// respondeu "9h" e depois mandou o nome completo — e o agente voltou a
// perguntar "qual horário fica melhor pra você?".
//
// Cadeia da falha: "9h" não casava em NENHUM ramo de isSlotAcceptanceMessage
// (todos exigiam minutos), tryAutoSelectOfferedSlot devolvia {} e
// selected_slot_iso NUNCA era gravado. Como lead-patch-guard proíbe o LLM de
// setar selected_slot_iso (só a heurística determinística pode), o campo ficou
// vazio pra sempre: o booking determinístico nunca disparou e o guard anti-stall
// caiu no ramo "sem slot escolhido" → reperguntou o horário e voltou pra
// SLOT_OFFER, num loop.
describe("tryAutoSelectOfferedSlot — hora cheia sem minutos (Costa Lima Recreio)", () => {
  const slotsSexta = [
    { iso: "2026-07-17T09:00:00-03:00", date_label: "sexta-feira, 17/07", time_label: "09:00" },
    { iso: "2026-07-17T09:45:00-03:00", date_label: "sexta-feira, 17/07", time_label: "09:45" },
  ];

  it("'9h' seleciona o slot das 09:00", () => {
    const patch = tryAutoSelectOfferedSlot("SLOT_OFFER", { offered_slots: slotsSexta }, [
      { role: "assistant", content: "Tenho sexta-feira às 09:00 e às 09:45. Qual prefere?" },
      { role: "user", content: "9h" },
    ]);
    expect(patch.selected_slot_iso).toBe("2026-07-17T09:00:00-03:00");
  });

  it.each(["9 horas", "às 9", "9hs"])("'%s' também seleciona o slot das 09:00", (msg) => {
    const patch = tryAutoSelectOfferedSlot("SLOT_OFFER", { offered_slots: slotsSexta }, [
      { role: "assistant", content: "Tenho sexta-feira às 09:00 e às 09:45. Qual prefere?" },
      { role: "user", content: msg },
    ]);
    expect(patch.selected_slot_iso).toBe("2026-07-17T09:00:00-03:00");
  });

  it("'eu já falei que pode marcar 9h' seleciona o slot das 09:00", () => {
    const patch = tryAutoSelectOfferedSlot("NAME_COLLECT", { offered_slots: slotsSexta }, [
      { role: "assistant", content: "Qual horário fica melhor pra você?" },
      { role: "user", content: "eu já falei que pode marcar 9h" },
    ]);
    expect(patch.selected_slot_iso).toBe("2026-07-17T09:00:00-03:00");
  });

  it("'9h45' seleciona o segundo slot, não o primeiro", () => {
    const patch = tryAutoSelectOfferedSlot("SLOT_OFFER", { offered_slots: slotsSexta }, [
      { role: "assistant", content: "Tenho sexta-feira às 09:00 e às 09:45. Qual prefere?" },
      { role: "user", content: "9h45" },
    ]);
    expect(patch.selected_slot_iso).toBe("2026-07-17T09:45:00-03:00");
  });

  it("hora cheia que NÃO existe em offered_slots não seleciona nada", () => {
    const patch = tryAutoSelectOfferedSlot("SLOT_OFFER", { offered_slots: slotsSexta }, [
      { role: "assistant", content: "Tenho sexta-feira às 09:00 e às 09:45. Qual prefere?" },
      { role: "user", content: "15h" },
    ]);
    expect(patch).toEqual({});
  });

  it("indisponibilidade em hora cheia não vira escolha de slot", () => {
    const patch = tryAutoSelectOfferedSlot("SLOT_OFFER", { offered_slots: slotsSexta }, [
      { role: "assistant", content: "Tenho sexta-feira às 09:00 e às 09:45. Qual prefere?" },
      { role: "user", content: "só saio do trabalho as 9h" },
    ]);
    expect(patch).toEqual({});
  });
});

// Caso real (Costa Lima Recreio, lead 21 98985-6865, 14/07/2026). O agente
// ofertou "quarta 15/07 às 14:30 ou às 15:15"; a lead aceitou escrevendo
// "14: 30 fica bom pra mim" e, ao ser reperguntada, "14.30".
//
// Cadeia da falha: os regexes de horário exigiam os minutos COLADOS a ":"/"h"
// (só esses dois separadores). "14: 30" (espaço) e "14.30" (ponto) não eram
// horário em ramo nenhum → selected_slot_iso nunca gravado → o booking
// determinístico não disparava e o agente respondia "tive um problema ao
// registrar sua visita. Pode me confirmar o horário?" — em loop.
describe("tryAutoSelectOfferedSlot — separador de minutos solto (Costa Lima Recreio)", () => {
  const slotsQuarta = [
    { iso: "2026-07-15T14:30:00-03:00", date_label: "quarta-feira, 15/07", time_label: "14:30" },
    { iso: "2026-07-15T15:15:00-03:00", date_label: "quarta-feira, 15/07", time_label: "15:15" },
  ];
  const oferta = "que tal agendarmos para essa quarta-feira, 15/07, às 14:30 ou às 15:15?";

  it.each([
    "14: 30 fica bom pra mim", // o que a lead realmente escreveu
    "14.30", // e depois isso
    "14 : 30",
    "14,30",
    "14:30",
  ])("'%s' seleciona o slot das 14:30", (msg) => {
    const patch = tryAutoSelectOfferedSlot("SLOT_OFFER", { offered_slots: slotsQuarta }, [
      { role: "assistant", content: oferta },
      { role: "user", content: msg },
    ]);
    expect(patch.selected_slot_iso).toBe("2026-07-15T14:30:00-03:00");
  });

  it("'15.15' seleciona o segundo slot, não o primeiro", () => {
    const patch = tryAutoSelectOfferedSlot("SLOT_OFFER", { offered_slots: slotsQuarta }, [
      { role: "assistant", content: oferta },
      { role: "user", content: "15.15" },
    ]);
    expect(patch.selected_slot_iso).toBe("2026-07-15T15:15:00-03:00");
  });

  it("valor monetário com ponto não vira horário nem seleciona slot", () => {
    const patch = tryAutoSelectOfferedSlot("SLOT_OFFER", { offered_slots: slotsQuarta }, [
      { role: "assistant", content: oferta },
      { role: "user", content: "o tratamento de 1.500 ficou bom pra mim" },
    ]);
    expect(patch).toEqual({});
  });

  // O endereço da própria clínica tem ponto de milhar ("Av. das Américas,
  // 13.685") e aparece na mensagem do agente. Não pode ser lido como um
  // horário ofertado (13:68 nem existe; a guarda de minutos [0-5]\d barra).
  it("número de endereço com ponto no texto do agente não vira horário ofertado", () => {
    const patch = tryAutoSelectOfferedSlot("SLOT_OFFER", { offered_slots: slotsQuarta }, [
      {
        role: "assistant",
        content: "Ficamos na Av. das Américas, 13.685, Loja 149. Prefere manhã ou tarde?",
      },
      { role: "user", content: "tarde" },
    ]);
    expect(patch).toEqual({});
  });
});

// Caso real (Costa Lima Recreio, Luciano 32 99160-7088, 15/07): o lead aceitou
// 16:45 e o sistema foi agendar 13:00. Dois defeitos combinados:
// (1) a PERGUNTA "tem mais tarde?" era lida como escolha de turno e travava o
//     primeiro slot da tarde (13:00);
// (2) "fica sim" não era reconhecido como aceite, então o 16:45 nunca
//     substituía o 13:00 travado.
describe("tryAutoSelectOfferedSlot — pergunta não escolhe; 'fica sim' aceita a proposta do turno (Luciano)", () => {
  const SLOTS = [
    { iso: "2026-07-17T11:15:00-03:00", date_label: "sexta-feira, 17/07", time_label: "11:15" },
    { iso: "2026-07-17T13:00:00-03:00", date_label: "sexta-feira, 17/07", time_label: "13:00" },
    { iso: "2026-07-17T13:45:00-03:00", date_label: "sexta-feira, 17/07", time_label: "13:45" },
    { iso: "2026-07-17T16:45:00-03:00", date_label: "sexta-feira, 17/07", time_label: "16:45" },
  ];

  it("'eu trabalho até esse horario tem mais tarde?' é PERGUNTA — não seleciona nada", () => {
    const patch = tryAutoSelectOfferedSlot("SLOT_OFFER", { offered_slots: SLOTS }, [
      { role: "assistant", content: "tenho sexta 17/07 às 13:00 ou 13:45. Qual prefere?" },
      { role: "user", content: "eu trabalho até esse horario tem mais tarde?" },
    ]);
    expect(patch).toEqual({});
  });

  it.each(["tem outro horário mais tarde?", "tem mais tarde", "tem algum depois das 16h?"])(
    "'%s' também não seleciona",
    (msg) => {
      const patch = tryAutoSelectOfferedSlot("SLOT_OFFER", { offered_slots: SLOTS }, [
        { role: "assistant", content: "tenho sexta às 13:00 ou 13:45." },
        { role: "user", content: msg },
      ]);
      expect(patch).toEqual({});
    },
  );

  it("'fica sim' após o agente propor UM horário (16:45) seleciona o 16:45", () => {
    const patch = tryAutoSelectOfferedSlot("SLOT_OFFER", { offered_slots: SLOTS }, [
      { role: "assistant", content: "temos um horário mais tarde na sexta-feira, dia 17/07, às 16:45. 😊" },
      { role: "assistant", content: "Esse horário de 16:45 fica bom para você?" },
      { role: "user", content: "fica sim" },
    ]);
    expect(patch.selected_slot_iso).toBe("2026-07-17T16:45:00-03:00");
  });

  it.each(["fica bom", "fica ótimo", "serve"])("'%s' também é aceite da proposta única", (msg) => {
    const patch = tryAutoSelectOfferedSlot("SLOT_OFFER", { offered_slots: SLOTS }, [
      { role: "assistant", content: "Consigo às 16:45. Fica bom?" },
      { role: "user", content: msg },
    ]);
    expect(patch.selected_slot_iso).toBe("2026-07-17T16:45:00-03:00");
  });

  it("'fica sim' com DOIS horários propostos no turno continua ambíguo — não seleciona", () => {
    const patch = tryAutoSelectOfferedSlot("SLOT_OFFER", { offered_slots: SLOTS }, [
      { role: "assistant", content: "tenho às 13:00 ou às 13:45. Qual prefere?" },
      { role: "user", content: "fica sim" },
    ]);
    expect(patch).toEqual({});
  });
});

// Ordinal ("o primeiro") se refere à ordem em que o AGENTE falou os horários,
// não à ordem de offered_slots. offered_slots traz até 6 vagas vindas da
// agenda, mas o agente só menciona 2 por mensagem — o código pegava
// offered_slots[0], um horário que o agente podia NUNCA ter falado, e agendava
// silenciosamente o horário errado.
describe("tryAutoSelectOfferedSlot — ordinal usa a ordem falada pelo agente", () => {
  const SEIS_VAGAS = [
    { iso: "2026-07-15T13:00:00-03:00", date_label: "quarta-feira, 15/07", time_label: "13:00" },
    { iso: "2026-07-15T13:45:00-03:00", date_label: "quarta-feira, 15/07", time_label: "13:45" },
    { iso: "2026-07-15T14:30:00-03:00", date_label: "quarta-feira, 15/07", time_label: "14:30" },
    { iso: "2026-07-15T15:15:00-03:00", date_label: "quarta-feira, 15/07", time_label: "15:15" },
    { iso: "2026-07-15T16:00:00-03:00", date_label: "quarta-feira, 15/07", time_label: "16:00" },
    { iso: "2026-07-15T16:45:00-03:00", date_label: "quarta-feira, 15/07", time_label: "16:45" },
  ];
  // O agente ofereceu a 3ª e a 4ª vaga da lista — não a 1ª.
  const oferta = "Que tal quarta-feira, 15/07, às 14:30 ou às 15:15?";

  it("'o primeiro' pega o 1º horário FALADO (14:30), não offered_slots[0] (13:00)", () => {
    const patch = tryAutoSelectOfferedSlot("SLOT_OFFER", { offered_slots: SEIS_VAGAS }, [
      { role: "assistant", content: oferta },
      { role: "user", content: "o primeiro" },
    ]);
    expect(patch.selected_slot_iso).toBe("2026-07-15T14:30:00-03:00");
  });

  it("'o segundo' pega o 2º horário FALADO (15:15), não offered_slots[1] (13:45)", () => {
    const patch = tryAutoSelectOfferedSlot("SLOT_OFFER", { offered_slots: SEIS_VAGAS }, [
      { role: "assistant", content: oferta },
      { role: "user", content: "o segundo" },
    ]);
    expect(patch.selected_slot_iso).toBe("2026-07-15T15:15:00-03:00");
  });

  it("sem horário falado pelo agente, o ordinal cai na ordem de offered_slots", () => {
    const patch = tryAutoSelectOfferedSlot("SLOT_OFFER", { offered_slots: SEIS_VAGAS }, [
      { role: "assistant", content: "Prefere manhã ou tarde?" },
      { role: "user", content: "o primeiro" },
    ]);
    expect(patch.selected_slot_iso).toBe("2026-07-15T13:00:00-03:00");
  });
});

// Escolha por ordem em frase NATURAL ("eu quero esse primeiro horário"). A
// regex antiga era ancorada em "^(o )?primeiro", então só o "o primeiro" seco
// funcionava — qualquer frase em volta caía fora e o agendamento dependia da
// LLM. E soltar a âncora sem cuidado quebra o "primeiro" ADVÉRBIO ("primeiro
// preciso saber o valor"), que agendaria o horário 0 em cima de quem só queria
// informação. Por isso o ordinal exige determinante antes OU substantivo depois.
describe("tryAutoSelectOfferedSlot — ordinal em frase natural", () => {
  const SLOTS = [
    { iso: "2026-07-15T14:30:00-03:00", date_label: "quarta-feira, 15/07", time_label: "14:30" },
    { iso: "2026-07-15T15:30:00-03:00", date_label: "quarta-feira, 15/07", time_label: "15:30" },
  ];
  const oferta = "Tenho quarta-feira, 15/07, às 14:30 ou às 15:30. Qual prefere?";
  const escolha = (msg: string) =>
    tryAutoSelectOfferedSlot("SLOT_OFFER", { offered_slots: SLOTS }, [
      { role: "assistant", content: oferta },
      { role: "user", content: msg },
    ]).selected_slot_iso ?? null;

  it.each([
    "eu quero esse primeiro horario",
    "quero o primeiro horário",
    "vou querer o primeiro horario",
    "prefiro o primeiro",
    "esse primeiro ta bom",
    "o primeiro",
    "a 1ª opção",
  ])("'%s' → 14:30", (msg) => {
    expect(escolha(msg)).toBe("2026-07-15T14:30:00-03:00");
  });

  it.each(["quero o segundo horario", "a segunda opção", "esse segundo"])(
    "'%s' → 15:30",
    (msg) => {
      expect(escolha(msg)).toBe("2026-07-15T15:30:00-03:00");
    },
  );

  // "primeiro" ADVÉRBIO não é escolha de horário — não pode selecionar nada.
  it.each([
    "primeiro preciso saber o valor",
    "primeiro me diz o preço",
    "primeiro quero entender o tratamento",
  ])("'%s' NÃO seleciona horário", (msg) => {
    expect(escolha(msg)).toBeNull();
  });
});

describe("slotsOfferedInLastTurn", () => {
  const VAGAS = [
    { iso: "2026-07-15T13:00:00-03:00", date_label: "quarta-feira, 15/07", time_label: "13:00" },
    { iso: "2026-07-15T14:30:00-03:00", date_label: "quarta-feira, 15/07", time_label: "14:30" },
    { iso: "2026-07-15T15:15:00-03:00", date_label: "quarta-feira, 15/07", time_label: "15:15" },
  ];

  it("devolve só os horários falados, na ordem em que o agente os disse", () => {
    const out = slotsOfferedInLastTurn({ offered_slots: VAGAS }, [
      { role: "assistant", content: "Tenho às 15:15 ou às 14:30." },
      { role: "user", content: "hmm" },
    ]);
    expect(out.map((s) => s.time_label)).toEqual(["15:15", "14:30"]);
  });

  it("não confunde o número do endereço com horário ofertado", () => {
    const out = slotsOfferedInLastTurn({ offered_slots: VAGAS }, [
      { role: "assistant", content: "Ficamos na Av. das Américas, 13.685, Loja 149." },
      { role: "user", content: "ok" },
    ]);
    expect(out).toEqual([]);
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

// ── NOME COMPLETO (nome + sobrenome) antes de agendar ─────────────────────
//
// O prompt do proprietário pedia "nome completo" e o agente agendava com "Ana"
// mesmo assim — cadastro de paciente sem sobrenome, impossível de localizar
// depois e fonte de duplicidade. A regra virou determinística.

const CLINIC_NAME_FIELD: BookingFieldDef = {
  key: "name",
  label: "Nome completo",
  question: "Perfeito. Para finalizar, me envia por favor seu nome completo?",
  required: true,
  maps_to: "name",
};

describe("hasSurname", () => {
  it.each([
    ["Ana", false],
    ["ana", false],
    ["Ana Souza", true],
    ["ana souza", true],
    ["Ana de Souza", true],
    ["João dos Santos", true],
    ["Ana S.", false], // inicial abreviada não é sobrenome
    ["Luciano T.", false],
    ["Ana de", false], // só partícula depois do primeiro nome
    ["Maria-Clara", false], // nome composto com hífen ainda é um nome só
    ["Maria-Clara Fonseca", true],
    ["", false],
    ["   ", false],
  ])("hasSurname(%j) → %s", (input, expected) => {
    expect(hasSurname(input)).toBe(expected);
  });

  it("ignora nulo/indefinido", () => {
    expect(hasSurname(null)).toBe(false);
    expect(hasSurname(undefined)).toBe(false);
  });
});

describe("getMissingBookingFields — nome sem sobrenome fica pendente", () => {
  it("primeiro nome sozinho conta como MISSING", () => {
    expect(getMissingBookingFields([CLINIC_NAME_FIELD], { name: "Ana" }).map((f) => f.key)).toEqual([
      "name",
    ]);
  });

  it("nome + sobrenome libera o campo", () => {
    expect(getMissingBookingFields([CLINIC_NAME_FIELD], { name: "Ana Souza" })).toHaveLength(0);
  });

  it("agendamento JÁ criado não reabre a cobrança do sobrenome", () => {
    expect(
      getMissingBookingFields([CLINIC_NAME_FIELD], { name: "Ana", appointment_id: "evt_123" }),
    ).toHaveLength(0);
  });

  it("require_full_name:false (opt-out do proprietário) aceita primeiro nome", () => {
    const field: BookingFieldDef = { ...CLINIC_NAME_FIELD, require_full_name: false };
    expect(getMissingBookingFields([field], { name: "Ana" })).toHaveLength(0);
  });

  it("data de nascimento NÃO é tratada como nome (não exige sobrenome)", () => {
    const ld: LeadData = {
      custom_fields: {
        child_name: "Pedro Alves",
        child_birth_date: "25/07/2019",
        guardians: "Ana Souza",
      },
    };
    expect(getMissingBookingFields(SCHOOL_FIELDS, ld)).toHaveLength(0);
  });

  it("nome da criança sem sobrenome segura o agendamento", () => {
    const ld: LeadData = {
      custom_fields: {
        child_name: "Pedro",
        child_birth_date: "25/07/2019",
        guardians: "Ana Souza",
      },
    };
    expect(getMissingBookingFields(SCHOOL_FIELDS, ld).map((f) => f.key)).toEqual(["child_name"]);
  });
});

describe("isReadyForBooking — bloqueia com nome incompleto", () => {
  const settings = { booking_fields_json: JSON.stringify([CLINIC_NAME_FIELD]) };
  const base = { hasPhone: true, hasBookingIntegration: true };

  it("não agenda com só o primeiro nome", () => {
    const ld: LeadData = { name: "Ana", selected_slot_iso: "2026-08-10T13:00:00.000Z" };
    expect(isReadyForBooking(ld, settings, base)).toBe(false);
  });

  it("agenda com nome + sobrenome", () => {
    const ld: LeadData = { name: "Ana Souza", selected_slot_iso: "2026-08-10T13:00:00.000Z" };
    expect(isReadyForBooking(ld, settings, base)).toBe(true);
  });
});

describe("mergePartialName — resposta só com o sobrenome completa o nome", () => {
  it('"Ana" + "Souza" → "Ana Souza"', () => {
    expect(mergePartialName("Ana", "Souza")).toBe("Ana Souza");
  });

  it("lead repete o nome inteiro → substitui (não duplica)", () => {
    expect(mergePartialName("Ana", "Ana Souza")).toBe("Ana Souza");
  });

  it("repetir o mesmo primeiro nome não vira 'Ana Ana'", () => {
    expect(mergePartialName("Ana", "Ana")).toBe("Ana");
    expect(mergePartialName("Ana", "ana")).toBe("ana");
  });

  it("nome já completo é substituído por um novo completo (correção)", () => {
    expect(mergePartialName("Ana Souza", "Bia Lima")).toBe("Bia Lima");
  });

  it("sem valor anterior devolve a resposta", () => {
    expect(mergePartialName(undefined, "Ana")).toBe("Ana");
  });
});

describe("captura do sobrenome no histórico (sem loop)", () => {
  const settings = { booking_fields_json: JSON.stringify([CLINIC_NAME_FIELD]) };

  it('resposta "Souza" ao pedido de sobrenome junta com o "Ana" já guardado', () => {
    const patch = tryAutoCaptureBookingAnswer(
      "NAME_COLLECT",
      { name: "Ana", selected_slot_iso: "2026-08-10T13:00:00.000Z" },
      [
        { role: "assistant", content: "Ana, me confirma seu sobrenome, por favor?" },
        { role: "user", content: "Souza" },
      ],
      settings,
    );
    expect(patch.name).toBe("Ana Souza");
  });

  it("backfill do histórico chega no nome completo", () => {
    const patch = backfillBookingFieldsFromHistory(
      {},
      [
        { role: "assistant", content: "Para finalizar, me envia por favor seu nome completo?" },
        { role: "user", content: "Ana" },
        { role: "assistant", content: "Ana, me confirma seu sobrenome, por favor?" },
        { role: "user", content: "Souza" },
      ],
      settings,
    );
    expect(patch.name).toBe("Ana Souza");
  });
});

describe("bookingFieldQuestion — pede só o que falta", () => {
  it("campo vazio → pergunta original", () => {
    expect(bookingFieldQuestion(CLINIC_NAME_FIELD, {})).toBe(CLINIC_NAME_FIELD.question);
  });

  it("já tem o primeiro nome → pede o sobrenome citando o nome", () => {
    const q = bookingFieldQuestion(CLINIC_NAME_FIELD, { name: "Ana" });
    expect(q).toMatch(/^Ana,/);
    expect(q).toMatch(/sobrenome/i);
  });

  it("nome da criança incompleto → pergunta pelo sobrenome da criança", () => {
    const childField = SCHOOL_FIELDS[0]!;
    const q = bookingFieldQuestion(childField, { custom_fields: { child_name: "Pedro" } });
    expect(q).toMatch(/sobrenome de Pedro/i);
  });
});

describe("sanitizeLeadDataPatch — sobrenome do LLM completa o nome", () => {
  it('patch name="Souza" logo após pedirmos o sobrenome vira "Ana Souza"', () => {
    const out = sanitizeLeadDataPatch(
      { name: "Souza" },
      { current: { name: "Ana" }, lastAssistantText: "Ana, me confirma seu sobrenome?" },
    );
    expect(out.name).toBe("Ana Souza");
  });

  it("sem pedido de sobrenome, nome novo SUBSTITUI (correção do lead)", () => {
    const out = sanitizeLeadDataPatch(
      { name: "Bia" },
      { current: { name: "Ana" }, lastAssistantText: "Qual horário fica melhor pra você?" },
    );
    expect(out.name).toBe("Bia");
  });

  it("sem contexto mantém o comportamento antigo", () => {
    expect(sanitizeLeadDataPatch({ name: "Souza" }).name).toBe("Souza");
  });
});

describe("CPF no pipeline de booking", () => {
  it("getMissingBookingFields: CPF invalido conta como pendente", () => {
    const invalido: LeadData = { name: "Laís Moreira", custom_fields: { cpf: "9h" } };
    expect(getMissingBookingFields(CPF_FIELDS, invalido).map((f) => f.key)).toContain("cpf");

    const valido: LeadData = { name: "Laís Moreira", custom_fields: { cpf: "414.087.718-96" } };
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

describe("scrubInventedTimeOffers — qualifier oferta horário sem ter agenda (Costa Lima Recreio 18/07)", () => {
  it("corta a oferta inventada, preserva o pitch e fecha com pergunta neutra", () => {
    const reply =
      "Poxa, entendo perfeitamente. Muitos pacientes chegam com essa mesma dificuldade na mastigação, e a boa notícia é que você não precisa enfrentar isso sozinho. A Costa Lima é referência em reabilitação oral, com mais de 11 anos e mais de 1.000 implantes realizados. 😊\n" +
      "Como um presente nosso pra você dar esse primeiro passo, essa primeira consulta fica por nossa conta. Tenho estes horários disponíveis: segunda-feira às 14h ou terça-feira às 10h.\n" +
      "Qual desses fica melhor pra você?";
    const out = scrubInventedTimeOffers(reply);
    expect(out.scrubbed).toBe(true);
    expect(out.reply).toContain("presente nosso");
    expect(out.reply).not.toContain("14h");
    expect(out.reply).not.toContain("segunda-feira");
    expect(out.reply).not.toContain("Qual desses");
    expect(out.reply).toContain("manhã ou à tarde");
  });

  it("detecta 'amanhã às 10h' e variações com minutos", () => {
    expect(scrubInventedTimeOffers("Consigo te encaixar amanhã às 10h, pode ser?").scrubbed).toBe(true);
    expect(scrubInventedTimeOffers("Que tal quinta-feira às 14:30?").scrubbed).toBe(true);
    expect(scrubInventedTimeOffers("Posso te atender hoje às 16h!").scrubbed).toBe(true);
  });

  it("quando a oferta abre a resposta, sobra só a pergunta neutra", () => {
    const out = scrubInventedTimeOffers("Consigo te encaixar amanhã às 10h, pode ser?");
    expect(out.reply).toContain("manhã ou à tarde");
    expect(out.reply).not.toContain("10h");
  });

  it("NÃO dispara em horário de funcionamento (faixa 'das X às Y')", () => {
    expect(
      scrubInventedTimeOffers("Atendemos de segunda a sexta, das 08:00 às 18:00. Posso te ajudar em algo mais?")
        .scrubbed,
    ).toBe(false);
    expect(
      scrubInventedTimeOffers("Funcionamos de segunda a sábado, das 8h às 12h. 😊").scrubbed,
    ).toBe(false);
  });

  it("NÃO dispara em respostas normais sem dia+horário", () => {
    expect(scrubInventedTimeOffers("Que ótimo! Você prefere de manhã ou à tarde?").scrubbed).toBe(false);
    expect(scrubInventedTimeOffers("Perfeito, vou te mostrar as opções disponíveis. 😊").scrubbed).toBe(false);
    expect(scrubInventedTimeOffers("").scrubbed).toBe(false);
  });
});

// ── nome da atendente não pode virar nome do lead ──────────────────────────

describe("nameIsAttendantSelfIntroduction (caso Odonto Carioca 21 96932-0210)", () => {
  const saudacaoVal = [
    "Olá, bom dia tudo bem? Me chamo Val. Qual é o seu nome? Estou muito feliz pelo seu interesse na nossa clínica *Odonto Carioca*! ☺️😁",
  ];

  it("descarta o nome que a clínica apresentou como dela", () => {
    expect(nameIsAttendantSelfIntroduction("Val", saudacaoVal)).toBe(true);
  });

  it("descarta também quando vem com sobrenome", () => {
    expect(nameIsAttendantSelfIntroduction("Val Souza", saudacaoVal)).toBe(true);
  });

  it("reconhece outras formas de apresentação", () => {
    expect(nameIsAttendantSelfIntroduction("Ana", ["Oi! Meu nome é Ana, como posso ajudar?"])).toBe(
      true,
    );
    expect(nameIsAttendantSelfIntroduction("Sarah", ["Oi! Sou a Sarah, da Costa Lima."])).toBe(true);
  });

  it("NÃO descarta o nome real do lead", () => {
    expect(nameIsAttendantSelfIntroduction("Maria de Fátima", saudacaoVal)).toBe(false);
    expect(nameIsAttendantSelfIntroduction("Neymar Junior", saudacaoVal)).toBe(false);
  });

  it("sem apresentação no histórico, nada é descartado", () => {
    expect(nameIsAttendantSelfIntroduction("Val", ["Bom dia! Como posso ajudar?"])).toBe(false);
    expect(nameIsAttendantSelfIntroduction("", saudacaoVal)).toBe(false);
  });

  it("attendantSelfIntroducedNames coleta os nomes em minúsculas", () => {
    expect([...attendantSelfIntroducedNames(saudacaoVal)]).toEqual(["val"]);
  });
});

// ── pergunta que É escolha (caso Marco, Odonto Carioca 21 97457-6765) ──────
// "Consegue confirmar uma avaliação para amanhã às 09:15?" cita dia + horário
// ofertados; o "?" final é cortesia, não indecisão. O gate de pergunta zerava
// a auto-seleção → criar_agendamento falhava por slot ausente → o agente
// re-oferecia os MESMOS horários e um humano teve que assumir (03/08/2026).

describe("tryAutoSelectOfferedSlot — pergunta educada que cita horário ofertado", () => {
  const slot = (iso: string, dl: string, tl: string) => ({
    iso,
    end_iso: iso,
    date_label: dl,
    time_label: tl,
  });
  // Datas DINÂMICAS: as frases usam "amanhã", então o slot pedido PRECISA cair
  // amanhã de verdade. A versão original fixava 04/08 e passava só no dia em
  // que foi escrita — no dia seguinte "amanhã" resolvia pra outra data e o
  // teste quebrava sem regressão nenhuma no código (bomba-relógio de data).
  const DAY = 86_400_000;
  const brtDate = (msOffset: number) =>
    new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(
      new Date(Date.now() + msOffset),
    );
  const brtLabel = (isoDay: string) => {
    const d = new Date(`${isoDay}T12:00:00-03:00`);
    const weekday = new Intl.DateTimeFormat("pt-BR", {
      timeZone: "America/Sao_Paulo",
      weekday: "long",
    }).format(d);
    const ddmm = new Intl.DateTimeFormat("pt-BR", {
      timeZone: "America/Sao_Paulo",
      day: "2-digit",
      month: "2-digit",
    }).format(d);
    return `${weekday}, ${ddmm}`;
  };
  const AMANHA = brtDate(DAY);
  const DEPOIS = brtDate(2 * DAY);
  const ISO_ALVO = `${AMANHA}T09:15:00-03:00`;
  const SLOTS = [
    slot(ISO_ALVO, brtLabel(AMANHA), "09:15"),
    slot(`${AMANHA}T11:00:00-03:00`, brtLabel(AMANHA), "11:00"),
    slot(`${DEPOIS}T09:00:00-03:00`, brtLabel(DEPOIS), "09:00"),
  ];
  const OFERTA = `Consegui dois horários: • ${brtLabel(AMANHA)} às 09:15 • ${brtLabel(DEPOIS)} às 09:00 Qual fica melhor?`;
  const escolher = (msg: string, slots = SLOTS, oferta = OFERTA) =>
    tryAutoSelectOfferedSlot(
      "SLOT_OFFER",
      { offered_slots: slots as never },
      [
        { role: "assistant", content: oferta },
        { role: "user", content: msg },
      ],
    ).selected_slot_iso;

  it("a frase real do lead seleciona o slot pedido", () => {
    expect(escolher("Consegue confirmar uma avaliação para amanhã às 09:15?")).toBe(ISO_ALVO);
  });

  it("outras perguntas educadas com horário ofertado também selecionam", () => {
    expect(escolher("pode ser às 09:15?")).toBe(ISO_ALVO);
    expect(escolher("dá pra marcar amanhã às 09:15?")).toBe(ISO_ALVO);
  });

  it("sem o '?' o comportamento é o mesmo (não dependia da pontuação)", () => {
    expect(escolher("Consegue confirmar uma avaliação para amanhã às 09:15")).toBe(ISO_ALVO);
  });

  // NÃO-REGRESSÃO: pergunta ABERTA continua sendo pedido de opções, nunca
  // escolha (caso Costa Lima Recreio, Luciano 32 99160-7088, 15/07).
  const TARDE = [
    slot("2026-08-04T13:00:00-03:00", "terça-feira, 04/08", "13:00"),
    slot("2026-08-04T16:45:00-03:00", "terça-feira, 04/08", "16:45"),
  ];
  const OFERTA_TARDE = "Tenho terça-feira, 04/08 às 13:00 ou às 16:45. Qual prefere?";

  it("pergunta aberta (sem horário ofertado citado) NÃO seleciona", () => {
    for (const m of [
      "eu trabalho até esse horário, tem mais tarde?",
      "tem outro dia?",
      "tem algum de manhã?",
      "e de manhã?",
      "tem mais tarde?",
    ]) {
      expect(escolher(m, TARDE, OFERTA_TARDE), m).toBeUndefined();
    }
  });

  it("'tem outro/mais' barra mesmo citando horário ofertado", () => {
    expect(escolher("tem outro horário além das 13:00?", TARDE, OFERTA_TARDE)).toBeUndefined();
  });
});

// ── frase de correção não pode virar nome do paciente ──────────────────────
// Caso real (Odonto Carioca Campo Grande, 21 97558-2703, 03/08): o lead
// corrigiu "Pedi pra amanhã" e isso virou lead_data.name. O validador rejeitava
// na hora de agendar, o agente repetia "me envia seu nome completo" e a conversa
// entrou em loop — inclusive depois de ele mandar "Antonio Fagundes".

describe("looksLikeSentenceNotName", () => {
  const FRASES = [
    "Pedi pra amanhã",
    "não quinta feira",
    "Quero saber qual dia ta agendado?",
    "Mas eu quero saber pra qual dia ?",
    "porque eu pedi pra agendar amanhã",
    "e você ta falando quinta feira",
    "Não consigo hoje não",
    "Hoje não consigo",
    "Só na próxima  semana",
    "Tá bem",
  ];
  for (const f of FRASES) {
    it(`rejeita: ${JSON.stringify(f.slice(0, 34))}`, () => {
      expect(looksLikeSentenceNotName(f) || mentionsUnavailability(f) || looksLikeSchedulingPreference(f) || looksLikeIntentMessage(f)).toBe(true);
    });
  }

  const NOMES = [
    "Antonio Fagundes",
    "Marco Antônio Silva da cruz",
    "Solange",
    "Sophia Vicente",
    "Sonha Maria Ribeiro de Lima",
    "Solineide",
    "Maria de Fátima",
    "Ana Beatriz do Nascimento",
    "José Carlos",
    "Neymar Junior",
  ];
  for (const n of NOMES) {
    it(`aceita nome real: ${JSON.stringify(n)}`, () => {
      expect(looksLikeSentenceNotName(n)).toBe(false);
    });
  }
});

describe("sanitizeLeadDataPatch — nome contaminado", () => {
  it("descarta a frase de correção do caso real", () => {
    expect(sanitizeLeadDataPatch({ name: "Pedi pra amanhã" }).name).toBeUndefined();
  });
  it("descarta indisponibilidade (mentionsUnavailability já existia, faltava usar)", () => {
    expect(sanitizeLeadDataPatch({ name: "Hoje não consigo" }).name).toBeUndefined();
    expect(sanitizeLeadDataPatch({ name: "Não consigo hoje não" }).name).toBeUndefined();
  });
  it("preserva o nome verdadeiro", () => {
    expect(sanitizeLeadDataPatch({ name: "Antonio Fagundes" }).name).toBe("Antonio Fagundes");
    expect(sanitizeLeadDataPatch({ name: "Marco Antônio Silva da cruz" }).name).toBe(
      "Marco Antônio Silva da cruz",
    );
  });
});

describe("looksLikeSentenceNotName — fronteira ciente de acento", () => {
  // O \b do JS é ASCII: em "Manhães" ele vê limite depois do "ã" e `\bmanhã\b`
  // casaria DENTRO do sobrenome. Descoberto varrendo os 2.684 nomes reais de
  // produção — "Silvia Manhães" era reprovado como se fosse frase.
  it("sobrenome com acento não vira frase", () => {
    expect(looksLikeSentenceNotName("Silvia Manhães")).toBe(false);
    expect(looksLikeSentenceNotName("Manhães")).toBe(false);
  });
  it("mas a palavra inteira continua sendo pega", () => {
    expect(looksLikeSentenceNotName("só de manhã")).toBe(true);
    expect(looksLikeSentenceNotName("amanhã não dá")).toBe(true);
  });
});

// ── gesto de apontar: AMBÍGUO, nunca escolhe sozinho ──────────────────────
// Caso real (Odonto Carioca Campo Grande, 21 97558-2703, 03/08): o lead pediu
// "amanhã às 09:15", ouviu que não tinha, e respondeu "👆👆" querendo dizer
// "eu pedi AMANHÃ". A IA leu como "a primeira opção que você ofereceu",
// travou quinta 06/08 09:00 e seguiu para o nome.

describe("isPointingGesture", () => {
  it("reconhece as formas do gesto", () => {
    for (const m of ["☝🏼", "👆👆", "☝️", "☝", "👆", "👆🏼", "🔝", "esse ☝🏼", "☝🏼 sim", "isso ☝️"]) {
      expect(isPointingGesture(m), m).toBe(true);
    }
  });
  it("NÃO confunde com mensagem que tem conteúdo próprio", () => {
    for (const m of ["o primeiro ☝🏼", "☝🏼 mas às 14h", "quero o de terça ☝🏼", "amanhã às 09:15"]) {
      expect(isPointingGesture(m), m).toBe(false);
    }
  });
  it("texto sem emoji nunca é gesto", () => {
    expect(isPointingGesture("esse")).toBe(false);
    expect(isPointingGesture("")).toBe(false);
  });
  it("é idempotente (regex /g não vaza lastIndex)", () => {
    for (let i = 0; i < 5; i++) expect(isPointingGesture("☝🏼")).toBe(true);
  });
});

describe("tryAutoSelectOfferedSlot — gesto NUNCA seleciona", () => {
  const slot = (iso: string, dl: string, tl: string) => ({ iso, end_iso: iso, date_label: dl, time_label: tl });
  const A = slot("2026-08-06T09:00:00-03:00", "quinta-feira, 06/08", "09:00");
  const B = slot("2026-08-06T10:15:00-03:00", "quinta-feira, 06/08", "10:15");
  const escolher = (msg: string, oferta: string, slots = [A, B]) =>
    tryAutoSelectOfferedSlot("SLOT_OFFER", { offered_slots: slots as never }, [
      { role: "assistant", content: oferta },
      { role: "user", content: msg },
    ]).selected_slot_iso;

  it("com DOIS horários não seleciona", () => {
    const of = "Consegui na quinta-feira, 06/08: às 09:00 ou às 10:15. Qual fica melhor?";
    expect(escolher("👆👆", of)).toBeUndefined();
  });

  // A diferença para a 1ª versão deste PR: antes, com UM horário, o gesto era
  // aceito. O caso real mostrou que ele pode apontar para o pedido do LEAD.
  it("com UM horário TAMBÉM não seleciona (ambíguo mesmo assim)", () => {
    const of = "Tenho quinta-feira, 06/08 às 09:00. Fica bom?";
    expect(escolher("☝🏼", of, [A])).toBeUndefined();
  });

  it("ordinal junto do emoji continua resolvendo pela palavra", () => {
    const of = "Consegui na quinta-feira, 06/08: às 09:00 ou às 10:15. Qual fica melhor?";
    expect(escolher("o primeiro ☝🏼", of)).toBe("2026-08-06T09:00:00-03:00");
  });
});

describe("pointingConfirmationReply", () => {
  const slot = (dl: string, tl: string) => ({ iso: "x", end_iso: "x", date_label: dl, time_label: tl });
  it("UM horário vira confirmação fechada", () => {
    const r = pointingConfirmationReply([slot("quinta-feira, 06/08", "09:00")] as never)!;
    expect(r).toContain("quinta-feira, 06/08 às 09:00");
    expect(r).toContain("?");
  });
  it("DOIS viram escolha entre eles", () => {
    const r = pointingConfirmationReply([
      slot("quinta-feira, 06/08", "09:00"),
      slot("quinta-feira, 06/08", "10:15"),
    ] as never)!;
    expect(r).toContain("09:00");
    expect(r).toContain("10:15");
    expect(r).toContain(" ou ");
  });
  it("sem horário para nomear devolve null", () => {
    expect(pointingConfirmationReply([])).toBeNull();
  });
  it("nunca é a pergunta genérica que travou o atendimento", () => {
    const r = pointingConfirmationReply([slot("quinta-feira, 06/08", "09:00")] as never)!;
    expect(r).not.toContain("seguir com o agendamento agora");
  });
});
