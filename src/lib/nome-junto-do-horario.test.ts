import { describe, expect, it } from "vitest";

import { claimsBookingConfirmed } from "./agents/booking-failure";
import {
  backfillBookingFieldsFromHistory,
  semTrechoDeHorario,
  tryAutoCaptureBookingAnswer,
} from "./booking-template";

// Caso real: Sorriso Saúde, Cleusa (27) 98813-0617, 22/11/2026.
//
// Pedido o nome ("me passa seu nome completo para o cadastro?"), ela respondeu
// numa mensagem só "Cleusa Santos Assis\nTerça 08:30h". O horário foi lido,
// o nome não: a captura rejeitava a mensagem inteira. Sem nome o agendamento
// não rodou — e a IA mandou o vídeo de como chegar + "Parabéns por dar esse
// primeiro passo…", que a trava de confirmação falsa não reconhecia.

const CH = { channel: "whatsapp", effectivePhone: "27988130617" } as never;
const PEDIDO_NOME =
  "Como cada caso muda bastante, o mais seguro é avaliar primeiro.\n\nPra eu já deixar seu horário garantido, me passa seu nome completo para o cadastro?";
const MSG_REAL = "Cleusa Santos Assis\nTerça 08:30h";

describe("semTrechoDeHorario", () => {
  it("separa o nome do horário", () => {
    expect(semTrechoDeHorario(MSG_REAL)).toBe("Cleusa Santos Assis");
    expect(semTrechoDeHorario("Cleusa Santos Assis, terça 08:30")).toBe("Cleusa Santos Assis");
    expect(semTrechoDeHorario("Terça às 8h\nMaria da Silva")).toBe("Maria da Silva");
    expect(semTrechoDeHorario("João Pereira; 24/11")).toBe("João Pereira");
  });

  it("sem trecho de horário, ou só horário, fica intacto", () => {
    expect(semTrechoDeHorario("Cleusa Santos Assis")).toBe("Cleusa Santos Assis");
    expect(semTrechoDeHorario("Terça 08:30h")).toBe("Terça 08:30h");
    expect(semTrechoDeHorario("terça, 08:30")).toBe("terça, 08:30");
  });
});

describe("captura do nome junto da escolha de horário", () => {
  it("mensagem real: grava o nome", () => {
    const r = tryAutoCaptureBookingAnswer(
      "NAME_COLLECT",
      {} as never,
      [
        { role: "assistant", content: PEDIDO_NOME },
        { role: "user", content: MSG_REAL },
      ],
      {},
      CH,
    );
    expect(r).toEqual({ name: "Cleusa Santos Assis" });
  });

  it("com vírgula também", () => {
    const r = tryAutoCaptureBookingAnswer(
      "NAME_COLLECT",
      {} as never,
      [
        { role: "assistant", content: PEDIDO_NOME },
        { role: "user", content: "Cleusa Santos Assis, terça 08:30" },
      ],
      {},
      CH,
    );
    expect(r).toEqual({ name: "Cleusa Santos Assis" });
  });

  it("sem pedido de nome, a escolha de horário não vira nome", () => {
    const r = tryAutoCaptureBookingAnswer(
      "NAME_COLLECT",
      {} as never,
      [
        { role: "assistant", content: "Tenho terça às 08:30 ou às 09:00. Qual fica melhor?" },
        { role: "user", content: MSG_REAL },
      ],
      {},
      CH,
    );
    expect(r).toEqual({});
  });

  it("só o horário continua sem nome", () => {
    const r = tryAutoCaptureBookingAnswer(
      "NAME_COLLECT",
      {} as never,
      [
        { role: "assistant", content: PEDIDO_NOME },
        { role: "user", content: "Terça 08:30h" },
      ],
      {},
      CH,
    );
    expect(r).toEqual({});
  });

  it("backfill do histórico também pega o nome", () => {
    const r = backfillBookingFieldsFromHistory(
      {} as never,
      [
        { role: "user", content: "Olá! Quero saber da prótese protocolo." },
        { role: "assistant", content: PEDIDO_NOME },
        { role: "user", content: MSG_REAL },
      ],
      {},
      CH,
    );
    expect(r).toEqual({ name: "Cleusa Santos Assis" });
  });
});

describe("claimsBookingConfirmed — parabéns de fechamento", () => {
  it("resposta real (sem agendamento) é confirmação", () => {
    expect(
      claimsBookingConfirmed(
        "Parabéns por dar esse primeiro passo rumo à melhor versão do seu sorriso e da sua saúde.",
      ),
    ).toBe(true);
    expect(claimsBookingConfirmed("Parabéns pela sua consulta! 😊")).toBe(true);
  });

  it("parabéns com pergunta é condução, não fechamento", () => {
    expect(claimsBookingConfirmed("Parabéns pela decisão! Vamos marcar sua avaliação?")).toBe(
      false,
    );
    expect(
      claimsBookingConfirmed(
        "Parabéns por cuidar do sorriso. Qual horário fica melhor pra sua consulta?",
      ),
    ).toBe(false);
  });

  it("parabéns sem ligação com agendamento não conta", () => {
    expect(claimsBookingConfirmed("Parabéns pelo aniversário! 🎉")).toBe(false);
  });

  it("o que já era detectado continua", () => {
    expect(claimsBookingConfirmed("Seu agendamento foi concluído com sucesso.")).toBe(true);
    expect(claimsBookingConfirmed("Posso agendar terça às 08:30?")).toBe(false);
  });
});
