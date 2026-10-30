// Agenda de VISITA numa conversa sobre a data da FESTA (Game Point): com
// agenda_ignora_datas_da_conversa, a busca de horários não herda da conversa o
// dia/dia da semana/turno/hora — "a festa é num sábado de julho" prendia a
// visita a sábado e a julho.
import { describe, expect, it } from "vitest";
import { AGENDA_IGNORA_DATAS_SETTING, historicoParaPreferencias } from "./scheduler.server";

const history = [
  { role: "user" as const, content: "A festa é num sábado de julho, à noite" },
  { role: "assistant" as const, content: "Quer agendar a visita?" },
  { role: "user" as const, content: "quero agendar já" },
];

describe("historicoParaPreferencias", () => {
  it("padrão: a busca continua lendo as preferências da conversa", () => {
    expect(historicoParaPreferencias({ history, agentSettings: {} })).toBe(history);
    expect(
      historicoParaPreferencias({ history, agentSettings: { [AGENDA_IGNORA_DATAS_SETTING]: "false" } }),
    ).toBe(history);
  });

  it("ligado: nenhuma data/turno da conversa vira preferência da agenda", () => {
    for (const v of ["true", "TRUE", "1", "sim"]) {
      expect(
        historicoParaPreferencias({ history, agentSettings: { [AGENDA_IGNORA_DATAS_SETTING]: v } }),
      ).toEqual([]);
    }
  });
});
