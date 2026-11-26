import { describe, expect, it } from "vitest";

import { agendamentoVigente } from "./agents/booking-failure";
import { calendarioProximosDias, corrigirDiaDaSemana } from "./dia-da-semana";

// Casos reais da varredura de 23–26/11/2026 (ver dia-da-semana.ts).
const AGORA = new Date("2026-11-25T12:00:00-03:00"); // quarta-feira

describe("corrigirDiaDaSemana — casos reais", () => {
  it("Game Point, Fernanda: 06/12 é domingo e 08/12 é terça", () => {
    const r = corrigirDiaDaSemana(
      "📅 **Sábado, 06/12:** R$ 1.000,00\n📅 **Segunda-feira, 08/12:** R$ 499,00",
      AGORA,
    );
    expect(r.texto).toBe(
      "📅 **Domingo, 06/12:** R$ 1.000,00\n📅 **Terça-feira, 08/12:** R$ 499,00",
    );
    expect(r.correcoes).toHaveLength(2);
  });

  it("Game Point: '06/12 é sábado e 08/12 é segunda-feira'", () => {
    const r = corrigirDiaDaSemana(
      "E sobre as datas: 06/12 é sábado e 08/12 é segunda-feira.",
      AGORA,
    );
    expect(r.texto).toBe("E sobre as datas: 06/12 é domingo e 08/12 é terça-feira.");
  });

  it("Sorriso Saúde: segunda-feira, 01/12 / terça-feira, 02/12", () => {
    const r = corrigirDiaDaSemana(
      "Tenho segunda-feira, 01/12 à tarde ou terça-feira, 02/12 à tarde.",
      new Date("2026-11-24T11:17:00-03:00"),
    );
    expect(r.texto).toBe("Tenho terça-feira, 01/12 à tarde ou quarta-feira, 02/12 à tarde.");
  });

  it("Sorriso Saúde: 'segunda-feira, 25/11' e 'quinta-feira, 27/11'", () => {
    const d = new Date("2026-11-23T18:57:00-03:00");
    expect(corrigirDiaDaSemana("segunda-feira, 25/11 às 08:00", d).texto).toBe(
      "quarta-feira, 25/11 às 08:00",
    );
    expect(corrigirDiaDaSemana("quinta-feira, 27/11 às 08:30", d).texto).toBe(
      "sexta-feira, 27/11 às 08:30",
    );
  });

  it("Odonto Carioca: 'terça, 03/12' (sem -feira) → quinta", () => {
    expect(
      corrigirDiaDaSemana("você prefere terça, 03/12, ou a partir de 07/12?", AGORA).texto,
    ).toBe("você prefere quinta, 03/12, ou a partir de 07/12?");
  });

  it("parênteses e 'dia'", () => {
    expect(corrigirDiaDaSemana("dia 06/12 (sábado)", AGORA).texto).toBe("dia 06/12 (domingo)");
    // O artigo acompanha: "na sexta" → "no domingo".
    expect(corrigirDiaDaSemana("na sexta, dia 13/12", AGORA).texto).toBe("no domingo, dia 13/12");
    expect(corrigirDiaDaSemana("no sábado, 08/12", AGORA).texto).toBe("na terça, 08/12");
  });
});

describe("corrigirDiaDaSemana — o que não pode mudar", () => {
  it("dia certo fica intacto", () => {
    const t = "Tenho terça-feira, 01/12 às 08:30 ou quarta-feira, 02/12 às 09:00.";
    expect(corrigirDiaDaSemana(t, AGORA)).toEqual({ texto: t, correcoes: [] });
  });

  it("sem acento e caixa alta seguem o estilo", () => {
    expect(corrigirDiaDaSemana("SABADO, 06/12", AGORA).texto).toBe("DOMINGO, 06/12");
    expect(corrigirDiaDaSemana("terca, 03/12", AGORA).texto).toBe("quinta, 03/12");
    expect(corrigirDiaDaSemana("segunda, 06/12", AGORA).texto).toBe("domingo, 06/12");
  });

  it("dia da semana sem data, data sem dia, data inválida: nada muda", () => {
    for (const t of [
      "pode ser segunda?",
      "dia 06/12 às 10:00",
      "segunda, 31/02",
      "segunda opinião 12/12",
    ]) {
      expect(corrigirDiaDaSemana(t, AGORA).texto).toBe(t);
    }
  });

  it("ano explícito e virada de ano", () => {
    expect(corrigirDiaDaSemana("segunda-feira, 05/01/2027", AGORA).texto).toBe(
      "terça-feira, 05/01/2027",
    );
    // Sem ano, janeiro visto de novembro é o ano seguinte (05/01/2027 = terça).
    expect(corrigirDiaDaSemana("segunda-feira, 05/01", AGORA).texto).toBe("terça-feira, 05/01");
  });
});

describe("calendarioProximosDias", () => {
  it("começa hoje e acerta os dias", () => {
    const c = calendarioProximosDias(AGORA, 8);
    expect(c).toBe(
      "qua 25/11 · qui 26/11 · sex 27/11 · sáb 28/11 · dom 29/11 · seg 30/11 · ter 01/12 · qua 02/12",
    );
  });

  it("45 dias alcançam meados de dezembro (caso Pamela, 15/12)", () => {
    expect(calendarioProximosDias(AGORA)).toContain("ter 15/12");
    expect(calendarioProximosDias(AGORA)).toContain("dom 13/12");
  });
});

describe("agendamentoVigente — agendamento que já passou não conta", () => {
  const agora = new Date("2026-11-23T18:57:00-03:00");
  it("consulta antiga (16/11) com o lead voltando em 23/11", () => {
    expect(
      agendamentoVigente(
        { appointment_id: 123, booked_slot_iso: "2026-11-16T13:00:00-03:00" },
        null,
        agora,
      ),
    ).toBe(false);
  });

  it("consulta futura continua contando", () => {
    expect(
      agendamentoVigente(
        { appointment_id: 123, booked_slot_iso: "2026-11-30T13:30:00-03:00" },
        null,
        agora,
      ),
    ).toBe(true);
  });

  it("consulta de hoje, mais cedo, ainda conta por 3h", () => {
    expect(
      agendamentoVigente(
        { appointment_id: 1, booked_slot_iso: "2026-11-23T17:00:00-03:00" },
        null,
        agora,
      ),
    ).toBe(true);
  });

  it("criado neste turno sempre conta; sem data gravada segue contando", () => {
    expect(agendamentoVigente({}, { appointment_id: 9 }, agora)).toBe(true);
    expect(agendamentoVigente({ appointment_id: 9 }, null, agora)).toBe(true);
    expect(agendamentoVigente({}, null, agora)).toBe(false);
  });
});
