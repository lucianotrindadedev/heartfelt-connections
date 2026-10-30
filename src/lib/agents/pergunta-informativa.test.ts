import { describe, expect, it } from "vitest";

import { linhaPerguntaHorarioDoServico, perguntaSobreHorarioDoServico } from "./pergunta-informativa";

describe("perguntaSobreHorarioDoServico", () => {
  // Caso real: Amazing CCZ, (44) 99761-9505, 30/10/2026 11:38.
  it("reconhece a pergunta de permanência do caso real", () => {
    expect(
      perguntaSobreHorarioDoServico("Os horários de permanência na escola, se é meio período ou integral"),
    ).toBe(true);
  });

  it.each([
    "Qual o horário de aula?",
    "Vocês têm período integral?",
    "Que horas entra e que horas sai?",
    "É semi-integral ou só manhã?",
    "Qual o horário de funcionamento?",
    "Até que horas a criança pode ficar?",
    "Integral",
    "Gostaria de informações de valores do integral por favor",
    "Até que horas fica aberto a clínica?",
  ])("reconhece rotina: %s", (texto) => {
    expect(perguntaSobreHorarioDoServico(texto)).toBe(true);
  });

  it.each([
    "Tem horário para visita amanhã?",
    "Quero marcar uma visita no período da tarde",
    "Pode ser sexta às 14h?",
    "tem horário disponível?",
    "Prefiro de manhã",
    "13:00",
    "Qual o valor da mensalidade?",
    // Falsos positivos da varredura de 60 dias:
    "Qual e o valor de uma prótese integral",
    "Bronze integral 10",
    "Porque trabalho meio período",
    "Entendi!! Eu preciso de um horario de atendimento mais tarde... pois trabalho até as 19h",
    "Nosso horário de atendimento é das 7h às 18h. Retornaremos assim que possível.",
    "Nosso ultimo horário de atendimento é 17:45hs. Consigo nesse dia chegar antes as 15hs",
  ])("não confunde com agenda ou outro assunto: %s", (texto) => {
    expect(perguntaSobreHorarioDoServico(texto)).toBe(false);
  });
});

describe("linhaPerguntaHorarioDoServico", () => {
  it("alerta quando alguma mensagem da rajada pergunta a rotina", () => {
    expect(linhaPerguntaHorarioDoServico(["oi", "é integral?"])).toContain("ROTINA DO SERVIÇO");
  });

  it("vazio sem pergunta de rotina", () => {
    expect(linhaPerguntaHorarioDoServico(["13:00"])).toBe("");
    expect(linhaPerguntaHorarioDoServico([])).toBe("");
  });
});
