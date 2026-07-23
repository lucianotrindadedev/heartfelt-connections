import { describe, expect, it } from "vitest";

import {
  shouldResumeSlotOffer,
  RETOMADA_DEFAULTS,
  type RetomadaInput,
} from "./retomada-slot-offer";

// Base: o cenário que DEVE retomar (caso Odonto Carioca, 21 98817-7687).
const base = (o: Partial<RetomadaInput> = {}): RetomadaInput => ({
  stage: "SLOT_OFFER",
  appointmentId: null,
  selectedSlotIso: null,
  lastMessageRole: "assistant",
  lastAssistantText:
    "Entendo perfeitamente! Sábado pode ser mais tranquilo para você. Deixa eu verificar a disponibilidade de sábado e já te mostro os horários que temos, tá bem?",
  minutesSinceLastMessage: 30,
  retomadas: 0,
  locked: false,
  ...o,
});

describe("shouldResumeSlotOffer", () => {
  it("caso real: promessa com fecho retórico e lead calado → RETOMA", () => {
    const d = shouldResumeSlotOffer(base());
    expect(d.retomar).toBe(true);
    expect(d.motivo).toBe("retomar");
  });

  it("pergunta REAL do agente → espera o lead, não retoma", () => {
    const d = shouldResumeSlotOffer(
      base({ lastAssistantText: "Você prefere de manhã ou à tarde?" }),
    );
    expect(d.retomar).toBe(false);
    expect(d.motivo).toBe("aguardando_resposta_do_lead");
  });

  it("pergunta real COM fecho retórico junto ainda é pergunta → não retoma", () => {
    const d = shouldResumeSlotOffer(
      base({ lastAssistantText: "Tenho 14h ou 16h. Qual prefere, tá bem?" }),
    );
    expect(d.retomar).toBe(false);
    expect(d.motivo).toBe("aguardando_resposta_do_lead");
  });

  it("lead falou por último → o webhook normal cuida, não retoma", () => {
    const d = shouldResumeSlotOffer(base({ lastMessageRole: "user" }));
    expect(d.retomar).toBe(false);
    expect(d.motivo).toBe("vez_do_lead");
  });

  it("fora de SLOT_OFFER não retoma", () => {
    expect(shouldResumeSlotOffer(base({ stage: "NAME_COLLECT" })).motivo).toBe(
      "stage_nao_e_slot_offer",
    );
    expect(shouldResumeSlotOffer(base({ stage: "CONFIRMED" })).retomar).toBe(false);
  });

  it("já agendado ou já escolheu slot não retoma", () => {
    expect(shouldResumeSlotOffer(base({ appointmentId: "4787789492125697" })).motivo).toBe(
      "ja_agendado",
    );
    expect(
      shouldResumeSlotOffer(base({ selectedSlotIso: "2026-07-23T09:00:00-03:00" })).motivo,
    ).toBe("slot_ja_escolhido");
  });

  it("conversa travada (turno em andamento) não retoma", () => {
    expect(shouldResumeSlotOffer(base({ locked: true })).motivo).toBe("conversa_travada");
  });

  it("respeita a janela: cedo demais e antiga demais", () => {
    expect(shouldResumeSlotOffer(base({ minutesSinceLastMessage: 5 })).motivo).toBe(
      "cedo_demais",
    );
    expect(shouldResumeSlotOffer(base({ minutesSinceLastMessage: 60 * 48 })).motivo).toBe(
      "antiga_demais",
    );
  });

  it("anti-loop: respeita o teto de retomadas", () => {
    expect(shouldResumeSlotOffer(base({ retomadas: 1 })).motivo).toBe("teto_de_retomadas");
    expect(
      shouldResumeSlotOffer(base({ retomadas: 1 }), { ...RETOMADA_DEFAULTS, maxRetomadas: 2 })
        .retomar,
    ).toBe(true);
  });

  it("config customizada respeita minMinutes", () => {
    const d = shouldResumeSlotOffer(base({ minutesSinceLastMessage: 5 }), {
      ...RETOMADA_DEFAULTS,
      minMinutes: 3,
    });
    expect(d.retomar).toBe(true);
  });

  it("outras promessas sem pergunta também retomam", () => {
    for (const t of [
      "Vou buscar os horários disponíveis pra você.",
      "Só um instantinho que já te trago as opções.",
      "Já vou deixar tudo reservado por aqui e logo te envio a confirmação!",
    ]) {
      expect(shouldResumeSlotOffer(base({ lastAssistantText: t })).retomar, t).toBe(true);
    }
  });
});
