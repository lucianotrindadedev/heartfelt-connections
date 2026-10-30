// Mídia de abertura (arte de campanha) na primeira resposta da conversa.
import { describe, expect, it } from "vitest";
import { MIDIA_INICIO_SETTING, midiaInicioPendente } from "./midia-inicio";

const S = { [MIDIA_INICIO_SETTING]: "campanha_black_friday" };
const lead = [{ role: "user" as const }];

describe("midiaInicioPendente", () => {
  it("primeira resposta com mídia configurada → envia", () => {
    expect(midiaInicioPendente(S, {}, lead)).toBe("campanha_black_friday");
  });

  it("rajada inicial do lead (várias mensagens, nenhuma resposta ainda) → envia", () => {
    expect(midiaInicioPendente(S, {}, [...lead, { role: "user" }])).toBe("campanha_black_friday");
  });

  it("sem mídia configurada → nada", () => {
    expect(midiaInicioPendente({}, {}, lead)).toBeNull();
    expect(midiaInicioPendente({ [MIDIA_INICIO_SETTING]: "  " }, {}, lead)).toBeNull();
  });

  it("já enviada → não repete", () => {
    expect(midiaInicioPendente(S, { midia_inicio_enviada: true }, lead)).toBeNull();
  });

  it("conversa que já teve resposta (IA ou equipe) → não envia no meio", () => {
    expect(midiaInicioPendente(S, {}, [{ role: "user" }, { role: "assistant" }, { role: "user" }])).toBeNull();
  });
});
