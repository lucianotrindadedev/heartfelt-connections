// Caso real (Clínica Bomfim, IG @lu.lopesf, 14/10/2026): a abertura pediu "Seu
// nome, Seu WhatsApp…"; dias depois a atendente perguntou "seu número de WhatsApp
// e qual é o seu bairro?" e a resposta "RECREIO, 964586771" virou o NOME da lead
// — a pergunta de nome antiga ainda estava na janela das 3 últimas falas.
// Varredura de 60 dias: 70 nomes gravados com dígito, nenhum nome de verdade.
import { describe, expect, it } from "vitest";

import {
  backfillBookingFieldsFromHistory,
  nameHasDigitsOrLink,
  sanitizeLeadDataPatch,
  tryAutoCaptureBookingAnswer,
} from "./booking-template";

type H = { role: "user" | "assistant"; content: string }[];
const SETTINGS = {};
// Instagram (sem telefone): no WhatsApp com telefone conhecido, pergunta que cita
// "WhatsApp" já pula a captura inteira — o caso real é do Instagram.
const IG = { channel: "instagram", effectivePhone: null } as never;

const ABERTURA =
  "Oi! 👋 Que legal receber sua mensagem!! Para iniciarmos seu atendimento informe por favor: Seu nome, Seu WhatsApp, E o que está acontecendo com o seu sorriso no momento?";

const nome = (h: H) => backfillBookingFieldsFromHistory({}, h, SETTINGS, IG).name;
const nomeAuto = (h: H) => tryAutoCaptureBookingAnswer("NAME_COLLECT", {}, h, SETTINGS, IG).name;

describe("a resposta é da pergunta MAIS RECENTE", () => {
  const LUCIANA: H = [
    { role: "user", content: "Quanto custam seus serviços?" },
    { role: "assistant", content: ABERTURA },
    { role: "user", content: "Gostaria de agendar uma consulta de avaliação" },
    {
      role: "assistant",
      content:
        "*Flávinha:*\nBom dia! Estamos voltando hoje do recesso do feriado. Vou iniciar seu atendimento. Pode me informar seu número de WhatsApp e qual é o seu bairro?😀",
    },
    { role: "user", content: "RECREIO, 964586771" },
  ];

  it("resposta ao bairro/WhatsApp não vira nome (caso Luciana)", () => {
    expect(nome(LUCIANA)).toBeUndefined();
    expect(nomeAuto(LUCIANA)).toBeUndefined();
  });

  it("nem só o bairro, sem número", () => {
    const h = [...LUCIANA.slice(0, -1), { role: "user" as const, content: "Recreio" }];
    expect(nome(h)).toBeUndefined();
  });

  it("resposta à pergunta de nome continua capturada", () => {
    expect(
      nome([
        { role: "assistant", content: ABERTURA },
        { role: "user", content: "Amanda Souza" },
      ]),
    ).toBe("Amanda Souza");
  });

  it("eco de uma bolha depois da resposta inteira não esconde a pergunta de nome", () => {
    const h: H = [
      {
        role: "assistant",
        content:
          "Bom dia! 😊 Tudo bem?\n\nAntes de falar sobre a avaliação, me conta: qual é o seu nome e o que está acontecendo com o seu sorriso no momento?",
      },
      { role: "assistant", content: "Bom dia! 😊 Tudo bem?" },
      { role: "user", content: "Rahyane" },
    ];
    expect(nome(h)).toBe("Rahyane");
  });

  it("'Como posso te chamar?' mais recente não barra o nome", () => {
    const h: H = [
      { role: "assistant", content: "Oi! Eu sou a Vivi, da Casa de Festas. Qual seu nome?" },
      {
        role: "assistant",
        content: "Oi! Tudo bem por aí? Como posso te chamar para te ajudar com isso? 😊",
      },
      { role: "user", content: "Rayane" },
    ];
    expect(nome(h)).toBe("Rayane");
  });

  it("fecho retórico ('…, tá?') não é pergunta nova", () => {
    const h: H = [
      { role: "assistant", content: "Me informa, por favor, seu nome completo." },
      {
        role: "assistant",
        content: "Sim, sim, eu vou mandar pra senhora já já o nosso endereço, tá? Tudo certinho.",
      },
      { role: "user", content: "Nadia Maria dos Santos Reis" },
    ];
    expect(nome(h)).toBe("Nadia Maria dos Santos Reis");
  });
});

describe("nome não tem número nem link", () => {
  it.each([
    "RECREIO, 964586771",
    "Pablo \n979983537",
    "Andre,meu tel é 996866945",
    "Fabio 70 convidados",
    "https://www.facebook.com/share/r/1Hu3bu9MJn/",
  ])("%j", (v) => {
    expect(nameHasDigitsOrLink(v)).toBe(true);
    expect(sanitizeLeadDataPatch({ name: v }).name).toBeUndefined();
    expect(
      nome([
        { role: "assistant", content: ABERTURA },
        { role: "user", content: v },
      ]),
    ).toBeUndefined();
  });

  it("nome comum passa", () => {
    expect(nameHasDigitsOrLink("Luciana Lopes")).toBe(false);
    expect(sanitizeLeadDataPatch({ name: "Luciana Lopes" }).name).toBe("Luciana Lopes");
  });
});
