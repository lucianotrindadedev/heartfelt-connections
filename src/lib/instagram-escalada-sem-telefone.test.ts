// Instagram/Messenger: a transferência para a equipe espera o telefone.
// Caso real (Clínica Bomfim, @andersonavelar310.aa, 17/10): escalou para a CRC
// do Recreio sem pedir o WhatsApp — a equipe ficou sem como falar com o lead.
import { describe, expect, it } from "vitest";
import {
  buildChannelPhonePromptBlock,
  comPedidoDeWhatsapp,
  escalationDoneReply,
  escalationPhoneAskReply,
  isEscalationAwaitingPhone,
  precisaPedirWhatsapp,
  shouldHoldEscalationForPhone,
  WHATSAPP_NO_INICIO_SETTING,
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
    expect(shouldHoldEscalationForPhone({ channel: "instagram", hasPhone: false })).toBe(true);
  });

  it("Messenger sem telefone → segura também", () => {
    expect(shouldHoldEscalationForPhone({ channel: "messenger", hasPhone: false })).toBe(true);
  });

  it("WhatsApp nunca segura — o telefone é o próprio canal", () => {
    expect(shouldHoldEscalationForPhone({ channel: "whatsapp", hasPhone: false })).toBe(false);
  });

  it("Instagram com telefone já coletado → não segura", () => {
    expect(shouldHoldEscalationForPhone({ channel: "instagram", hasPhone: true })).toBe(false);
  });

  it("OBRIGATÓRIO: mesmo depois de pedido, sem número a transferência continua segurada", () => {
    // Antes (até 28/10) o lead que recusava ou ignorava era transferido sem
    // número; agora a equipe só recebe o lead com o WhatsApp.
    expect(shouldHoldEscalationForPhone({ channel: "instagram", hasPhone: false })).toBe(true);
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

describe("WhatsApp obrigatório no Instagram/Messenger", () => {
  const base = { hasPhone: false, settings: {} as Record<string, string> };

  it("identificado o lead (tem nome) e sem número → pede", () => {
    expect(precisaPedirWhatsapp({ ...base, channel: "instagram", leadName: "Anderson" })).toBe(true);
    expect(precisaPedirWhatsapp({ ...base, channel: "messenger", leadName: "Anderson" })).toBe(true);
  });

  it("antes do nome não pede — a não ser com whatsapp_no_inicio (Game Point)", () => {
    expect(precisaPedirWhatsapp({ ...base, channel: "instagram", leadName: null })).toBe(false);
    expect(
      precisaPedirWhatsapp({
        ...base,
        channel: "instagram",
        leadName: null,
        settings: { [WHATSAPP_NO_INICIO_SETTING]: "true" },
      }),
    ).toBe(true);
  });

  it("com número coletado ou no WhatsApp → não pede", () => {
    expect(precisaPedirWhatsapp({ ...base, hasPhone: true, channel: "instagram", leadName: "Anderson" })).toBe(false);
    expect(precisaPedirWhatsapp({ ...base, channel: "whatsapp", leadName: "Anderson" })).toBe(false);
  });

  it("acrescenta o pedido só quando a resposta ainda não pede o número", () => {
    const r = comPedidoDeWhatsapp("Que legal, Anderson! Qual unidade fica melhor pra você?");
    expect(r).toBe(
      "Que legal, Anderson! Qual unidade fica melhor pra você?\n\nMe passa também seu WhatsApp com DDD? É por ele que a nossa equipe fala com você 😊",
    );
    const jaPede = "Perfeito! Me informa seu WhatsApp com DDD?";
    expect(comPedidoDeWhatsapp(jaPede)).toBe(jaPede);
  });

  it("o pedido insistente mantém a transferência pendente no turno seguinte", () => {
    const h: Msg[] = [
      ...anderson,
      { role: "assistant", content: escalationPhoneAskReply("Anderson", true) },
      { role: "user", content: "não quero passar" },
    ];
    expect(escalationPhoneAskReply("Anderson", true)).toMatch(/^Anderson, antes de te passar.*preciso do seu número de WhatsApp/);
    expect(isEscalationAwaitingPhone(h, "unidade Recreio")).toBe(true);
  });

  it("instrução do prompt: obrigatório e, com whatsapp_no_inicio, nome + WhatsApp na 1ª resposta", () => {
    expect(buildChannelPhonePromptBlock("instagram", null)).toMatch(/OBRIGATÓRIO/);
    expect(
      buildChannelPhonePromptBlock("instagram", null, { [WHATSAPP_NO_INICIO_SETTING]: "true" }),
    ).toMatch(/PRIMEIRA resposta, peça o NOME e o WhatsApp/);
  });
});
