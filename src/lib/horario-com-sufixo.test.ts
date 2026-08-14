import { describe, expect, it } from "vitest";

import { tryAutoSelectOfferedSlot } from "./booking-template";

// Caso real: Odonto Carioca Campo Grande, (21) 99027-0086, 12–13/08.
// O lead escreveu "09:45hs." e, no dia seguinte, "Vc. Marcou para o dia 20/08 às
// 09:45 hs, nao foi?". O slot das 09:45 estava ofertado e livre — o sistema
// manteve 09:30 nas duas vezes.
//
// O padrão de "mensagem que é SÓ um horário" aceitava o sufixo de unidade
// apenas quando NÃO havia minutos: "9h" passava, "09:45h" não. O mesmo "h"
// valia como separador e era recusado como unidade. Casava "09:45", sobrava
// "hs.", a âncora `$` falhava e o horário nunca era extraído.

const SLOTS = [
  { iso: "2026-08-20T09:30:00-03:00", date_label: "quinta-feira, 20/08", time_label: "09:30" },
  { iso: "2026-08-20T09:45:00-03:00", date_label: "quinta-feira, 20/08", time_label: "09:45" },
  { iso: "2026-08-20T10:00:00-03:00", date_label: "quinta-feira, 20/08", time_label: "10:00" },
];
const OFERTA = "Tenho quinta-feira, 20/08 às 09:30, 09:45 ou 10:00. Qual prefere?";

/** Horário (HH:MM) que a auto-seleção escolheu, ou null. */
function escolhido(msgDoLead: string): string | null {
  const r = tryAutoSelectOfferedSlot("SLOT_OFFER", { offered_slots: SLOTS }, [
    { role: "assistant", content: OFERTA },
    { role: "user", content: msgDoLead },
  ]);
  const iso = r?.selected_slot_iso;
  return iso ? iso.slice(11, 16) : null;
}

describe("horário com sufixo de unidade", () => {
  it("a mensagem literal do caso", () => {
    expect(escolhido("09:45hs.")).toBe("09:45");
  });

  it("todas as formas de sufixo que os leads escrevem", () => {
    // As 13 mensagens desse formato encontradas em produção falhavam — 100%.
    for (const t of [
      "09:45hs.",
      "09:45hs",
      "09:45 hs",
      "09:45h",
      "09:45hrs",
      "09:45 horas",
      "10:00hs.",
      "9:45h",
    ]) {
      expect(escolhido(t), t).toBe(t.startsWith("10") ? "10:00" : "09:45");
    }
  });

  it("as formas que já funcionavam continuam funcionando", () => {
    expect(escolhido("09:45")).toBe("09:45");
    expect(escolhido("9:45")).toBe("09:45");
    expect(escolhido("às 09:45")).toBe("09:45");
    expect(escolhido("09h45")).toBe("09:45");
    expect(escolhido("09:30")).toBe("09:30");
  });

  it("número solto continua NÃO virando horário", () => {
    // Sem marcador de hora nem preposição não dá pra distinguir de dia do
    // mês/idade — a mensagem inteira sendo "9" ou "45" não é escolha.
    for (const t of ["9", "45", "tenho 45 anos", "somos 2"]) {
      expect(escolhido(t), t).toBeNull();
    }
  });
});
