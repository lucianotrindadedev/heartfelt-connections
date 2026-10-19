// Instagram/Messenger: a transferência para a equipe espera o telefone.
// Caso real (Clínica Bomfim, @andersonavelar310.aa, 17/10): escalou para a CRC
// do Recreio sem pedir o WhatsApp — a equipe ficou sem como falar com o lead.
import { describe, expect, it } from "vitest";
import {
  buildChannelPhonePromptBlock,
  escalationDoneReply,
  escalationPhoneAskReply,
  isEscalationAwaitingPhone,
  shouldHoldEscalationForPhone,
} from "./booking-template";

type Msg = { role: "user" | "assistant"; content: string };

// Conversa real, resumida, até o turn que escalou.
const anderson: Msg[] = [
  { role: "user", content: "Quanto custam seus serviços?" },
  { role: "assistant", content: "Boa tarde! 😊 Eu sou a Flávia… Me conta: qual é o seu nome e o que está acontecendo com o seu sorriso no momento?" },
  { role: "user", content: "Ola  me chamo Anderson" },
  { role: "assistant", content: "Oi, Anderson! Que bom falar com você 😊 Agora me conta: o que está acontecendo com o seu sorriso no momento?" },
  { role: "user", content: "Vcs estão localizados em qual bairro" },
  { role: "assistant", content: "Temos unidade em Jacarepaguá… e no Recreio. Qual unidade fica melhor para você?" },
  { role: "user", content: "Recreio dos Bandeirantes" },
];

describe("shouldHoldEscalationForPhone", () => {
  it("Instagram sem telefone e sem pedido recente → segura (o caso do Anderson)", () => {
    expect(shouldHoldEscalationForPhone({ channel: "instagram", hasPhone: false, history: anderson })).toBe(true);
  });

  it("Messenger sem telefone → segura também", () => {
    expect(shouldHoldEscalationForPhone({ channel: "messenger", hasPhone: false, history: anderson })).toBe(true);
  });

  it("WhatsApp nunca segura — o telefone é o próprio canal", () => {
    expect(shouldHoldEscalationForPhone({ channel: "whatsapp", hasPhone: false, history: anderson })).toBe(false);
  });

  it("Instagram com telefone já coletado → não segura", () => {
    expect(shouldHoldEscalationForPhone({ channel: "instagram", hasPhone: true, history: anderson })).toBe(false);
  });

  it("telefone já pedido nas últimas falas → não segura (lead recusou ou ignorou: transfere mesmo assim)", () => {
    const pediu: Msg[] = [
      ...anderson,
      { role: "assistant", content: escalationPhoneAskReply("Anderson") },
      { role: "user", content: "prefiro não passar" },
    ];
    expect(shouldHoldEscalationForPhone({ channel: "instagram", hasPhone: false, history: pediu })).toBe(false);
  });

  it("pedido antigo (fora das 3 últimas falas do agente) não vale — pede de novo antes de transferir", () => {
    const antigo: Msg[] = [
      { role: "assistant", content: "Me passa seu WhatsApp com DDD?" },
      { role: "user", content: "depois" },
      ...anderson,
    ];
    expect(shouldHoldEscalationForPhone({ channel: "instagram", hasPhone: false, history: antigo })).toBe(true);
  });
});

describe("pedido de telefone e retomada da transferência", () => {
  it("o pedido usa o primeiro nome e pede WhatsApp com DDD", () => {
    const r = escalationPhoneAskReply("Anderson Avelar");
    expect(r).toMatch(/^Perfeito, Anderson!/);
    expect(r).toMatch(/WhatsApp com DDD/);
    expect(escalationPhoneAskReply(null)).toMatch(/^Perfeito! /);
  });

  it("depois do pedido, com motivo no lead_data, a transferência está pendente", () => {
    const h: Msg[] = [
      ...anderson,
      { role: "assistant", content: escalationPhoneAskReply("Anderson") },
      { role: "user", content: "21 99999-1234" },
    ];
    expect(isEscalationAwaitingPhone(h, "unidade Recreio")).toBe(true);
    expect(isEscalationAwaitingPhone(h, "")).toBe(false);
  });

  it("se o agente falou outra coisa depois do pedido, não força", () => {
    const h: Msg[] = [
      ...anderson,
      { role: "assistant", content: escalationPhoneAskReply("Anderson") },
      { role: "user", content: "qual o endereço?" },
      { role: "assistant", content: "Fica no Recreio, a equipe te passa certinho." },
      { role: "user", content: "ok" },
    ];
    expect(isEscalationAwaitingPhone(h, "unidade Recreio")).toBe(false);
  });

  it("resposta de transferência concluída", () => {
    expect(escalationDoneReply("Anderson")).toMatch(/^Obrigada, Anderson! Já passei seu atendimento/);
    expect(escalationDoneReply(undefined)).toMatch(/^Obrigada! /);
  });
});

describe("instrução de telefone para Instagram", () => {
  it("pede o WhatsApp logo no início e antes de transferir, não só antes de agendar", () => {
    const b = buildChannelPhonePromptBlock("instagram", null);
    expect(b).toMatch(/primeira resposta/);
    expect(b).toMatch(/ESCALATED/);
  });
  it("WhatsApp com telefone continua mandando NÃO perguntar", () => {
    expect(buildChannelPhonePromptBlock("whatsapp", "21999991234")).toMatch(/NÃO PERGUNTE/);
  });
});
