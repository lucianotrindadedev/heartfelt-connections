import { describe, expect, it } from "vitest";

import { tryAutoSelectOfferedSlot } from "./booking-template";

// Data sozinha é FILTRO, não escolha.
//
// Caso real (Odonto Carioca Campo Grande, 21 99027-0086): o agente ofertou
// 09:30, 09:45 e 10:00 no mesmo dia e o lead respondeu "09:45hs.". O sufixo "hs"
// impedia a leitura do horário, sobrava a data, e a data selecionava o mais
// cedo — 09:30. O lead escolheu 09:45 duas vezes e ficou com 09:30 nas duas.
//
// Escolher o mais cedo quando o lead só nomeou o DIA é escolher pela pessoa, e
// agendar no horário errado é o erro mais caro deste fluxo.

// As datas são RELATIVAS a hoje, nunca fixas. A versão anterior deste arquivo
// cravava 20/08/2026 nas fixtures; em 21/08/2026 essa data virou passado,
// targetDateFromText passou a resolvê-la para a próxima ocorrência (2027),
// nenhum slot casava mais e dois destes testes quebraram sozinhos, sem uma
// linha de código ter mudado.
function diaRelativo(n: number) {
  const d = new Date();
  d.setDate(d.getDate() + n);
  const fmt = (o: Intl.DateTimeFormatOptions) =>
    new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo", ...o }).format(d);
  const ymd = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d); // "YYYY-MM-DD"
  const [, mm, dd] = ymd.split("-") as [string, string, string];
  return {
    dd,
    ddmm: `${dd}/${mm}`,
    mesExtenso: fmt({ month: "long" }),
    label: `${fmt({ weekday: "long" })}, ${dd}/${mm}`,
    iso: (hhmm: string) => `${ymd}T${hhmm}:00-03:00`,
  };
}

const DIA_A = diaRelativo(1);
const DIA_B = diaRelativo(2);

const TRES_NO_MESMO_DIA = [
  { iso: DIA_A.iso("09:30"), date_label: DIA_A.label, time_label: "09:30" },
  { iso: DIA_A.iso("09:45"), date_label: DIA_A.label, time_label: "09:45" },
  { iso: DIA_A.iso("10:00"), date_label: DIA_A.label, time_label: "10:00" },
];
const OFERTA = `Tenho ${DIA_A.label} às 09:30, 09:45 ou 10:00. Qual prefere?`;

function escolhido(slots: typeof TRES_NO_MESMO_DIA, msg: string, oferta = OFERTA): string | null {
  const r = tryAutoSelectOfferedSlot("SLOT_OFFER", { offered_slots: slots }, [
    { role: "assistant", content: oferta },
    { role: "user", content: msg },
  ]);
  return r?.selected_slot_iso ?? null;
}

describe("data sozinha não escolhe horário", () => {
  it("responder só a data com VÁRIOS horários naquele dia não seleciona", () => {
    for (const msg of [
      DIA_A.ddmm,
      `dia ${DIA_A.dd}`,
      `pode ser ${DIA_A.ddmm}`,
      `${DIA_A.dd} de ${DIA_A.mesExtenso}`,
    ]) {
      expect(escolhido(TRES_NO_MESMO_DIA, msg), msg).toBeNull();
    }
  });

  it("com UM único horário no dia pedido, a leitura é inequívoca e seleciona", () => {
    const umSo = [
      { iso: DIA_A.iso("09:30"), date_label: DIA_A.label, time_label: "09:30" },
      { iso: DIA_B.iso("14:00"), date_label: DIA_B.label, time_label: "14:00" },
    ];
    expect(
      escolhido(
        umSo,
        DIA_A.ddmm,
        `Tenho ${DIA_A.ddmm} às 09:30 ou ${DIA_B.ddmm} às 14:00. Qual prefere?`,
      ),
    ).toBe(DIA_A.iso("09:30"));
  });

  it("data + HORÁRIO continua selecionando (sem regressão)", () => {
    expect(escolhido(TRES_NO_MESMO_DIA, `${DIA_A.ddmm} às 09:45`)).toBe(DIA_A.iso("09:45"));
    expect(escolhido(TRES_NO_MESMO_DIA, `dia ${DIA_A.dd} às 10:00`)).toBe(DIA_A.iso("10:00"));
  });

  it("horário sozinho continua selecionando (sem regressão)", () => {
    expect(escolhido(TRES_NO_MESMO_DIA, "09:45")).toBe(DIA_A.iso("09:45"));
  });

  it("data + TURNO segue o caminho antigo — escopo não alterado", () => {
    // Turno dito depois de uma oferta continua selecionando: é decisão anterior
    // (caso Wagner, 21 99401-9696) e tem teste próprio em booking-template.test.
    // Aqui só travamos que este PR NÃO mexeu nesse caminho.
    const manhaETarde = [
      { iso: DIA_A.iso("09:30"), date_label: DIA_A.label, time_label: "09:30" },
      { iso: DIA_A.iso("14:00"), date_label: DIA_A.label, time_label: "14:00" },
    ];
    expect(
      escolhido(
        manhaETarde,
        `${DIA_A.ddmm} de manhã`,
        `Tenho ${DIA_A.ddmm} às 09:30 ou 14:00. Qual prefere?`,
      ),
    ).toBe(DIA_A.iso("09:30"));
  });
});
