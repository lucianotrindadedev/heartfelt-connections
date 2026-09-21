// O que o AGENTE disse não é pedido do lead.
//
// Quando o lead responde CITANDO uma mensagem, o webhook grava o conteúdo com
// o prefixo `[Em resposta à mensagem: "..."]`. O texto citado é útil para o
// LLM — o prompt do qualifier usa a citação para saber a qual criança pertence
// uma data de nascimento, por exemplo — então ele continua no histórico. O que
// não podia acontecer é a leitura DETERMINÍSTICA tratar a citação como fala do
// lead.
//
// Descoberto ao reproduzir a conversa da Milene (Clínica Bomfim,
// 21 99004-9579, 21/09/2026): ela respondeu citando uma pergunta DO AGENTE que
// continha a palavra "hoje" — "o que mais te incomoda hoje com o aparelho?" —
// e o "hoje" da citação virou a âncora da busca de horários.
//
// Levantamento de 120 dias: 891 mensagens de lead com citação, 148 (17%) com a
// leitura de data/dia alterada pelo trecho citado. Depois desta correção: 0.

import { describe, expect, it } from "vitest";

import {
  isBareGratitude,
  isSlotAcceptanceMessage,
  requestedDateFromText,
  requestedHoraFromText,
  requestedPeriodoFromText,
  requestedWeekdayFromText,
  tryAutoSelectOfferedSlot,
} from "./booking-template";
import { withQuotePrefix } from "./quote-prefix";

describe("citação não vira pedido de dia/hora", () => {
  it('o "hoje" da pergunta do agente não ancora a busca (caso da Milene)', () => {
    const msg = withQuotePrefix(
      "Além dessa questão da mordida cruzada, o que mais te incomoda hoje com o aparelho?",
      "Eu queria mesmo tirar",
    );
    expect(requestedDateFromText(msg)).toBeNull();
  });

  it("dia da semana citado pelo agente não vence o silêncio do lead", () => {
    const msg = withQuotePrefix(
      "Para vir na Quarta-feira dia 23.09 às 09:00. Deixo quanto tempo para ela",
      "Na última semana do mês, fica bom",
    );
    expect(requestedWeekdayFromText(msg)).toBeNull();
  });

  it("REGRESSÃO: a citação não pode vencer o dia que o lead pediu", () => {
    // Caso real: o agente perguntou por quinta, o lead respondeu sexta.
    const msg = withQuotePrefix(
      "Então, você e a Yngrid conseguem vir amanhã (quinta-feira, 17/09)? Qual horário fica melhor: 08:30 ou 09:00?",
      "Pode ser sexta feira",
    );
    expect(requestedWeekdayFromText(msg)).toBe("sex");
  });

  it("turno e hora também saem da citação, não do agente", () => {
    const msg = withQuotePrefix(
      "Tenho às 08:30 ou às 09:00 pela manhã. Qual fica melhor?",
      "Prefiro de tarde",
    );
    expect(requestedPeriodoFromText(msg)).toBe("tarde");
    expect(requestedHoraFromText(msg)).toBeNull();
  });

  it("a fala do lead continua sendo lida normalmente", () => {
    const msg = withQuotePrefix("Qual horário fica melhor?", "pode ser quinta às 16h");
    expect(requestedWeekdayFromText(msg)).toBe("qui");
    expect(requestedHoraFromText(msg)).toBe(16);
  });

  it("mensagem sem citação não muda de comportamento", () => {
    expect(requestedWeekdayFromText("pode ser quinta")).toBe("qui");
    expect(requestedHoraFromText("às 16h")).toBe(16);
    expect(requestedPeriodoFromText("de manhã")).toBe("manha");
  });
});

describe("citação não escolhe horário no lugar do lead", () => {
  const SLOTS = [
    { iso: "2026-09-18T10:30:00-03:00", date_label: "sexta-feira, 18/09", time_label: "10:30" },
    { iso: "2026-09-18T14:00:00-03:00", date_label: "sexta-feira, 18/09", time_label: "14:00" },
  ];
  const LEAD = { offered_slots: SLOTS } as never;
  const OFERTA =
    "Tenho dois horários próximos para sua Consulta de Diagnóstico: sexta-feira, 18/09 às 10:30 ou sexta-feira, 18/09 às 14:00. Qual fica melhor para você?";
  const hist = (ultima: string) => [
    { role: "assistant" as const, content: OFERTA },
    { role: "user" as const, content: ultima },
  ];

  it("REGRESSÃO: citar a oferta e responder 'Ok' não escolhe horário nenhum", () => {
    // Antes: selecionava 10:30 — o primeiro horário DA CITAÇÃO. O lead não
    // tinha escolhido nada, e o agendamento seguia com um horário inventado.
    for (const fala of ["Ok", "Entendi", "Obrigada", "Vou ver com meu marido"]) {
      const r = tryAutoSelectOfferedSlot("SLOT_OFFER", LEAD, hist(withQuotePrefix(OFERTA, fala)));
      expect(r.selected_slot_iso, fala).toBeUndefined();
    }
  });

  it("REGRESSÃO: citando a oferta, vale a hora que o LEAD digitou", () => {
    // Antes: selecionava 10:30 (o primeiro da citação) mesmo com o lead
    // escrevendo 14h.
    const r = tryAutoSelectOfferedSlot("SLOT_OFFER", LEAD, hist(withQuotePrefix(OFERTA, "as 14h")));
    expect(r.selected_slot_iso).toBe("2026-09-18T14:00:00-03:00");
  });

  it("REGRESSÃO: citar uma oferta ANTIGA não apaga a escolha do lead", () => {
    // Antes: não selecionava nada — a citação com 08:30/09:00 contradizia o
    // 10:30 que o lead pediu e a trava de contradição vetava a escolha.
    const r = tryAutoSelectOfferedSlot(
      "SLOT_OFFER",
      LEAD,
      hist(withQuotePrefix("Tenho quinta-feira, 17/09 às 08:30 ou às 09:00.", "pode ser as 10:30")),
    );
    expect(r.selected_slot_iso).toBe("2026-09-18T10:30:00-03:00");
  });
});

describe("citar não muda o que a fala é", () => {
  // O invariante que importa: com ou sem citação, a MESMA fala do lead tem que
  // ser classificada igual. Vale para qualquer veredito — não depende de o que
  // isBareGratitude decide sobre "Muito obrigada!" (que já era `false` antes,
  // porque o "muito" tira o caráter de cortesia PURA).
  const CITADO = "Tenho 10:30 ou 14:00. Qual fica melhor?";
  for (const fala of [
    "Obrigada!",
    "Muito obrigada!",
    "Ok",
    "as 14h",
    "pode ser quinta",
    "não posso nesse dia",
  ]) {
    it(`"${fala}" é lida igual com e sem citação`, () => {
      const comCitacao = withQuotePrefix(CITADO, fala);
      expect(isBareGratitude(comCitacao)).toBe(isBareGratitude(fala));
      expect(isSlotAcceptanceMessage(comCitacao)).toBe(isSlotAcceptanceMessage(fala));
      expect(requestedWeekdayFromText(comCitacao)).toBe(requestedWeekdayFromText(fala));
      expect(requestedHoraFromText(comCitacao)).toBe(requestedHoraFromText(fala));
      expect(requestedPeriodoFromText(comCitacao)).toBe(requestedPeriodoFromText(fala));
      expect(requestedDateFromText(comCitacao)).toBe(requestedDateFromText(fala));
    });
  }
});
