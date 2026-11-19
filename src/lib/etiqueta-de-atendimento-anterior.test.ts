import { describe, expect, it } from "vitest";

import { etiquetaEhDeAtendimentoAnterior } from "./etiqueta-de-atendimento-anterior";
import { isOptOutMessage } from "./opt-out.server";

const optOut = (t: string) => isOptOutMessage(t);
const track = { direction: "TO_HUB", type: "TRACK", text: "" };
const lead = (text: string) => ({ direction: "FROM_HUB", type: "TEXT", text });

describe("IA Desligada herdada de atendimento anterior", () => {
  it("sessão nova só com a mensagem do anúncio: a etiqueta é antiga", () => {
    // Formato real da sessão nova (Alfa, 14/11): TRACK + mensagem do lead.
    expect(
      etiquetaEhDeAtendimentoAnterior(
        [track, lead("D-Tenho interesse na Prótese Protocolo e quero agendar uma avaliação")],
        optOut,
      ),
    ).toBe(true);
  });

  it("lead repetiu a mensagem e mandou mídia vazia: continua antiga", () => {
    expect(
      etiquetaEhDeAtendimentoAnterior([track, lead("Quero agendar"), lead(""), track, lead("Quero agendar")], optOut),
    ).toBe(true);
  });

  it("atendente ou IA já falou nesta sessão: a pausa é deste atendimento", () => {
    expect(
      etiquetaEhDeAtendimentoAnterior(
        [lead("Oi"), { direction: "TO_HUB", type: "TEXT", text: "Olá!" }, lead("tudo bem?")],
        optOut,
      ),
    ).toBe(false);
  });

  it("lead pediu para sair nesta sessão: a etiqueta fica", () => {
    expect(etiquetaEhDeAtendimentoAnterior([track, lead("sair"), lead("oi")], optOut)).toBe(false);
  });

  it("sessão sem mensagens (não leu): não arrisca", () => {
    expect(etiquetaEhDeAtendimentoAnterior([], optOut)).toBe(false);
  });
});
