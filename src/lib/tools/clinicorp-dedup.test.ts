// INVARIANTE: offered_slots nunca pode ter duas entradas no MESMO horário.
//
// Caso real (Sorriso Saúde, 27 99922-9610, 10/08/2026): a agenda tinha dois
// dentistas livres às 10:00 e o dedup do Clinicorp incluía o dentista na chave,
// então a lead via "terça 11/08 às 10:00" DUAS vezes. Ao responder "às 10
// horas", tryAutoSelectOfferedSlot achava 2 candidatos ambíguos e desistia
// (nunca preenchia selected_slot_iso) → criar_agendamento falhava por slot
// ausente → a trava de confirmação falsa re-ofertava OUTROS horários (13:00/
// 13:30, depois 09:00/09:30) → loop até a supervisora assumir e agendar à mão.
//
// O lead nunca escolhe profissional: ele escolhe HORÁRIO. O profissional viaja
// dentro do slot escolhido.

import { describe, expect, it } from "vitest";

import { dedupSlotsByDateTime } from "./clinicorp.server";
import { isSlotAcceptanceMessage, tryAutoSelectOfferedSlot } from "@/lib/booking-template";

const slot = (localDate: string, fromTime: string, dentistPersonId: number) => ({
  localDate,
  fromTime,
  dentistPersonId,
  start: `${localDate}T${fromTime}:00-03:00`,
});

describe("dedupSlotsByDateTime", () => {
  it("colapsa dois profissionais no MESMO horário em uma única oferta", () => {
    const out = dedupSlotsByDateTime([
      slot("2026-08-11", "10:00", 111),
      slot("2026-08-11", "10:00", 222), // outro dentista, mesmo horário
      slot("2026-08-11", "10:30", 111),
      slot("2026-08-11", "10:30", 222),
    ]);
    expect(out).toHaveLength(2);
    expect(out.map((s) => s.fromTime)).toEqual(["10:00", "10:30"]);
    // Mantém o PRIMEIRO profissional livre naquele horário.
    expect(out[0]!.dentistPersonId).toBe(111);
  });

  it("horários e dias distintos são preservados", () => {
    const out = dedupSlotsByDateTime([
      slot("2026-08-11", "09:00", 111),
      slot("2026-08-11", "10:00", 111),
      slot("2026-08-12", "09:00", 222), // mesmo horário, outro DIA
    ]);
    expect(out).toHaveLength(3);
  });

  it("lista vazia não quebra", () => {
    expect(dedupSlotsByDateTime([])).toEqual([]);
  });
});

// Segundo bug do MESMO atendimento: a lead escreveu "Às 10, horas" (vírgula
// entre o número e o marcador). Nenhum dos regexes de horário previa isso —
// então, mesmo sem duplicata, a escolha nunca era reconhecida.
describe("REGRESSÃO: horário com vírgula ('Às 10, horas')", () => {
  const SLOTS = [
    { iso: "2026-08-11T10:00:00-03:00", date_label: "terça-feira, 11/08", time_label: "10:00" },
    { iso: "2026-08-11T10:30:00-03:00", date_label: "terça-feira, 11/08", time_label: "10:30" },
  ];
  const escolher = (msg: string) =>
    tryAutoSelectOfferedSlot(
      "SLOT_OFFER",
      { offered_slots: SLOTS as never },
      [
        { role: "assistant", content: "Tenho terça-feira, 11/08 às 10:00 ou às 10:30. Qual você prefere?" },
        { role: "user", content: msg },
      ],
    ).selected_slot_iso;

  it("as 3 frases REAIS da lead selecionam as 10:00", () => {
    expect(escolher("Às 10, horas")).toBe("2026-08-11T10:00:00-03:00");
    expect(escolher("Às 10, horas Se for possível")).toBe("2026-08-11T10:00:00-03:00");
    expect(escolher("Pode ser terça feira às 10, horas?")).toBe("2026-08-11T10:00:00-03:00");
  });

  it("formas equivalentes seguem funcionando", () => {
    for (const m of ["10h", "10 horas", "às 10", "10:00", "as 10h"]) {
      expect(escolher(m), m).toBe("2026-08-11T10:00:00-03:00");
    }
    expect(escolher("10:30")).toBe("2026-08-11T10:30:00-03:00");
    // "10,30" continua sendo 10:30 (minutos vencem a vírgula-marcador).
    expect(escolher("10,30")).toBe("2026-08-11T10:30:00-03:00");
  });

  it("NÃO-REGRESSÃO: recusa e indisponibilidade continuam barradas", () => {
    expect(isSlotAcceptanceMessage("Só largo as 18:00")).toBe(false);
    expect(isSlotAcceptanceMessage("não posso às 10 horas")).toBe(false);
    expect(isSlotAcceptanceMessage("nenhum dos 2")).toBe(false);
    expect(isSlotAcceptanceMessage("às 10, horas é impossível")).toBe(false);
  });
});

// Prova do porquê: com duplicatas a escolha do lead vira ambígua.
describe("REGRESSÃO: duplicata de horário quebra a auto-seleção (origem do loop)", () => {
  const oferta = (dup: boolean) => {
    const base = [
      { iso: "2026-08-11T10:00:00-03:00", date_label: "terça-feira, 11/08", time_label: "10:00" },
      { iso: "2026-08-11T10:30:00-03:00", date_label: "terça-feira, 11/08", time_label: "10:30" },
    ];
    // A duplicata tem o MESMO time_label e um iso diferente (outro dentista).
    return dup
      ? [
          base[0]!,
          { ...base[0]!, iso: "2026-08-11T10:00:00-03:00#2" },
          base[1]!,
          { ...base[1]!, iso: "2026-08-11T10:30:00-03:00#2" },
        ]
      : base;
  };

  const escolher = (slots: ReturnType<typeof oferta>) =>
    tryAutoSelectOfferedSlot(
      "SLOT_OFFER",
      { offered_slots: slots as never },
      [
        {
          role: "assistant",
          content: "Tenho terça-feira, 11/08 às 10:00 ou terça-feira, 11/08 às 10:30. Qual você prefere?",
        },
        { role: "user", content: "Às 10, horas" },
      ],
    ).selected_slot_iso;

  it("COM duplicata (bug): não consegue escolher → conversa trava", () => {
    expect(escolher(oferta(true))).toBeUndefined();
  });

  it("SEM duplicata (após o dedup): escolhe as 10:00 normalmente", () => {
    expect(escolher(oferta(false))).toBe("2026-08-11T10:00:00-03:00");
  });
});
