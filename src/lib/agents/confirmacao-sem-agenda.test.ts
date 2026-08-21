import { describe, expect, it } from "vitest";

import { claimsBookingConfirmed } from "./booking-failure";
import { tryAutoSelectOfferedSlot } from "../booking-template";

// Central de atendimento MF Beauty, 15-16/08/2026 — duas leads receberam
// "está confirmado" e apareceram na clínica em horários que não existiam.
//
// Rafaela Adriano (21 97996-8794) e Anete Lessa Leal (21 97197-1008) fecharam a
// conversa com appointment_id ausente, tools_called=[] e ZERO telemetria de
// trava: o criar_agendamento nunca chegou a ser chamado, e a rede de segurança
// contra confirmação falsa não reconheceu a frase que o agente usou.
//
// Foram DUAS falhas encadeadas, e cada uma sozinha teria bastado para o
// prejuízo. Este arquivo trava as duas.

// Datas relativas: fixture com data absoluta apodrece (ver data-sozinha.test).
function diaRelativo(n: number) {
  const d = new Date();
  d.setDate(d.getDate() + n);
  const ymd = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
  const [, mm, dd] = ymd.split("-") as [string, string, string];
  const weekday = new Intl.DateTimeFormat("pt-BR", {
    timeZone: "America/Sao_Paulo",
    weekday: "long",
  }).format(d);
  return {
    ddmm: `${dd}/${mm}`,
    label: `${weekday}, ${dd}/${mm}`,
    iso: (hhmm: string) => `${ymd}T${hhmm}:00-03:00`,
  };
}

const DIA_A = diaRelativo(1);
const DIA_B = diaRelativo(2);

function escolhido(
  slots: { iso: string; date_label: string; time_label: string }[],
  oferta: string,
  msgs: string[],
): string | null {
  const r = tryAutoSelectOfferedSlot("SLOT_OFFER", { offered_slots: slots }, [
    { role: "assistant", content: oferta },
    ...msgs.map((content) => ({ role: "user" as const, content })),
  ]);
  return r?.selected_slot_iso ?? null;
}

describe("falha 1 — a escolha do lead precisa virar selected_slot_iso", () => {
  it("escolha + pergunta emendada na mesma rajada não perde a escolha (Anete)", () => {
    // "Às 10:30 porque moro em santo Aleixo" / "Qual o endereço?". A auto-seleção
    // olhava só a ÚLTIMA mensagem, enxergava a pergunta e não selecionava nada.
    const slots = [
      { iso: DIA_A.iso("10:00"), date_label: DIA_A.label, time_label: "10:00" },
      { iso: DIA_A.iso("10:30"), date_label: DIA_A.label, time_label: "10:30" },
    ];
    const oferta = `Encontrei estes 2 horários: ${DIA_A.label} às 10:00 ou ${DIA_A.label} às 10:30. Qual fica melhor?`;
    expect(escolhido(slots, oferta, ["Às 10:30 porque moro em santo Aleixo", "Qual o endereço?"])).toBe(
      DIA_A.iso("10:30"),
    );
  });

  it("escolha por DIA seleciona quando o agente falou UM horário naquele dia (Rafaela)", () => {
    // "Dia 20/08" respondendo a "quinta 20/08 às 14:30 ou quarta 19/08 às 12:00".
    // offered_slots tinha 3 vagas naquele dia, mas o agente só OFERTOU uma —
    // é por spoken (o que ele disse), não por offered_slots, que se decide.
    const slots = [
      { iso: DIA_B.iso("12:00"), date_label: DIA_B.label, time_label: "12:00" },
      { iso: DIA_A.iso("12:00"), date_label: DIA_A.label, time_label: "12:00" },
      { iso: DIA_A.iso("12:30"), date_label: DIA_A.label, time_label: "12:30" },
      { iso: DIA_A.iso("14:30"), date_label: DIA_A.label, time_label: "14:30" },
    ];
    const oferta = `Encontrei estes 2 horários à tarde: ${DIA_A.label} às 14:30 ou ${DIA_B.label} às 12:00. Qual fica melhor pra você?`;
    expect(escolhido(slots, oferta, [`Dia ${DIA_A.ddmm}`])).toBe(DIA_A.iso("14:30"));
  });

  it("escolha por DIA NÃO seleciona quando o agente falou vários horários naquele dia", () => {
    const slots = [
      { iso: DIA_A.iso("09:30"), date_label: DIA_A.label, time_label: "09:30" },
      { iso: DIA_A.iso("14:30"), date_label: DIA_A.label, time_label: "14:30" },
    ];
    const oferta = `Tenho ${DIA_A.label} às 09:30 ou às 14:30. Qual prefere?`;
    expect(escolhido(slots, oferta, [`Dia ${DIA_A.ddmm}`])).toBeNull();
  });

  it("PERGUNTA sobre um dia não é escolha desse dia", () => {
    const slots = [
      { iso: DIA_A.iso("14:30"), date_label: DIA_A.label, time_label: "14:30" },
      { iso: DIA_B.iso("12:00"), date_label: DIA_B.label, time_label: "12:00" },
    ];
    const oferta = `Tenho ${DIA_A.label} às 14:30 ou ${DIA_B.label} às 12:00.`;
    expect(escolhido(slots, oferta, [`Tem no dia ${DIA_A.ddmm}?`])).toBeNull();
  });

  it("recusa em QUALQUER mensagem da rajada veta a rajada inteira", () => {
    // Olhar as mensagens anteriores não pode reabrir o buraco que
    // isSlotAcceptanceMessage fecha: a escolha vem primeiro e é retirada depois.
    const slots = [
      { iso: DIA_A.iso("10:00"), date_label: DIA_A.label, time_label: "10:00" },
      { iso: DIA_A.iso("15:00"), date_label: DIA_A.label, time_label: "15:00" },
    ];
    const oferta = `Tenho ${DIA_A.label} às 10:00 ou às 15:00. Qual prefere?`;
    expect(escolhido(slots, oferta, ["as 15h", "ah não, esqueci que não posso nesse dia"])).toBeNull();
  });

  it("a escolha MAIS RECENTE da rajada ganha", () => {
    const slots = [
      { iso: DIA_A.iso("10:00"), date_label: DIA_A.label, time_label: "10:00" },
      { iso: DIA_A.iso("11:30"), date_label: DIA_A.label, time_label: "11:30" },
    ];
    const oferta = `Tenho ${DIA_A.label} às 10:00 ou às 11:30. Qual prefere?`;
    expect(escolhido(slots, oferta, ["quero as 10:00", "11:30"])).toBe(DIA_A.iso("11:30"));
  });

  it("escolha posterior NÃO lida não ressuscita a anterior", () => {
    // "na verdade 11:30" fala de horário e não é reconhecida pelo matcher. Aqui
    // não selecionar é o certo: voltar para "quero as 10:00" agendaria o
    // horário que o lead ACABOU de trocar. Quem resolve é o resolvedor por LLM,
    // que recebe a rajada inteira.
    const slots = [
      { iso: DIA_A.iso("10:00"), date_label: DIA_A.label, time_label: "10:00" },
      { iso: DIA_A.iso("11:30"), date_label: DIA_A.label, time_label: "11:30" },
    ];
    const oferta = `Tenho ${DIA_A.label} às 10:00 ou às 11:30. Qual prefere?`;
    expect(escolhido(slots, oferta, ["quero as 10:00", "na verdade 11:30"])).toBeNull();
  });
});

describe("falha 2 — a trava tem que reconhecer a frase como confirmação", () => {
  it('"ficou para <dia> às <hora>" é confirmação (Rafaela e Anete)', () => {
    expect(
      claimsBookingConfirmed(
        "Perfeito, Rafaela Adriano ✨ Sua avaliação na MF Beauty ficou para quinta-feira, 20/08 às 14:30.",
      ),
    ).toBe(true);
    expect(
      claimsBookingConfirmed(
        "Perfeito, Anete Lessa Leal 💎 Sua avaliação na MF Beauty ficou para sexta-feira, 21/08 às 10:30.",
      ),
    ).toBe(true);
    expect(claimsBookingConfirmed("Sua consulta fica para amanhã às 9h.")).toBe(true);
    expect(claimsBookingConfirmed("Seu horário será para segunda às 14:00.")).toBe(true);
  });

  it('"Estaremos te esperando" fecha como se a vaga existisse', () => {
    // O fecho padrão da conta. O ramo de despedida só cobria as formas
    // conjugadas ("te esperamos") e deixava passar gerúndio e infinitivo.
    expect(
      claimsBookingConfirmed(
        "📍 Praça Dr. Nilo Peçanha, 45, Loja 13 – Magé – RJ. Quinta-feira às 14:30. Estaremos te esperando 💎",
      ),
    ).toBe(true);
    expect(claimsBookingConfirmed("Vamos te aguardando na sexta às 10:30!")).toBe(true);
    expect(claimsBookingConfirmed("Vamos te esperar amanhã às 9h 😊")).toBe(true);
  });

  it("primeira pessoa no passado também é confirmação", () => {
    expect(claimsBookingConfirmed("Já marquei pra você quinta às 14:30 😊")).toBe(true);
    expect(claimsBookingConfirmed("Agendei sua avaliação para amanhã às 10h.")).toBe(true);
  });

  it("oferta e pergunta continuam NÃO sendo confirmação", () => {
    expect(claimsBookingConfirmed("Posso marcar sua avaliação para quinta às 14:30?")).toBe(false);
    expect(claimsBookingConfirmed("Sua avaliação pode ficar para quinta às 14:30, o que acha?")).toBe(
      false,
    );
    expect(claimsBookingConfirmed("Quer que eu marque esse horário?")).toBe(false);
    expect(claimsBookingConfirmed("Vou confirmar sua reserva agora, tá?")).toBe(false);
    // Sem dia/hora não há promessa de vaga nenhuma.
    expect(claimsBookingConfirmed("Fico no aguardo da sua confirmação 😊")).toBe(false);
    expect(claimsBookingConfirmed("Vamos aguardar sua resposta então!")).toBe(false);
  });
});
