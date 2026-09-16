import { describe, expect, it } from "vitest";

import {
  detectForeignSender,
  isCourtesyMessage,
  isCourtesyOnlyBurst,
  stripQuotePrefix,
  withQuotePrefix,
} from "./conversation-guards";
import { buildConversationKey, normalizeBrazilPhone } from "./conversation-channel.server";

// Caso real: Odonto Sorrisos, Rodrigo (38) 99881-0514, 16/09/2026.
//
//   07:39  clínica  "Feliz aniversário, RODRIGO!"            (envio manual)
//   09:38  lead     "Bom dia"
//   09:38  lead     "Muito obgd"                              (citando o parabéns)
//   09:38  IA       "Para finalizar seu agendamento, me confirma qual dos dois
//                    horários de manhã funciona melhor pra você?"
//
// O contato estava na Helena só com o LID do WhatsApp ("Número privado"), sem
// telefone. A mensagem ENVIADA pela clínica tem como remetente a própria
// clínica, e virou a chave da conversa — a mesma para todo contato sem
// telefone. A resposta dele caiu numa conversa com 1.724 mensagens e 161
// remetentes desde junho, com o lead_data e o estágio SLOT_OFFER de outra
// pessoa. A citação (campo refId da Helena) nunca foi lida, e nada impedia a IA
// de empurrar horário em cima de um agradecimento.

const CLINICA = "+5587996030402";
const RODRIGO = "+5538998810514";

describe("chave da conversa não pode ser o número da clínica", () => {
  it("é esse o defeito: envio da clínica p/ contato sem telefone vira a chave da clínica", () => {
    // fromDetails de uma mensagem ENVIADA é quem enviou — a própria clínica.
    expect(
      buildConversationKey({ channel: "whatsapp", fromDetails: CLINICA, contactPhone: "" }),
    ).toBe("87996030402");
  });

  it("sem fromDetails (como o webhook passa a chamar no envio), a chave sai da sessão", () => {
    expect(
      buildConversationKey({
        channel: "whatsapp",
        fromDetails: null,
        contactPhone: "",
        sessionId: "5d4763f9-3880-40b2-90e4-71c174abbb81",
      }),
    ).toBe("sess:5d4763f9-3880-40b2-90e4-71c174abbb81");
  });

  it("mensagem RECEBIDA continua usando o telefone de quem escreveu", () => {
    expect(
      buildConversationKey({ channel: "whatsapp", fromDetails: RODRIGO, contactPhone: "" }),
    ).toBe("38998810514");
  });
});

describe("detectForeignSender", () => {
  const n = normalizeBrazilPhone;

  it("o turno real: Rodrigo escreve numa conversa em que só outros falavam", () => {
    const v = detectForeignSender(
      [
        { from: "+5587991610895" },
        { from: "+5587991610895" },
        { from: RODRIGO },
        { from: RODRIGO },
      ],
      n,
    );
    expect(v.foreign).toBe(true);
    expect(v.current).toBe("38998810514");
    expect(v.previous).toEqual(["87991610895"]);
  });

  it("o mesmo contato falando de novo não é estranho", () => {
    expect(
      detectForeignSender([{ from: RODRIGO }, { from: RODRIGO }, { from: RODRIGO }], n).foreign,
    ).toBe(false);
  });

  it("formatos diferentes do MESMO número não disparam", () => {
    expect(
      detectForeignSender([{ from: "5538998810514" }, { from: "(38) 99881-0514" }], n).foreign,
    ).toBe(false);
  });

  it("conversa nova (ninguém falou antes) nunca é estranha", () => {
    expect(detectForeignSender([{ from: RODRIGO }], n).foreign).toBe(false);
  });

  it("sem telefone para comparar, não acusa (Instagram, remetente ausente)", () => {
    expect(detectForeignSender([{ from: RODRIGO }, { from: null }], n).foreign).toBe(false);
    expect(detectForeignSender([{ from: null }, { from: RODRIGO }], n).foreign).toBe(false);
  });
});

describe("citação", () => {
  it("prefixo e remoção são simétricos", () => {
    const gravado = withQuotePrefix("Feliz aniversário, RODRIGO!", "Muito obgd");
    expect(gravado.startsWith('[Em resposta à mensagem: "Feliz aniversário')).toBe(true);
    expect(stripQuotePrefix(gravado)).toBe("Muito obgd");
  });

  it("mensagem sem citação passa intacta", () => {
    expect(stripQuotePrefix("Bom dia")).toBe("Bom dia");
  });
});

describe("cortesia não é resposta de agendamento", () => {
  it("a rajada real do Rodrigo é só cortesia", () => {
    expect(isCourtesyOnlyBurst(["Bom dia", "Muito obgd"])).toBe(true);
    expect(
      isCourtesyOnlyBurst([
        "Bom dia",
        withQuotePrefix("Feliz aniversário, RODRIGO! A Odonto Sorrisos deseja...", "Muito obgd"),
      ]),
    ).toBe(true);
  });

  it("só saudação NÃO basta — o lead pode estar voltando para escolher", () => {
    expect(isCourtesyOnlyBurst(["Bom dia"])).toBe(false);
    expect(isCourtesyOnlyBurst(["Oi", "Boa tarde"])).toBe(false);
  });

  it("agradecimento que carrega uma escolha NÃO é cortesia", () => {
    expect(isCourtesyMessage("Obrigada, pode ser às 10h")).toBe(false);
    expect(isCourtesyMessage("obrigado, quinta serve?")).toBe(false);
    expect(isCourtesyMessage("valeu, pode ser de tarde")).toBe(false);
    expect(isCourtesyOnlyBurst(["Obrigada", "Pode ser às 11:00"])).toBe(false);
  });

  it("agradecimentos comuns são reconhecidos", () => {
    for (const t of ["Muito obgd", "Obrigada!", "obrigado", "Valeu", "Deus te abençoe"]) {
      expect(isCourtesyMessage(t)).toBe(true);
    }
  });
});

describe("follow-up respeita as travas", () => {
  it("cala em conversa misturada e depois de um agradecimento", async () => {
    const { followupHeldByConversationGuards } = await import("./conversation-guards");
    expect(
      followupHeldByConversationGuards({ foreign_sender_blocked_at: "2026-09-16T12:38:57Z" }),
    ).toBe(true);
    expect(followupHeldByConversationGuards({ courtesy_hold_at: "2026-09-16T12:38:57Z" })).toBe(
      true,
    );
    expect(followupHeldByConversationGuards({ stage: "SLOT_OFFER" })).toBe(false);
    expect(followupHeldByConversationGuards(null)).toBe(false);
  });
});

describe("saudação com emoji", () => {
  it("reconhece emoji simples e com seletor de variação no fim", async () => {
    const { isCourtesyOnlyBurst } = await import("./conversation-guards");
    expect(isCourtesyOnlyBurst(["Bom dia 😊", "Obrigada ❤️"])).toBe(true);
    expect(isCourtesyOnlyBurst(["Oi ☺️", "Valeu 🙏"])).toBe(true);
  });
});
