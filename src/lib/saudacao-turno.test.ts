import { describe, expect, it } from "vitest";

import { requestedPeriodoFromText, tryAutoSelectOfferedSlot } from "./booking-template";

// Caso real: Odonto Carioca Campo Grande, (21) 99272-7525, 11/08.
// "Boa tarde, gostaria de agendar uma avaliação para amanhã" → a âncora de data
// acertou 12/08, mas o "tarde" da SAUDAÇÃO virou filtro de turno e removeu a
// única vaga do dia (11:15, de manhã). O agente ofereceu quinta 13/08.
describe("saudação não é preferência de turno", () => {
  it("a frase real do caso não pede turno nenhum", () => {
    expect(requestedPeriodoFromText("Boa tarde, gostaria de agendar uma avaliação para amanhã")).toBeNull();
  });

  it("saudações, em todas as formas que aparecem em produção", () => {
    for (const t of [
      "Boa tarde",
      "boa tarde",
      "Boa tarde!",
      "oi boa tarde",
      "Oi boa tarde vocês tem vaga para amanhã cedo",
      "Boa noite, queria marcar",
      "Boa tarde. Acabei de ver um anúncio aqui no Face",
      "Obrigado pela atenção de VCS boa tarde",
      "Boa tarde, não obrigada.",
      "Boa tarde Só na proxima semana",
      "boatarde",
      "boanoite",
      "Boas tardes",
      "boa-tarde",
      "Tenha uma boa noite!",
    ]) {
      expect(requestedPeriodoFromText(t), t).toBeNull();
    }
  });

  it("o corte é cirúrgico: só a ocorrência da saudação some", () => {
    expect(requestedPeriodoFromText("Boa tarde, prefiro de tarde")).toBe("tarde");
    expect(requestedPeriodoFromText("Boa tarde! Consigo só de manhã")).toBe("manha");
    expect(requestedPeriodoFromText("Boa noite, dá pra ser à tarde?")).toBe("tarde");
    expect(requestedPeriodoFromText("Boa noite, pode ser de manhã")).toBe("manha");
  });

  it("preferência de verdade continua funcionando (sem regressão)", () => {
    expect(requestedPeriodoFromText("prefiro de tarde")).toBe("tarde");
    expect(requestedPeriodoFromText("de manhã fica melhor")).toBe("manha");
    expect(requestedPeriodoFromText("só consigo à noite")).toBe("noite");
    expect(requestedPeriodoFromText("pode ser amanhã de manhã")).toBe("manha");
    // Desambiguação por cláusula de trabalho — o teste que já existia no módulo.
    expect(requestedPeriodoFromText("trabalho de manhã, só posso de tarde")).toBe("tarde");
  });

  it("'amanhã' continua não sendo lido como 'manhã' (sem regressão)", () => {
    expect(requestedPeriodoFromText("pode ser amanhã")).toBeNull();
    expect(requestedPeriodoFromText("Boa tarde, pode ser amanhã?")).toBeNull();
  });
});

// A saudação também alimentava a auto-seleção entre os horários ofertados: um
// "Boa tarde" solto, logo depois de o agente ofertar, virava "quero de tarde" e
// travava o primeiro slot da tarde como se fosse escolha do lead.
describe("saudação não escolhe horário", () => {
  const BRT = "America/Sao_Paulo";
  const amanha = new Date(Date.now() + 86_400_000);
  const iso = new Intl.DateTimeFormat("en-CA", { timeZone: BRT }).format(amanha);
  const ddmm = new Intl.DateTimeFormat("pt-BR", {
    timeZone: BRT,
    day: "2-digit",
    month: "2-digit",
  }).format(amanha);
  const slots = [
    { iso: `${iso}T09:00:00-03:00`, date_label: `quarta-feira, ${ddmm}`, time_label: "09:00" },
    { iso: `${iso}T14:00:00-03:00`, date_label: `quarta-feira, ${ddmm}`, time_label: "14:00" },
  ];
  const hist = (msg: string) => [
    { role: "assistant" as const, content: `Tenho ${ddmm} às 09:00 ou ${ddmm} às 14:00. Qual prefere?` },
    { role: "user" as const, content: msg },
  ];

  it("'Boa tarde' não trava o slot da tarde", () => {
    const r = tryAutoSelectOfferedSlot("SLOT_OFFER", { offered_slots: slots }, hist("Boa tarde"));
    expect(r?.selected_slot_iso).toBeUndefined();
  });

  it("mas um pedido real de turno continua selecionando", () => {
    const r = tryAutoSelectOfferedSlot(
      "SLOT_OFFER",
      { offered_slots: slots },
      hist("pode ser de tarde"),
    );
    expect(r?.selected_slot_iso).toBe(slots[1]!.iso);
  });
});
