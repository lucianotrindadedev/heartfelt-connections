// Read-only, sem banco: a citação do WhatsApp engana a ESCOLHA automática de
// horário? É o caminho mais perigoso — a citação costuma conter a oferta
// inteira do agente ("sexta-feira, 18/09 às 10:30 ou às 14:00").

import { describe, expect, it } from "vitest";
import { tryAutoSelectOfferedSlot } from "@/lib/booking-template";
import { withQuotePrefix } from "@/lib/quote-prefix";

const SLOTS = [
  { iso: "2026-09-18T10:30:00-03:00", date_label: "sexta-feira, 18/09", time_label: "10:30" },
  { iso: "2026-09-18T14:00:00-03:00", date_label: "sexta-feira, 18/09", time_label: "14:00" },
];
const LEAD = { offered_slots: SLOTS } as never;
const OFERTA =
  "Tenho dois horários próximos para sua Consulta de Diagnóstico: sexta-feira, 18/09 às 10:30 ou sexta-feira, 18/09 às 14:00. Qual fica melhor para você?";

const hist = (ultimaDoLead: string) => [
  { role: "assistant" as const, content: OFERTA },
  { role: "user" as const, content: ultimaDoLead },
];

describe("citação x escolha automática de horário", () => {
  it("lead responde CITANDO a oferta e dizendo um horário — escolhe o que ELE disse", () => {
    const r = tryAutoSelectOfferedSlot("SLOT_OFFER", LEAD, hist(withQuotePrefix(OFERTA, "as 14h")));
    console.log("  citando a oferta + 'as 14h' ->", JSON.stringify(r));
    expect(r.selected_slot_iso).toBe("2026-09-18T14:00:00-03:00");
  });

  it("REGRESSÃO: citar a oferta sem escolher NADA não pode virar escolha", () => {
    // A citação tem 10:30 e 14:00. A fala do lead não tem horário nenhum.
    for (const fala of ["Ok", "Entendi", "Obrigada", "Vou ver com meu marido"]) {
      const r = tryAutoSelectOfferedSlot("SLOT_OFFER", LEAD, hist(withQuotePrefix(OFERTA, fala)));
      console.log(`  citando a oferta + ${JSON.stringify(fala)} ->`, JSON.stringify(r));
      expect(r.selected_slot_iso, fala).toBeUndefined();
    }
  });

  it("citação com OUTRO horário não vence a fala do lead", () => {
    const citadoAntigo =
      "Tenho quinta-feira, 17/09 às 08:30 ou às 09:00. Qual fica melhor?";
    const r = tryAutoSelectOfferedSlot(
      "SLOT_OFFER",
      LEAD,
      hist(withQuotePrefix(citadoAntigo, "pode ser as 10:30")),
    );
    console.log("  citação com 08:30/09:00 + 'pode ser as 10:30' ->", JSON.stringify(r));
    expect(r.selected_slot_iso).toBe("2026-09-18T10:30:00-03:00");
  });
});
