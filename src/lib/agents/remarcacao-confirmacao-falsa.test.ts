// Remarcação com confirmação falsa (Sorriso Saude, 29/10): o lead pediu para
// passar de 09:00 para 08:30; remarcar_agendamento cancelou o das 9h e o
// agente respondeu "Remarquei pra você. Sexta-feira, 30/10 às 08:30 fica
// confirmado agora." sem criar nada. O guard de confirmação falsa pulava o turno
// porque um agendamento tinha "acabado de ser cancelado".
import { describe, expect, it } from "vitest";

import { claimsBookingWithoutAppointment, remarcacaoSemReservaReply } from "./false-booking-claim";

const slots = [
  { date_label: "sexta-feira, 30/10", time_label: "08:00" },
  { date_label: "sexta-feira, 30/10", time_label: "08:30" },
  { date_label: "sexta-feira, 30/10", time_label: "09:00" },
];

describe("remarcação afirmada sem reserva", () => {
  it("'Remarquei… fica confirmado' é confirmação falsa", () => {
    const r = "Claro! Remarquei pra você. Sexta-feira, 30/10 às 08:30 fica confirmado agora.";
    expect(claimsBookingWithoutAppointment({ reply: r, horarioEmJogo: true })).toBe(true);
    expect(claimsBookingWithoutAppointment({ reply: "Reagendei sua consulta!", horarioEmJogo: false })).toBe(true);
    expect(
      claimsBookingWithoutAppointment({ reply: "Ficou remarcado para sexta às 08:30", horarioEmJogo: false }),
    ).toBe(true);
  });

  it("pedir para escolher o novo horário não é confirmação", () => {
    const r = remarcacaoSemReservaReply(slots, "tem como marcar para 8.30hs?");
    expect(claimsBookingWithoutAppointment({ reply: r, horarioEmJogo: true })).toBe(false);
  });
});

describe("remarcacaoSemReservaReply", () => {
  it("diz que o horário atual segue reservado e traz primeiro o pedido", () => {
    const r = remarcacaoSemReservaReply(slots, "Boa tarde tem como você marcar para 8.30hs para seria melhor?");
    expect(r).toMatch(/horário atual continua reservado/);
    expect(r).toMatch(/sexta-feira, 30\/10 às 08:30 ou sexta-feira, 30\/10 às 08:00/);
  });

  it("formatos de hora: 8:30, 08h30, 9h", () => {
    expect(remarcacaoSemReservaReply(slots, "pode ser 08h30")).toMatch(/às 08:30 ou/);
    expect(remarcacaoSemReservaReply(slots, "melhor 9h")).toMatch(/às 09:00 ou/);
  });

  it("sem hora pedida (ou hora fora da lista): oferece os dois primeiros", () => {
    expect(remarcacaoSemReservaReply(slots, "quero mudar o dia 30")).toMatch(/às 08:00 ou .* às 08:30/);
    expect(remarcacaoSemReservaReply(slots, "pode ser 15h")).toMatch(/às 08:00 ou .* às 08:30/);
  });

  it("sem horários livres: pede outro dia, sem prometer nada", () => {
    expect(remarcacaoSemReservaReply([], "8:30")).toMatch(/novo ainda não está marcado/);
  });
});
