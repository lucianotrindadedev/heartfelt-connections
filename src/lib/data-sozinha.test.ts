import { describe, expect, it } from "vitest";

import { tryAutoSelectOfferedSlot } from "./booking-template";

// Data sozinha é FILTRO, não escolha.
//
// Caso real (Odonto Carioca Campo Grande, 21 99027-0086): o agente ofertou
// 09:30, 09:45 e 10:00 em 20/08 e o lead respondeu "09:45hs.". O sufixo "hs"
// impedia a leitura do horário, sobrava a data, e a data selecionava o mais
// cedo — 09:30. O lead escolheu 09:45 duas vezes e ficou com 09:30 nas duas.
//
// Escolher o mais cedo quando o lead só nomeou o DIA é escolher pela pessoa, e
// agendar no horário errado é o erro mais caro deste fluxo.

const TRES_NO_MESMO_DIA = [
  { iso: "2026-08-20T09:30:00-03:00", date_label: "quinta-feira, 20/08", time_label: "09:30" },
  { iso: "2026-08-20T09:45:00-03:00", date_label: "quinta-feira, 20/08", time_label: "09:45" },
  { iso: "2026-08-20T10:00:00-03:00", date_label: "quinta-feira, 20/08", time_label: "10:00" },
];
const OFERTA = "Tenho quinta-feira, 20/08 às 09:30, 09:45 ou 10:00. Qual prefere?";

function escolhido(slots: typeof TRES_NO_MESMO_DIA, msg: string, oferta = OFERTA): string | null {
  const r = tryAutoSelectOfferedSlot("SLOT_OFFER", { offered_slots: slots }, [
    { role: "assistant", content: oferta },
    { role: "user", content: msg },
  ]);
  return r?.selected_slot_iso ?? null;
}

describe("data sozinha não escolhe horário", () => {
  it("responder só a data com VÁRIOS horários naquele dia não seleciona", () => {
    for (const msg of ["20/08", "dia 20", "pode ser 20/08", "20 de agosto"]) {
      expect(escolhido(TRES_NO_MESMO_DIA, msg), msg).toBeNull();
    }
  });

  it("com UM único horário no dia pedido, a leitura é inequívoca e seleciona", () => {
    const umSo = [
      { iso: "2026-08-20T09:30:00-03:00", date_label: "quinta-feira, 20/08", time_label: "09:30" },
      { iso: "2026-08-21T14:00:00-03:00", date_label: "sexta-feira, 21/08", time_label: "14:00" },
    ];
    expect(escolhido(umSo, "20/08", "Tenho 20/08 às 09:30 ou 21/08 às 14:00. Qual prefere?")).toBe(
      "2026-08-20T09:30:00-03:00",
    );
  });

  it("data + HORÁRIO continua selecionando (sem regressão)", () => {
    expect(escolhido(TRES_NO_MESMO_DIA, "20/08 às 09:45")).toBe("2026-08-20T09:45:00-03:00");
    expect(escolhido(TRES_NO_MESMO_DIA, "dia 20 às 10:00")).toBe("2026-08-20T10:00:00-03:00");
  });

  it("horário sozinho continua selecionando (sem regressão)", () => {
    expect(escolhido(TRES_NO_MESMO_DIA, "09:45")).toBe("2026-08-20T09:45:00-03:00");
  });

  it("data + TURNO segue o caminho antigo — escopo não alterado", () => {
    // Turno dito depois de uma oferta continua selecionando: é decisão anterior
    // (caso Wagner, 21 99401-9696) e tem teste próprio em booking-template.test.
    // Aqui só travamos que este PR NÃO mexeu nesse caminho.
    const manhaETarde = [
      { iso: "2026-08-20T09:30:00-03:00", date_label: "quinta-feira, 20/08", time_label: "09:30" },
      { iso: "2026-08-20T14:00:00-03:00", date_label: "quinta-feira, 20/08", time_label: "14:00" },
    ];
    expect(
      escolhido(manhaETarde, "20/08 de manhã", "Tenho 20/08 às 09:30 ou 14:00. Qual prefere?"),
    ).toBe("2026-08-20T09:30:00-03:00");
  });
});
