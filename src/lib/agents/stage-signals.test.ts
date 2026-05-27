// Testes unitarios da camada deterministica de stage transitions.
// Protege contra regressoes onde o LLM "trava" no mesmo stage e nao avanca,
// ou onde o lead aceita agendar mas o agente continua repetindo o pitch.

import { describe, expect, it } from "vitest";

import type { LeadData } from "./stage";
import {
  applyDeterministicStageOverrides,
  detectSignals,
  inferEffectiveStage,
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
