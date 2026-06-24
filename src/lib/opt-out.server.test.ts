// Testes do detector de opt-out (sair / parar de receber).
// isOptOutMessage é pura (só texto), então testamos diretamente.

import { describe, expect, it } from "vitest";

import { isOptOutMessage } from "./opt-out.server";

describe("isOptOutMessage — comando 'sair' em qualquer caixa", () => {
  for (const v of [
    "sair",
    "SAIR",
    "Sair",
    "SaIr",
    " sair ",
    "sair.",
    "sair!",
    "/sair",
    "*Lead:* SAIR",
  ]) {
    it(`reconhece ${JSON.stringify(v)}`, () => {
      expect(isOptOutMessage(v)).toBe(true);
    });
  }
});

describe("isOptOutMessage — frases pedindo para não receber mais", () => {
  const frases = [
    "não quero receber mais mensagens",
    "Nao quero mais receber nada",
    "Por favor, pare de me enviar mensagens",
    "para de me mandar mensagem",
    "quero me descadastrar dessa lista",
    "me remova da lista por favor",
    "cancelar inscrição",
    "não me perturbe mais",
    "para de me incomodar",
    "não enviar mais mensagens",
  ];
  for (const f of frases) {
    it(`reconhece ${JSON.stringify(f)}`, () => {
      expect(isOptOutMessage(f)).toBe(true);
    });
  }
});

describe("isOptOutMessage — NÃO dispara em falsos positivos", () => {
  const naoOptOut = [
    "vou sair de casa agora",
    "posso sair às 15h?",
    "quero parar na recepção",
    "vou parar aí amanhã",
    "qual o endereço da clínica?",
    "quero agendar uma consulta",
    "obrigado, até mais",
    "",
    "   ",
  ];
  for (const m of naoOptOut) {
    it(`ignora ${JSON.stringify(m)}`, () => {
      expect(isOptOutMessage(m)).toBe(false);
    });
  }
});

describe("isOptOutMessage — comandos extras do settings", () => {
  it("aceita comando extra configurado", () => {
    expect(isOptOutMessage("remove-me", "cancela, remove-me")).toBe(true);
    expect(isOptOutMessage("cancela", "cancela, remove-me")).toBe(true);
  });
  it("não afeta os defaults quando extras vazios", () => {
    expect(isOptOutMessage("sair", "")).toBe(true);
    expect(isOptOutMessage("sair", null)).toBe(true);
  });
});
