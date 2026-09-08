import { describe, expect, it } from "vitest";

import { classifyRequestedDay } from "./booking-template";

// Caso real: Odonto Carioca Campo Grande, Jose Amilton (21) 96647-7334,
// 08/09/2026.
//
//   10:54  lead    "Preciso extrair um dente para hoje"
//   10:56  agente  "Para hoje infelizmente não temos vaga, mas consegui um
//                   horário bem próximo para você amanhã." → 09/09 09:00 ou 10:00
//   11:04  humano  marca 13:00 DE HOJE na mão
//
// A agenda tinha 14 horários livres hoje (13:45–17:00). A frase não foi
// alucinação: com a âncora no dia pedido e nenhum slot desse dia na resposta, a
// própria tool mandava dizer "SEM VAGA em 2026-09-08". O que faltava era
// distinguir "não tem vaga" de "a consulta desse dia falhou e voltou vazia" —
// a busca por dia engolia timeout/5xx com `.catch(() => [])`, sem log nem retry.
//
// Falha medida em produção: 12 execuções idênticas da mesma janela devolveram
// 88 vagas onze vezes e 72 numa delas — um dia inteiro sumido, ~8%.

const HOJE = "2026-09-08";
const AMANHA = "2026-09-09";
const slotsDe = (dia: string, ...horas: string[]) => horas.map((h) => `${dia}T${h}:00-03:00`);

describe("classifyRequestedDay", () => {
  it("dia pedido FALHOU na consulta → 'not_checked', nunca 'no_vacancy'", () => {
    // O turno real: pediu hoje, hoje falhou, a oferta veio de amanhã.
    expect(classifyRequestedDay(HOJE, [HOJE], slotsDe(AMANHA, "09:00", "10:00"))).toBe(
      "not_checked",
    );
  });

  it("dia pedido consultado e sem nenhum slot → 'no_vacancy'", () => {
    expect(classifyRequestedDay(HOJE, [], slotsDe(AMANHA, "09:00"))).toBe("no_vacancy");
  });

  it("dia pedido presente na oferta → 'available'", () => {
    expect(classifyRequestedDay(HOJE, [], slotsDe(HOJE, "13:45", "14:00"))).toBe("available");
  });

  it("'não consultado' vence 'sem vaga' mesmo com outros dias falhando junto", () => {
    expect(classifyRequestedDay(HOJE, [AMANHA, HOJE], [])).toBe("not_checked");
  });

  it("falha em OUTRO dia não contamina o veredito do dia pedido", () => {
    expect(classifyRequestedDay(HOJE, [AMANHA], slotsDe(HOJE, "13:45"))).toBe("available");
    expect(classifyRequestedDay(HOJE, [AMANHA], slotsDe(AMANHA, "09:00"))).toBe("no_vacancy");
  });

  it("sem dia pedido não há veredito (o lead não citou data)", () => {
    expect(classifyRequestedDay(null, [], slotsDe(HOJE, "13:45"))).toBeNull();
    expect(classifyRequestedDay("", [HOJE], [])).toBeNull();
    expect(classifyRequestedDay(undefined, [], [])).toBeNull();
  });

  it("aceita ISO completo como dia pedido e tolera slot sem iso", () => {
    expect(classifyRequestedDay(`${HOJE}T00:00:00-03:00`, [], slotsDe(HOJE, "13:45"))).toBe(
      "available",
    );
    expect(classifyRequestedDay(HOJE, [], [undefined, ""])).toBe("no_vacancy");
  });
});
