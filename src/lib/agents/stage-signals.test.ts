// Testes unitarios da camada deterministica de stage transitions.
// Protege contra regressoes onde o LLM "trava" no mesmo stage e nao avanca,
// ou onde o lead aceita agendar mas o agente continua repetindo o pitch.

import { describe, expect, it } from "vitest";

import type { LeadData } from "./stage";
import {
  applyDeterministicStageOverrides,
  detectSignals,
  inferEffectiveStage,
  isShortAffirmative,
  looksLikeStallReply,
  type StageSignalsContext,
} from "./stage-signals";

const baseCtx = (overrides: Partial<StageSignalsContext> = {}): StageSignalsContext => ({
  stage: "QUALIFICATION",
  leadData: {},
  history: [],
  hasBookingIntegration: true,
  ...overrides,
});

// ── detectSignals ─────────────────────────────────────────────────────────

describe("detectSignals", () => {
  it("retorna strings vazias quando historico vazio", () => {
    const s = detectSignals(baseCtx());
    expect(s.lastUserMsg).toBe("");
    expect(s.lastAssistantMsg).toBe("");
    expect(s.slotSelectionTurn).toBe(false);
    expect(s.lastAssistantProposedScheduling).toBe(false);
    expect(s.isShortYes).toBe(false);
    expect(s.userAcceptedSchedulingProposal).toBe(false);
  });

  it("detecta proposta de agendamento do assistente", () => {
    const s = detectSignals(
      baseCtx({
        history: [
          { role: "assistant", content: "Posso te agendar uma visita?" },
          { role: "user", content: "sim" },
        ],
      }),
    );
    expect(s.lastAssistantProposedScheduling).toBe(true);
    expect(s.isShortYes).toBe(true);
    expect(s.userAcceptedSchedulingProposal).toBe(true);
  });

  it("NAO marca userAcceptedSchedulingProposal fora de QUALIFICATION", () => {
    const s = detectSignals(
      baseCtx({
        stage: "SLOT_OFFER",
        history: [
          { role: "assistant", content: "Posso te agendar uma visita?" },
          { role: "user", content: "sim" },
        ],
      }),
    );
    expect(s.userAcceptedSchedulingProposal).toBe(false);
  });

  it("NAO marca aceitacao quando user nao diz sim curto", () => {
    const s = detectSignals(
      baseCtx({
        history: [
          { role: "assistant", content: "Posso te agendar?" },
          { role: "user", content: "Antes preciso saber o valor" },
        ],
      }),
    );
    expect(s.lastAssistantProposedScheduling).toBe(true);
    expect(s.isShortYes).toBe(false);
    expect(s.userAcceptedSchedulingProposal).toBe(false);
  });

  it("detecta slotSelectionTurn em preferencia de manha", () => {
    const s = detectSignals(
      baseCtx({
        stage: "SLOT_OFFER",
        history: [
          { role: "assistant", content: "Que turno prefere?" },
          { role: "user", content: "manhã" },
        ],
      }),
    );
    expect(s.slotSelectionTurn).toBe(true);
  });

  it("NAO marca slotSelectionTurn em data de nascimento", () => {
    const s = detectSignals(
      baseCtx({
        stage: "NAME_COLLECT",
        history: [
          { role: "assistant", content: "Qual a data de nascimento?" },
          { role: "user", content: "25/07/2019" },
        ],
      }),
    );
    expect(s.slotSelectionTurn).toBe(false);
  });

  it("detecta pedido de disponibilidade com data em RECEPTION", () => {
    const s = detectSignals(
      baseCtx({
        stage: "RECEPTION",
        history: [
          { role: "assistant", content: "Como posso te ajudar com a sua festa?" },
          { role: "user", content: "Quero saber se tem disponibilidade para o dia 25/07" },
        ],
      }),
    );
    expect(s.userAskedDateAvailability).toBe(true);
  });

  it("detecta pedido de disponibilidade com data por extenso em QUALIFICATION", () => {
    const s = detectSignals(
      baseCtx({
        stage: "QUALIFICATION",
        history: [{ role: "user", content: "Tem data livre dia 25 de julho?" }],
      }),
    );
    expect(s.userAskedDateAvailability).toBe(true);
  });

  it("NAO marca disponibilidade para data de nascimento", () => {
    const s = detectSignals(
      baseCtx({
        stage: "QUALIFICATION",
        history: [
          { role: "assistant", content: "Qual a data de nascimento da criança?" },
          { role: "user", content: "25/07/2019" },
        ],
      }),
    );
    expect(s.userAskedDateAvailability).toBe(false);
  });

  it("NAO marca disponibilidade fora de RECEPTION/QUALIFICATION", () => {
    const s = detectSignals(
      baseCtx({
        stage: "SLOT_OFFER",
        history: [{ role: "user", content: "tem disponibilidade dia 25/07?" }],
      }),
    );
    expect(s.userAskedDateAvailability).toBe(false);
  });

  it("NAO marca disponibilidade em mensagem comum de qualificacao", () => {
    const s = detectSignals(
      baseCtx({
        stage: "QUALIFICATION",
        history: [{ role: "user", content: "Quero uma festa para 150 convidados" }],
      }),
    );
    expect(s.userAskedDateAvailability).toBe(false);
  });
});

// ── inferEffectiveStage ───────────────────────────────────────────────────

describe("inferEffectiveStage", () => {
  it("forca SLOT_OFFER quando user aceita proposta de agendamento", () => {
    const ctx = baseCtx({
      stage: "QUALIFICATION",
      history: [
        { role: "assistant", content: "Posso te agendar?" },
        { role: "user", content: "sim" },
      ],
    });
    const signals = detectSignals(ctx);
    const res = inferEffectiveStage(ctx, signals, false);
    expect(res.effectiveStage).toBe("SLOT_OFFER");
    expect(res.reason).toBe("lead_accepted_scheduling_proposal");
  });

  it("NAO forca SLOT_OFFER se nao ha integracao de agendamento", () => {
    const ctx = baseCtx({
      stage: "QUALIFICATION",
      hasBookingIntegration: false,
      history: [
        { role: "assistant", content: "Posso te agendar?" },
        { role: "user", content: "sim" },
      ],
    });
    const signals = detectSignals(ctx);
    const res = inferEffectiveStage(ctx, signals, false);
    expect(res.effectiveStage).toBe("QUALIFICATION");
  });

  it("roteia RECEPTION → SLOT_OFFER quando lead pergunta disponibilidade de data", () => {
    const ctx = baseCtx({
      stage: "RECEPTION",
      history: [
        { role: "assistant", content: "Como posso te ajudar com a sua festa?" },
        { role: "user", content: "Quero saber se tem disponibilidade para o dia 25/07" },
      ],
    });
    const res = inferEffectiveStage(ctx, detectSignals(ctx), false);
    expect(res.effectiveStage).toBe("SLOT_OFFER");
    expect(res.reason).toBe("lead_asked_date_availability");
  });

  it("NAO roteia pedido de data quando ja existe appointment_id", () => {
    const ctx = baseCtx({
      stage: "QUALIFICATION",
      leadData: { appointment_id: "evt123" },
      history: [{ role: "user", content: "tem disponibilidade dia 25/07?" }],
    });
    const res = inferEffectiveStage(ctx, detectSignals(ctx), false);
    expect(res.effectiveStage).toBe("QUALIFICATION");
  });

  it("avanca SLOT_OFFER → NAME_COLLECT quando slot ja foi escolhido", () => {
    const ctx = baseCtx({
      stage: "SLOT_OFFER",
      leadData: { selected_slot_iso: "2026-06-03T18:20:00.000Z" },
    });
    const res = inferEffectiveStage(ctx, detectSignals(ctx), false);
    expect(res.effectiveStage).toBe("NAME_COLLECT");
    expect(res.reason).toBe("slot_already_selected");
  });

  it("volta NAME_COLLECT → SLOT_OFFER se perdeu o slot", () => {
    const ctx = baseCtx({ stage: "NAME_COLLECT", leadData: {} });
    const res = inferEffectiveStage(ctx, detectSignals(ctx), false);
    expect(res.effectiveStage).toBe("SLOT_OFFER");
    expect(res.reason).toBe("name_collect_without_slot");
  });

  it("avanca para BOOKING quando isReadyForBooking=true", () => {
    const ctx = baseCtx({
      stage: "NAME_COLLECT",
      leadData: { selected_slot_iso: "2026-06-03T18:20:00.000Z" },
    });
    const res = inferEffectiveStage(ctx, detectSignals(ctx), true);
    expect(res.effectiveStage).toBe("BOOKING");
    expect(res.reason).toBe("all_fields_collected");
  });

  it("QUALIFICATION com slot já escolhido → NAME_COLLECT (scheduler assume)", () => {
    const ctx = baseCtx({
      stage: "QUALIFICATION",
      leadData: { selected_slot_iso: "2026-08-21T19:00:00-03:00" },
    });
    const res = inferEffectiveStage(ctx, detectSignals(ctx), false);
    expect(res.effectiveStage).toBe("NAME_COLLECT");
    expect(res.reason).toBe("slot_selected_before_slot_offer");
  });

  it("slot LIMPO (sentinela \"\") não promove QUALIFICATION", () => {
    const ctx = baseCtx({
      stage: "QUALIFICATION",
      leadData: { selected_slot_iso: "" },
    });
    const res = inferEffectiveStage(ctx, detectSignals(ctx), false);
    expect(res.effectiveStage).toBe("QUALIFICATION");
  });

  it("QUALIFICATION com slot mas SEM agenda não promove", () => {
    const ctx = baseCtx({
      stage: "QUALIFICATION",
      hasBookingIntegration: false,
      leadData: { selected_slot_iso: "2026-08-21T19:00:00-03:00" },
    });
    const res = inferEffectiveStage(ctx, detectSignals(ctx), false);
    expect(res.effectiveStage).toBe("QUALIFICATION");
  });

  it("mantem stage original em casos sem sinais", () => {
    const ctx = baseCtx({ stage: "RECEPTION" });
    const res = inferEffectiveStage(ctx, detectSignals(ctx), false);
    expect(res.effectiveStage).toBe("RECEPTION");
  });
});

// ── applyDeterministicStageOverrides ──────────────────────────────────────

describe("applyDeterministicStageOverrides", () => {
  const slotSelectedLead: LeadData = { selected_slot_iso: "2026-06-03T18:20:00.000Z" };

  it("forca SLOT_OFFER quando LLM trava em QUALIFICATION apos aceite", () => {
    const ctx = baseCtx({
      stage: "QUALIFICATION",
      history: [
        { role: "assistant", content: "Posso te agendar?" },
        { role: "user", content: "sim" },
      ],
    });
    const signals = detectSignals(ctx);
    const res = applyDeterministicStageOverrides({
      proposedNextStage: "QUALIFICATION",
      originalStage: "QUALIFICATION",
      effectiveStage: "SLOT_OFFER",
      leadData: {},
      hasBookingIntegration: true,
      signals,
    });
    expect(res.stage).toBe("SLOT_OFFER");
    expect(res.reason).toBe("force_slot_offer_after_accept");
  });

  it("persiste SLOT_OFFER apos pedido de data mesmo vindo de RECEPTION", () => {
    const ctx = baseCtx({
      stage: "RECEPTION",
      history: [
        { role: "assistant", content: "Como posso te ajudar com a sua festa?" },
        { role: "user", content: "Quero saber se tem disponibilidade para o dia 25/07" },
      ],
    });
    const signals = detectSignals(ctx);
    // resolveNextStage bloqueia RECEPTION → SLOT_OFFER e devolve RECEPTION;
    // o override deterministico precisa forcar o avanco.
    const res = applyDeterministicStageOverrides({
      proposedNextStage: "RECEPTION",
      originalStage: "RECEPTION",
      effectiveStage: "SLOT_OFFER",
      leadData: {},
      hasBookingIntegration: true,
      signals,
    });
    expect(res.stage).toBe("SLOT_OFFER");
    expect(res.reason).toBe("force_slot_offer_after_date_ask");
  });

  it("avanca SLOT_OFFER → NAME_COLLECT quando slot foi selecionado", () => {
    const res = applyDeterministicStageOverrides({
      proposedNextStage: "SLOT_OFFER",
      originalStage: "SLOT_OFFER",
      effectiveStage: "SLOT_OFFER",
      leadData: slotSelectedLead,
      hasBookingIntegration: true,
      signals: detectSignals(baseCtx()),
    });
    expect(res.stage).toBe("NAME_COLLECT");
    expect(res.reason).toBe("slot_selected_advance_to_name_collect");
  });

  it("forca CONFIRMED quando appointment_id ja foi criado", () => {
    const res = applyDeterministicStageOverrides({
      proposedNextStage: "BOOKING",
      originalStage: "BOOKING",
      effectiveStage: "BOOKING",
      leadData: { ...slotSelectedLead, appointment_id: "abc123" },
      hasBookingIntegration: true,
      signals: detectSignals(baseCtx()),
    });
    expect(res.stage).toBe("CONFIRMED");
    expect(res.reason).toBe("appointment_created_advance_to_confirmed");
  });

  it("NAO forca CONFIRMED quando ha remarcacao pendente (selected_slot_iso != booked_slot_iso) — caso Clinica Bomfim 09/07", () => {
    // O guard do scheduler bloqueou uma "confirmacao fantasma" (LLM disse
    // "reservado pra 15/07" sem chamar remarcar_agendamento) e devolveu
    // proposedNextStage=SLOT_OFFER. Sem esta trava, este override empurraria
    // o stage de volta pra CONFIRMED so por appointment_id existir, ignorando
    // que a agenda real ainda esta no horario ANTIGO (booked_slot_iso).
    const res = applyDeterministicStageOverrides({
      proposedNextStage: "SLOT_OFFER",
      originalStage: "SLOT_OFFER",
      effectiveStage: "SLOT_OFFER",
      leadData: {
        appointment_id: "abc123",
        booked_slot_iso: "2026-07-09T15:00:00-03:00", // horario REAL na agenda (hoje)
        selected_slot_iso: "2026-07-15T15:30:00-03:00", // horario que o LLM alegou (quarta 15/07)
      },
      hasBookingIntegration: true,
      signals: detectSignals(baseCtx()),
    });
    expect(res.stage).toBe("SLOT_OFFER");
  });

  it("forca CONFIRMED normalmente quando selected_slot_iso bate com booked_slot_iso", () => {
    const res = applyDeterministicStageOverrides({
      proposedNextStage: "BOOKING",
      originalStage: "BOOKING",
      effectiveStage: "BOOKING",
      leadData: {
        appointment_id: "abc123",
        booked_slot_iso: "2026-07-09T15:00:00-03:00",
        selected_slot_iso: "2026-07-09T15:00:00-03:00",
      },
      hasBookingIntegration: true,
      signals: detectSignals(baseCtx()),
    });
    expect(res.stage).toBe("CONFIRMED");
  });

  it("volta NAME_COLLECT → SLOT_OFFER se o LLM tentou avancar sem slot", () => {
    const res = applyDeterministicStageOverrides({
      proposedNextStage: "NAME_COLLECT",
      originalStage: "SLOT_OFFER",
      effectiveStage: "NAME_COLLECT",
      leadData: {},
      hasBookingIntegration: true,
      signals: detectSignals(baseCtx()),
    });
    expect(res.stage).toBe("SLOT_OFFER");
    expect(res.reason).toBe("name_collect_requires_slot");
  });

  it("nao altera stage quando nenhuma regra dispara", () => {
    const res = applyDeterministicStageOverrides({
      proposedNextStage: "QUALIFICATION",
      originalStage: "QUALIFICATION",
      effectiveStage: "QUALIFICATION",
      leadData: {},
      hasBookingIntegration: true,
      signals: detectSignals(baseCtx()),
    });
    expect(res.stage).toBe("QUALIFICATION");
    expect(res.reason).toBeUndefined();
  });
});

// ── looksLikeStallReply ───────────────────────────────────────────────────

describe("looksLikeStallReply", () => {
  // Casos reais do bug SLOT_OFFER→BOOKING (lead some apos escolher horario).
  const stalls = [
    "Fabíola, vou finalizar seu cadastro rapidinho aqui.",
    "Só um instante, por favor. 😊",
    "Fabíola, vou criar seu cadastro aqui rapidinho para confirmar tudo certinho. 😊",
    "Tô finalizando seu agendamento aqui, já te confirmo.",
    "Deixa eu organizar tudo certinho aqui, um momentinho.",
    "Estou registrando seus dados, aguarde um instante.",
    "Já te retorno com a confirmação.",
    "Vou cadastrar você no sistema rapidinho.",
    // Caso real 09/07 (Costa Lima Recreio): lead pediu outra semana, o agente
    // prometeu "vou verificar" sem chamar listar_horarios — conversa morreu.
    "Sem problemas! Vou verificar a agenda para a próxima semana. 😊",
    "Já verifico os horários da semana que vem pra você.",
    "Estou checando a agenda, um momento.",
    "Vou consultar a agenda e já te aviso.",
    // Caso real 13/07 (MF Beauty BSB, Maria de Fátima): promessa de reserva +
    // confirmação futura sem agendar nada — a lead achou que estava agendada.
    "Já vou deixar tudo reservado por aqui e logo te envio a confirmação!",
    "Vou deixar tudo reservado para você.",
    "Pode deixar que logo te envio a confirmação do seu horário.",
    "Perfeito! Te mando a confirmação assim que estiver tudo certo.",
    // Caso real 15/07 (Costa Lima Recreio, Luciano): "vou buscar" + "instantinho"
    // não eram detectados — o agente prometeu buscar a tarde e não trouxe nada.
    "Como você trabalha pela manhã, vou buscar as opções da tarde. Só um instantinho.",
    "Vou buscar os horários disponíveis pra você.",
    "Deixa eu dar uma olhada na agenda aqui.",
    "Só um instantinho que já te trago as opções.",
    "Vou procurar um horário mais tarde pra você.",
    // Caso real 23/07 (Odonto Carioca Campo Grande, 21 98817-7687): o fecho
    // retórico "tá bem?" no fim fazia o "?" desarmar o guard — a promessa saiu
    // sem chamar listar_horarios e a conversa morreu.
    "Entendo perfeitamente! Sábado pode ser mais tranquilo para você. Deixa eu verificar a disponibilidade de sábado e já te mostro os horários que temos, tá bem?",
    "Deixa eu verificar a agenda e já te retorno, ok?",
    "Vou consultar os horários pra você, tudo bem?",
    "Só um instantinho, certo?",
    "Vou buscar as opções da tarde, combinado?",
    "Já te confirmo o horário, beleza?",
    "Vou dar uma olhada na agenda, pode ser?",
  ];
  for (const r of stalls) {
    it(`detecta stall: ${JSON.stringify(r.slice(0, 40))}`, () => {
      expect(looksLikeStallReply(r)).toBe(true);
    });
  }

  // Replies legitimos: perguntam algo (progresso) ou dao informacao concreta.
  const naoStall = [
    "Perfeito! Anotei o horário. Qual o seu nome completo?",
    "Posso garantir esse horário pra você?",
    "Seu agendamento está confirmado para terça às 14h! 🎉",
    "Temos horários terça às 14h ou quinta às 10h. Qual prefere?",
    "Claro! O endereço é Rua das Flores, 123.",
    "",
    // Pergunta REAL continua sendo progresso mesmo com fecho retórico junto:
    // o "?" que importa é o da pergunta, não o do "tá bem?".
    "Tenho terça às 14h ou quinta às 10h. Qual prefere, tá bem?",
    "Vou precisar do seu nome completo. Pode me informar, por favor?",
    // Só o fecho retórico, sem promessa nenhuma → não é stall.
    "Tá bem?",
    "Ok?",
    // PEDIDO IMPERATIVO sem "?" — progresso, nao enrolacao. Varias clinicas
    // escrevem assim no proprio prompt. Caso real (MF Beauty Mage, 28/07): o
    // guard trocava esta resposta CERTA por um texto generico que ignorava o
    // dado faltante e mandava o lead adivinhar a agenda.
    "Me passa seu nome completo, por favor, que eu já consulto os horários disponíveis pra você.",
    "Perfeito ✨ Me passa seu nome completo e seu WhatsApp com DDD, por favor, que eu já consulto os horários.",
    "Anotei, Maria. Só me confirma seu WhatsApp com DDD, por favor, pra eu deixar seu horário registrado certinho.",
    "Me manda seu nome completo que eu já vou verificar a agenda.",
    "Pode me passar seu WhatsApp com DDD, por favor.",
  ];
  for (const r of naoStall) {
    it(`NAO marca: ${JSON.stringify(r.slice(0, 40))}`, () => {
      expect(looksLikeStallReply(r)).toBe(false);
    });
  }
});

// ── isShortAffirmative ────────────────────────────────────────────────────

describe("isShortAffirmative", () => {
  // A versao antiga era ancorada em UMA palavra: "quero sim" (a forma mais
  // natural em pt-BR) nao casava e o repasse pro scheduler morria.
  // Caso real: MF Beauty Mage, ig:olucianodev, 28/07.
  const afirmativas = [
    "sim",
    "Sim!",
    "quero sim",
    "Quero sim",
    "pode sim",
    "sim, quero",
    "claro que sim",
    "quero ver",
    "pode ser",
    "com certeza",
    "por favor",
    "ok",
    "beleza",
    "perfeito",
    "vamos",
    "isso",
    "uhum",
    "sim 😊",
    "quero sim!!",
  ];
  for (const m of afirmativas) {
    it(`aceita: ${JSON.stringify(m)}`, () => {
      expect(isShortAffirmative(m)).toBe(true);
    });
  }

  // Conservador: um falso positivo empurra o lead pro agendamento cedo demais.
  const naoAfirmativas = [
    "",
    "nao",
    "não",
    "claro que não",
    "quero saber o preço",
    "quero cancelar",
    "quanto custa",
    "sim, mas quanto custa antes de eu decidir",
    "pode me explicar melhor",
    "ok mas preciso pensar",
    "quero remarcar",
    "amanhã",
    "de manhã",
  ];
  for (const m of naoAfirmativas) {
    it(`recusa: ${JSON.stringify(m)}`, () => {
      expect(isShortAffirmative(m)).toBe(false);
    });
  }
});

// ── Repasse qualifier → scheduler (regressao MF Beauty Mage 28/07) ────────

describe("proposta de CONSULTAR a agenda (nao so 'posso agendar?')", () => {
  // O CTA padrao do prompt da MF Beauty ("Quer que eu veja os horarios
  // disponiveis?") nao casava com NENHUMA alternativa do regex antigo, entao
  // userAcceptedSchedulingProposal era sempre false e o lead ficava preso no
  // qualifier, que nao tinha tool de agenda.
  const propostas = [
    "Quer que eu veja os horários disponíveis?",
    "Quer que eu veja os horários disponíveis para você?",
    "Quer que eu consulte os horários?",
    "Posso verificar aqui os próximos horários com voucher liberado.",
    "Se quiser, eu já posso consultar os 2 próximos horários.",
    "Quer que eu veja um bom horário pra você?",
    "Quer que eu consulte a agenda?",
    "Posso ver a disponibilidade pra você?",
  ];
  for (const p of propostas) {
    it(`reconhece proposta: ${JSON.stringify(p.slice(0, 45))}`, () => {
      const s = detectSignals(
        baseCtx({
          history: [
            { role: "assistant", content: p },
            { role: "user", content: "Quero sim" },
          ],
        }),
      );
      expect(s.lastAssistantProposedScheduling).toBe(true);
      expect(s.isShortYes).toBe(true);
      expect(s.userAcceptedSchedulingProposal).toBe(true);
    });
  }

  it("promove para SLOT_OFFER (o cenario exato do bug)", () => {
    const ctx = baseCtx({
      history: [
        {
          role: "assistant",
          content:
            "Estamos liberando alguns vouchers para avaliação gratuita. Quer que eu veja os horários disponíveis?",
        },
        { role: "user", content: "Quero sim" },
      ],
    });
    const signals = detectSignals(ctx);
    const out = inferEffectiveStage(ctx, signals, false);
    expect(out.effectiveStage).toBe("SLOT_OFFER");
    expect(out.reason).toBe("lead_accepted_scheduling_proposal");
  });

  it("tambem promove a partir de RECEPTION (proposta na saudacao)", () => {
    const ctx = baseCtx({
      stage: "RECEPTION",
      history: [
        { role: "assistant", content: "Oi! Quer que eu veja os horários disponíveis?" },
        { role: "user", content: "pode sim" },
      ],
    });
    const signals = detectSignals(ctx);
    expect(signals.userAcceptedSchedulingProposal).toBe(true);
    expect(inferEffectiveStage(ctx, signals, false).effectiveStage).toBe("SLOT_OFFER");
    // E o override persiste o avanco (RECEPTION → SLOT_OFFER e bloqueado na
    // tabela de transicoes, entao resolveNextStage devolve RECEPTION).
    const override = applyDeterministicStageOverrides({
      proposedNextStage: "RECEPTION",
      originalStage: "RECEPTION",
      effectiveStage: "SLOT_OFFER",
      leadData: {},
      hasBookingIntegration: true,
      signals,
    });
    expect(override.stage).toBe("SLOT_OFFER");
    expect(override.reason).toBe("force_slot_offer_after_accept");
  });

  it("NAO promove quando o lead so pediu preco", () => {
    const ctx = baseCtx({
      history: [
        { role: "assistant", content: "Quer que eu veja os horários disponíveis?" },
        { role: "user", content: "quanto custa" },
      ],
    });
    expect(detectSignals(ctx).userAcceptedSchedulingProposal).toBe(false);
  });

  it("NAO promove sem integracao de agenda", () => {
    const ctx = baseCtx({
      hasBookingIntegration: false,
      history: [
        { role: "assistant", content: "Quer que eu veja os horários disponíveis?" },
        { role: "user", content: "quero sim" },
      ],
    });
    const signals = detectSignals(ctx);
    expect(signals.userAcceptedSchedulingProposal).toBe(true);
    expect(inferEffectiveStage(ctx, signals, false).effectiveStage).toBe("QUALIFICATION");
  });
});
