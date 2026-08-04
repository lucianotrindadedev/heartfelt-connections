import { describe, expect, it } from "vitest";

import { claimsBookingWithoutAppointment, noBookingYetReply } from "./false-booking-claim";
import { pointingConfirmationReply } from "@/lib/booking-template";

const claim = (reply: string, horarioEmJogo: boolean) =>
  claimsBookingWithoutAppointment({ reply, horarioEmJogo });

describe("claimsBookingWithoutAppointment", () => {
  // ── alegações INEQUÍVOCAS: bloqueiam sempre ────────────────────────────
  it("verbo em 1ª pessoa bloqueia mesmo sem horário em jogo", () => {
    for (const r of [
      "Pronto, agendei sua visita!",
      "Já marquei pra você.",
      "Reservei seu horário.",
    ]) {
      expect(claim(r, false), r).toBe(true);
    }
  });

  it("particípio ancorado em pra/para bloqueia sempre", () => {
    for (const r of [
      "Reservado para quarta-feira, 15/07.",
      "Está agendado para terça às 10h.",
      "Ficou marcado pra sexta.",
      "Tudo confirmado para amanhã.",
    ]) {
      expect(claim(r, false), r).toBe(true);
    }
  });

  // ── formas SOLTAS: só com horário em jogo ──────────────────────────────
  it("particípio solto bloqueia QUANDO há horário em jogo", () => {
    expect(claim("Perfeito, está tudo confirmado!", true)).toBe(true);
    expect(claim("Seu horário está agendado.", true)).toBe(true);
  });

  // Caso real (Odonto Sorrisos, 87 99625-9078): 2ª mensagem da conversa, nenhum
  // horário ofertado ainda, e o lead falava do retorno que o DENTISTA marcou.
  it("particípio solto NÃO bloqueia quando nada está em jogo", () => {
    for (const r of [
      "Entendi! Então seu retorno já está agendado com o doutor daqui 3 meses.",
      "Que bom que ficou tudo confirmado com o dentista.",
      "Pelo que entendi seu tratamento já estava agendado antes.",
    ]) {
      expect(claim(r, false), r).toBe(false);
    }
  });

  it("texto sem alegação nenhuma nunca bloqueia", () => {
    expect(claim("Oi! Como posso ajudar?", true)).toBe(false);
    expect(claim("", true)).toBe(false);
  });
});

describe("noBookingYetReply — nunca inventa falha técnica", () => {
  const slot = (dl: string, tl: string) => ({ date_label: dl, time_label: tl });

  it("sem horário ofertado: pede dia/horário sem falar em erro", () => {
    const r = noBookingYetReply([]);
    expect(r).not.toMatch(/problema|erro|falha|tentar de novo/i);
    expect(r).toContain("não reservei nada");
  });

  it("com horários ofertados: reapresenta as opções, sem falar em erro", () => {
    const r = noBookingYetReply([slot("terça-feira, 04/08", "10:00"), slot("terça-feira, 04/08", "11:00")]);
    expect(r).not.toMatch(/problema|erro|falha|tentar de novo/i);
    expect(r).toContain("terça-feira, 04/08 às 10:00");
    expect(r).toContain("terça-feira, 04/08 às 11:00");
  });

  it("é sempre honesto sobre não ter reservado", () => {
    for (const slots of [[], [slot("terça-feira, 04/08", "10:00")]]) {
      expect(noBookingYetReply(slots)).toMatch(/ainda não reservei nada/i);
    }
  });
});

describe("âncora de data — separa confirmação falsa de conversa sobre outra coisa", () => {
  it("participio + para + DIA/HORA continua bloqueando", () => {
    for (const r of [
      "Reservado para quarta-feira, 15/07.",
      "Está agendado para terça às 10h.",
      "Ficou marcado pra sexta.",
      "Tudo confirmado para amanhã.",
      "Agendado para 04/08 às 10:00.",
      "Marcado para as 14 horas.",
    ]) {
      expect(claim(r, false), r).toBe(true);
    }
  });

  // Caso real (Odonto Sorrisos, 87 99625-9078): o lead falava do retorno que o
  // DENTISTA combinou — "para daqui 3 meses" não é dia nem hora.
  it("participio + para SEM dia/hora não bloqueia mais", () => {
    for (const r of [
      "Entendi! Então o doutor já deixou seu retorno agendado para daqui 3 meses.",
      "Seu tratamento estava agendado para depois da cirurgia.",
      "Isso já estava confirmado para o seu caso.",
    ]) {
      expect(claim(r, false), r).toBe(false);
    }
  });

  it("mas com horário em jogo o particípio solto ainda pega", () => {
    expect(claim("Então seu retorno está agendado para daqui 3 meses.", true)).toBe(true);
  });
});

// ── interação com o guard do gesto de apontar (PR #20) ────────────────────
// Os dois guards vivem na MESMA cadeia do orquestrador e o do gesto roda ANTES.
// O texto que ele produz contém "confirmar" + uma data — exatamente o padrão que
// este guard caça. Se ele disparasse, a pergunta de desambiguação seria
// substituída por "ainda não reservei nada..." e o #20 perderia o efeito.
//
// Hoje não dispara porque o detector exige o PARTICÍPIO ("confirmado") e o texto
// usa o INFINITIVO ("confirmar"), que não afirma nada — só propõe. A margem é
// estreita: reescrever aquela mensagem para "quer deixar confirmado para quinta?"
// voltaria a disparar. Este teste trava a combinação.
describe("não pode engolir a pergunta do gesto de apontar (#20)", () => {
  const slot = (dl: string, tl: string) => ({
    iso: "2026-08-06T09:00:00-03:00",
    end_iso: "2026-08-06T09:15:00-03:00",
    date_label: dl,
    time_label: tl,
  });

  it("a pergunta de UMA opção não é lida como confirmação falsa", () => {
    const r = pointingConfirmationReply([slot("quinta-feira, 06/08", "09:00")] as never)!;
    expect(r).toBeTruthy();
    expect(claim(r, true)).toBe(false);
    expect(claim(r, false)).toBe(false);
  });

  it("a pergunta de DUAS opções também não", () => {
    const r = pointingConfirmationReply([
      slot("quinta-feira, 06/08", "09:00"),
      slot("quinta-feira, 06/08", "10:15"),
    ] as never)!;
    expect(r).toBeTruthy();
    expect(claim(r, true)).toBe(false);
  });

  it("mas a forma AFIRMATIVA equivalente continua sendo bloqueada", () => {
    // se alguém trocar a pergunta por uma afirmação, o guard tem que pegar
    expect(claim("Deixei confirmado para quinta-feira, 06/08 às 09:00.", true)).toBe(true);
  });
});
