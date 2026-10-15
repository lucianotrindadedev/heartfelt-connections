// Casos reais (Odonto Sorrisos, 15/10/2026):
// - 87 99243-0695: a recepção avisou "COROA está Pronta"; o paciente respondeu
//   "segunda-feira à tarde é certo" e recebeu "Pra eu já te trazer os horários…:
//   você prefere de manhã ou à tarde?" (pergunta fixa da trava de oferta
//   inventada) e depois "Só pra deixar claro: ainda não reservei nada, tá?"
//   (trava de agendamento falso).
// - 87 99824-4791: "sua prótese está pronta!" → a IA ofertou agenda de avaliação.
import { describe, expect, it } from "vitest";

import { claimsBookingWithoutAppointment, pedeEscolhaDeHorario } from "./false-booking-claim";
import {
  avisoDeEntregaProntaPendente,
  ENTREGA_PRONTA_REPLY,
  type HistoryMsg,
} from "./human-messages";

const T = (hms: string) => `2026-10-15T${hms}.000Z`;
const lead = (hms: string, content: string): HistoryMsg => ({
  role: "user",
  content,
  meta: { origem: "lead" },
  criado_em: T(hms),
});
const equipe = (hms: string, content: string): HistoryMsg => ({
  role: "assistant",
  content,
  meta: { origem: "humano" },
  criado_em: T(hms),
});
const agente = (hms: string, content: string): HistoryMsg => ({
  role: "assistant",
  content,
  meta: { origem: "agente" },
  criado_em: T(hms),
});

describe("avisoDeEntregaProntaPendente — resposta ao aviso de trabalho pronto", () => {
  it("COROA está Pronta → coroa (caso 87 99243-0695)", () => {
    const msgs = [
      equipe(
        "14:13:04",
        "Olá! 😊 Tudo bem? Sou Carla, recepcionista da Clínica Odonto Sorrisos! 🦷✨",
      ),
      equipe(
        "14:36:30",
        "Temos uma ótima notícia: *COROA* está Pronta🦷✨\n\nQual seria o melhor dia e horário para o senhor vir à clínica para recebê-la?",
      ),
      lead("20:12:43", "Boa tarde, Carla. Sobre o dia, de certeza é segunda-feira à tarde."),
    ];
    expect(avisoDeEntregaProntaPendente(msgs)).toBe("coroa");
  });

  it("prótese pronta, com outra fala da equipe no meio (caso 87 99824-4791)", () => {
    const msgs = [
      agente("17:04:30", "❤️"),
      equipe("13:39:16", "Temos uma ótima notícia: *sua prótese está pronta!* 🦷✨"),
      equipe("13:40:45", "a senhoras consegue vir dia *21/10* na *QUARTA-FEIRA* ás *09:30*?"),
      lead("14:19:15", "Não tem como eu ir de três horas não? Ou de quatro horas da tarde?"),
    ];
    expect(avisoDeEntregaProntaPendente(msgs)).toBe("prótese");
  });

  it("erro de digitação 'cora' vira coroa", () => {
    expect(
      avisoDeEntregaProntaPendente([
        equipe("10:00:00", "A cora de Felipe, já  esta pronta"),
        lead("10:05:00", "Bom dia"),
      ]),
    ).toBe("coroa");
  });

  it("a IA já falou depois do aviso → não repete", () => {
    expect(
      avisoDeEntregaProntaPendente([
        equipe("10:00:00", "Sua coroa está pronta, vamos agendar sua vinda?"),
        lead("10:05:00", "Oi"),
        agente("10:05:30", ENTREGA_PRONTA_REPLY),
        lead("10:06:00", "Obrigado"),
      ]),
    ).toBeNull();
  });

  it("última fala não é do lead → nada", () => {
    expect(
      avisoDeEntregaProntaPendente([
        lead("10:00:00", "Oi"),
        equipe("10:05:00", "Sua prótese está pronta!"),
      ]),
    ).toBeNull();
  });

  it.each([
    "Bom dia, irei verificar se sua placa já está pronta.",
    "Estou entrando em contato só para desmarcar a sua vinda hoje, porque sua prótese ainda não está pronta.",
    "Pronto! Você não receberá mais mensagens automáticas por aqui. 👋",
    "Pronto combinado",
    "Estamos prontos para te atender! Qual o melhor horário?",
  ])("não é aviso de entrega: %j", (texto) => {
    expect(
      avisoDeEntregaProntaPendente([equipe("10:00:00", texto), lead("10:05:00", "Ok")]),
    ).toBeNull();
  });

  it("a resposta só promete o que o código faz (escala para a recepção)", () => {
    expect(ENTREGA_PRONTA_REPLY).toMatch(/recepção/);
    expect(ENTREGA_PRONTA_REPLY).not.toMatch(/\d{1,2}:\d{2}|agend/i);
  });
});

describe("trava de agendamento falso — 'confirmado' numa oferta de escolha", () => {
  const CASO =
    "Perfeito! Então segunda-feira à tarde é confirmado. 😊\n\nTenho horários disponíveis: segunda-feira, 19/10 às 15:00 ou às 16:00.\n\nQual desses dois fica melhor para você?";

  it("oferta pedindo escolha não é confirmação de reserva (caso 87 99243-0695)", () => {
    expect(pedeEscolhaDeHorario(CASO)).toBe(true);
    expect(claimsBookingWithoutAppointment({ reply: CASO, horarioEmJogo: true })).toBe(false);
  });

  it.each([
    "Agendado para segunda-feira às 15:00! Te espero. 😊",
    "Perfeito, marquei sua consulta. Qual o seu nome completo?",
    "Pronto, está confirmado! Te esperamos na segunda.",
  ])("continua barrando: %j", (t) => {
    expect(claimsBookingWithoutAppointment({ reply: t, horarioEmJogo: true })).toBe(true);
  });
});
