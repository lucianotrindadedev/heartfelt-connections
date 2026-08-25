import { describe, expect, it } from "vitest";

import {
  isBareGratitude,
  slotsOfferedInLastTurn,
  tryAutoSelectOfferedSlot,
} from "./booking-template";
import { buildReofferReply } from "./agents/booking-failure";

// Caso real: Odonto Carioca Campo Grande, Adriana Amazonas de Araújo
// (21) 98746-4703, 24/08/2026.
//
// O agente ofertou "25/08 às 12:30 ou 13:00". Ela respondeu em rajada:
//   "Ótima as 13: horas" → "Obrigada" → "As 13h"
// e o turno terminou com booking_error="selected_slot_iso ausente". A consulta
// acabou marcada na mão pela recepção; a IA nunca criou o agendamento.
//
// looksLikeDecline trata "obrigada" SOZINHO como "não, obrigada" — correto
// quando é a resposta inteira a uma oferta, desastroso no meio de uma escolha.
// Como o veto olha a rajada INTEIRA (leitura de rajada veio em 21/08), a
// educação dela apagou o horário que ela tinha acabado de escolher, duas vezes.
//
// A re-oferta que ela recebeu ("12:30 ou 12:45") era o outro lado do mesmo
// turno: buildReofferReply cortava offered_slots em .slice(0, 2) e devolvia os
// dois primeiros da agenda, não os dois que o agente tinha falado.

function diaRelativo(n: number) {
  const d = new Date();
  d.setDate(d.getDate() + n);
  const ymd = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
  const [, mm, dd] = ymd.split("-") as [string, string, string];
  const weekday = new Intl.DateTimeFormat("pt-BR", {
    timeZone: "America/Sao_Paulo",
    weekday: "long",
  }).format(d);
  return { label: `${weekday}, ${dd}/${mm}`, iso: (hhmm: string) => `${ymd}T${hhmm}:00-03:00` };
}

const DIA_A = diaRelativo(1);
const DIA_B = diaRelativo(2);

// A agenda devolveu 6 vagas; o agente citou 2. Os 13:00 em DOIS dias diferentes
// são de propósito: é o que torna "As 13h" ambíguo por hora e obriga o desempate
// pelo que o agente ACABOU de falar.
const SLOTS = [
  { iso: DIA_A.iso("12:30"), date_label: DIA_A.label, time_label: "12:30" },
  { iso: DIA_A.iso("12:45"), date_label: DIA_A.label, time_label: "12:45" },
  { iso: DIA_A.iso("13:00"), date_label: DIA_A.label, time_label: "13:00" },
  { iso: DIA_A.iso("13:15"), date_label: DIA_A.label, time_label: "13:15" },
  { iso: DIA_B.iso("12:45"), date_label: DIA_B.label, time_label: "12:45" },
  { iso: DIA_B.iso("13:00"), date_label: DIA_B.label, time_label: "13:00" },
];

const OFERTA =
  `Perfeito, Adriana! Consegui exatamente o que você pediu na ${DIA_A.label}.\n\n` +
  `Tenho dois horários pra você escolher:\n• ${DIA_A.label} às 12:30\n• ${DIA_A.label} às 13:00\n\n` +
  `Qual desses fica melhor?`;

/** Horário (HH:MM) que a auto-seleção escolheu, ou null. */
function escolhido(rajada: string[], oferta = OFERTA): string | null {
  const r = tryAutoSelectOfferedSlot("SLOT_OFFER", { offered_slots: SLOTS } as never, [
    { role: "assistant", content: oferta },
    ...rajada.map((content) => ({ role: "user" as const, content })),
  ]);
  const iso = r?.selected_slot_iso;
  return iso ? iso.slice(11, 16) : null;
}

describe('"Obrigada" no meio da escolha não é recusa', () => {
  it("a rajada real da Adriana resolve para o horário que ela pediu", () => {
    expect(escolhido(["Ótima as 13: horas", "Obrigada", "As 13h"])).toBe("13:00");
  });

  it("o agradecimento pode vir por último", () => {
    expect(escolhido(["As 13h", "Obrigada"])).toBe("13:00");
  });

  it("desempata pelo DIA que o agente falou, não pelo outro dia com o mesmo horário", () => {
    const r = tryAutoSelectOfferedSlot("SLOT_OFFER", { offered_slots: SLOTS } as never, [
      { role: "assistant", content: OFERTA },
      { role: "user", content: "Obrigada" },
      { role: "user", content: "As 13h" },
    ]);
    expect(r.selected_slot_iso).toBe(DIA_A.iso("13:00"));
  });

  // ── O que NÃO pode voltar a passar ────────────────────────────────────────

  it('"não, obrigada" continua sendo recusa, mesmo com horário na rajada', () => {
    expect(escolhido(["as 13h", "não, obrigada"])).toBeNull();
  });

  it("indisponibilidade na rajada continua vetando a escolha anterior", () => {
    expect(escolhido(["As 13h", "ah não, esqueci que não posso"])).toBeNull();
  });

  it("agradecimento SOZINHO continua sendo lido como recusa", () => {
    expect(escolhido(["Obrigada"])).toBeNull();
  });

  it('"ok" + "obrigada" não vira escolha — a isenção exige hora explícita', () => {
    expect(escolhido(["Ok", "Obrigada"])).toBeNull();
  });
});

describe("isBareGratitude", () => {
  it("reconhece só o agradecimento seco", () => {
    for (const t of ["Obrigada", "obrigado", "Obrigada!", "OBRIGADO."]) {
      expect(isBareGratitude(t)).toBe(true);
    }
  });

  it("não engole agradecimento com conteúdo junto nem recusa", () => {
    for (const t of ["Muito obrigada", "Obrigada pela ajuda", "não, obrigada", "Ok obrigada", ""]) {
      expect(isBareGratitude(t)).toBe(false);
    }
  });
});

describe("a re-oferta repete o que o AGENTE falou", () => {
  it("lista os horários ditos na última fala, não os dois primeiros da agenda", () => {
    const spoken = slotsOfferedInLastTurn({ offered_slots: SLOTS } as never, [
      { role: "assistant", content: OFERTA },
      { role: "user", content: "As 13h" },
    ]);
    // O que a Adriana viu: 12:30 e 13:00. offered_slots[0..1] seria 12:30 e 12:45.
    expect(spoken.map((s) => s.time_label)).toEqual(["12:30", "13:00"]);
    expect(buildReofferReply(spoken)).toContain("12:30");
    expect(buildReofferReply(spoken)).toContain("13:00");
    expect(buildReofferReply(spoken)).not.toContain("12:45");
    // Era exatamente esta a mensagem errada que ela recebeu.
    expect(buildReofferReply(SLOTS)).toContain("12:45");
  });
});
