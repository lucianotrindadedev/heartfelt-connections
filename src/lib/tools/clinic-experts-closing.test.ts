import { describe, it, expect } from "vitest";
import { withinBlocks } from "./clinic-experts.server";

// A consulta INTEIRA (início + duração) precisa caber no bloco de expediente do
// profissional. Antes só o início era validado, então 17:15 com consulta de 40min
// era ofertado numa clínica que fecha 17:30 (17:15+40=17:55). Mesmo caso do
// Clinicorp, mas aqui o expediente vem de professionals[].business_hours_json.
const bloco = [{ inicio: "08:00", fim: "17:30" }];

describe("withinBlocks (Clinic Experts) — consulta cabe no expediente", () => {
  it("17:15 + 40min (→17:55) NÃO cabe antes de 17:30", () => {
    expect(withinBlocks("17:15", bloco, 40)).toBe(false);
  });

  it("16:50 + 40min (→17:30) cabe exatamente", () => {
    expect(withinBlocks("16:50", bloco, 40)).toBe(true);
  });

  it("09:00 + 40min cabe folgado", () => {
    expect(withinBlocks("09:00", bloco, 40)).toBe(true);
  });

  it("início antes da abertura não cabe", () => {
    expect(withinBlocks("07:30", bloco, 40)).toBe(false);
  });

  it("duracaoMin=0 valida só o início (caminho não usado em produção — o filtro passa a duração real)", () => {
    expect(withinBlocks("17:15", bloco, 0)).toBe(true); // início dentro do bloco
    expect(withinBlocks("18:00", bloco, 0)).toBe(false); // início depois do fim
  });

  it("fim de bloco '00:00' vira meia-noite (1440)", () => {
    expect(withinBlocks("23:00", [{ inicio: "18:00", fim: "00:00" }], 40)).toBe(true);
  });

  it("sem blocos configurados → false (o chamador trata como 'confia na API')", () => {
    expect(withinBlocks("10:00", [], 40)).toBe(false);
  });
});
