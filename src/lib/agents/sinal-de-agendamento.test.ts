import { describe, expect, it } from "vitest";

import {
  contarTurnosDoLead,
  leadPediuAgendamento,
  mensagemPedeAgendamento,
  ofertaAguardaPedido,
} from "./sinal-de-agendamento";

type T = { role: "user" | "assistant"; content: string };
const u = (content: string): T => ({ role: "user", content });
const a = (content: string): T => ({ role: "assistant", content });
const LIGADO = { oferta_so_com_pedido: "true" };

// Caso real: Amazing CCZ, (11) 97046-2234, 29/10/2026.
const RAFAELLA: T[] = [
  u("Olá bom dia"),
  u("Td bem ?"),
  a("Bom dia! Tudo bem sim, obrigada por perguntar! 😊 Como posso te ajudar hoje?"),
  u("Gostaria de informações"),
  u("Sobre o ensino médio"),
  u("1 ano do médio para o ano de 2027"),
  a("Ótimo! Vou te ajudar com as informações sobre o 1º ano do Ensino Médio para 2027. Pra eu te atender direitinho, qual é o nome do aluno?"),
  u("Rafaella"),
];

describe("leadPediuAgendamento", () => {
  it("caso real: nome e série não são pedido de agenda", () => {
    expect(leadPediuAgendamento(RAFAELLA)).toBe(false);
  });

  it.each([
    "Quero agendar uma visita",
    "tem horário amanhã?",
    "Vocês têm disponibilidade essa semana?",
    "Pode marca",
    "Prefiro de manhã",
    "Só consigo na semana que vem",
    "Acho que dia 7 estará bom",
    "Gostaria de conhecer a escola",
    // Caso real (Amazing, 11 98232-7289, 24/10).
    "Tenho interesse em ver a escola para os meus dois filhos",
  ])("reconhece pedido: %s", (texto) => {
    expect(leadPediuAgendamento([a("Como posso ajudar?"), u(texto)])).toBe(true);
  });

  it.each([
    "Rafaella",
    "Começar só ano que vem mesmo",
    "Qual o valor da mensalidade?",
    "Os horários de permanência na escola, se é meio período ou integral",
    // Caso real (Amazing, 11 98213-3577, 28/10): "junho" é do aniversário.
    "Matheus 2° ano do colegial \nLucca acho que seria infantil, ele tem 4 anos e faz 5 em junho",
    "Ela completou 4 anos dia 12/10",
  ])("não é pedido: %s", (texto) => {
    expect(mensagemPedeAgendamento(texto)).toBe(false);
  });

  it("'sim' ao convite de ver horário conta como pedido", () => {
    expect(
      leadPediuAgendamento([
        ...RAFAELLA,
        a("Conhecer a escola pessoalmente vai te ajudar muito. Quer que eu veja um horário para a sua visita?"),
        u("Sim, quero"),
      ]),
    ).toBe(true);
  });

  it("pedido feito antes, no começo da conversa, continua valendo", () => {
    expect(leadPediuAgendamento([u("Quero marcar uma visita"), a("Qual o nome do aluno?"), u("Rafaella")])).toBe(true);
  });
});

describe("ofertaAguardaPedido", () => {
  it("segura a oferta no caso real com a opção ligada", () => {
    expect(ofertaAguardaPedido(LIGADO, RAFAELLA, [])).toBe(true);
  });

  it("desligada por padrão: nada muda", () => {
    expect(ofertaAguardaPedido({}, RAFAELLA, [])).toBe(false);
    expect(ofertaAguardaPedido({ oferta_so_com_pedido: "false" }, RAFAELLA, [])).toBe(false);
    expect(ofertaAguardaPedido(undefined, RAFAELLA, [])).toBe(false);
  });

  it("com horários já ofertados não segura (a conversa já está na oferta)", () => {
    expect(ofertaAguardaPedido(LIGADO, RAFAELLA, [{ iso: "x" }])).toBe(false);
  });

  it("libera depois do pedido", () => {
    expect(ofertaAguardaPedido(LIGADO, [...RAFAELLA, u("tem horário amanhã?")], [])).toBe(false);
  });
});

describe("contarTurnosDoLead", () => {
  it("conta rajadas, não mensagens", () => {
    expect(contarTurnosDoLead(RAFAELLA)).toBe(3);
    expect(contarTurnosDoLead([])).toBe(0);
    expect(contarTurnosDoLead([u("oi")])).toBe(1);
  });
});
