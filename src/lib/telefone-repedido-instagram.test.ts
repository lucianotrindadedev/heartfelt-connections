import { describe, expect, it } from "vitest";

import { COLLECTED_PHONE_KEY, captureLeadPhoneFromHistory } from "./booking-template";
import { normalizeBrazilPhone } from "./conversation-channel.server";

// Caso real: Clínica Bomfim, Instagram @wallaceblacklima, 24/08/2026.
//
//   17:57:03  agente  "...informe por favor: Seu nome, Seu telefone, ..."
//   17:58:04  lead    "2198264-4836"
//   17:58:07  lead    "*Atenção:* o tipo da mensagem enviada pelo contato não é suportado."
//   17:58:46  agente  "Só para eu te atender direitinho, qual é o seu WhatsApp com DDD?"
//
// Duas portas fecharam ao mesmo tempo:
//  1) a captura só rodava em SLOT_OFFER/NAME_COLLECT/BOOKING e o stage era
//     RECEPTION — a conversa inteira ficou em RECEPTION/QUALIFICATION, então ela
//     nunca rodou uma vez sequer (corrigido no call-site do orchestrator);
//  2) ela lia SÓ a última mensagem do lead, e o aviso da plataforma tinha
//     acabado de virar a última — nenhum telefone ali.

const SETTINGS: Record<string, string> = {};
const IG = { channel: "instagram" as const, effectivePhone: null };
const hist = (...msgs: ["user" | "assistant", string][]) =>
  msgs.map(([role, content]) => ({ role, content }));

const PEDIDO =
  "Oi! Que legal receber sua mensagem!! Para iniciarmos seu atendimento informe por favor: " +
  "Seu nome, Seu telefone, E o que está acontecendo com o seu sorriso no momento?";
const AVISO = "*Atenção:* o tipo da mensagem enviada pelo contato não é suportado.";

function capturado(...msgs: ["user" | "assistant", string][]): string | undefined {
  const patch = captureLeadPhoneFromHistory(
    {} as never,
    hist(...msgs) as never,
    SETTINGS,
    IG,
    normalizeBrazilPhone,
  );
  return patch.custom_fields?.[COLLECTED_PHONE_KEY];
}

describe("telefone informado em rajada no Instagram", () => {
  it("acha o número mesmo com o aviso da plataforma depois dele", () => {
    expect(
      capturado(
        ["assistant", PEDIDO],
        ["user", "Meu nome é Wallace Henrique"],
        ["user", "2198264-4836"],
        ["user", AVISO],
      ),
    ).toBe("21982644836");
  });

  it("acha o número quando o lead emenda uma pergunta em seguida", () => {
    expect(
      capturado(
        ["assistant", PEDIDO],
        ["user", "2198264-4836"],
        ["user", "vocês atendem no sábado?"],
      ),
    ).toBe("21982644836");
  });

  it("na mesma rajada, o número CORRIGIDO é o que vale", () => {
    expect(
      capturado(
        ["assistant", "Me manda seu WhatsApp com DDD?"],
        ["user", "21982644836"],
        ["user", "opa, errei: 21987654321"],
      ),
    ).toBe("21987654321");
  });

  // ── O que NÃO pode voltar a passar ────────────────────────────────────────

  it("sem o agente ter pedido, número solto não vira telefone (pode ser CPF)", () => {
    expect(
      capturado(["assistant", "Qual o seu CPF?"], ["user", "11144477735"], ["user", AVISO]),
    ).toBeUndefined();
  });

  it("no WhatsApp com número do canal não coleta nada", () => {
    const patch = captureLeadPhoneFromHistory(
      {} as never,
      hist(["assistant", PEDIDO], ["user", "2198264-4836"]) as never,
      SETTINGS,
      { channel: "whatsapp" as const, effectivePhone: "21999998888" },
      normalizeBrazilPhone,
    );
    expect(patch.custom_fields).toBeUndefined();
  });

  it("não sobrescreve um telefone já coletado", () => {
    const patch = captureLeadPhoneFromHistory(
      { custom_fields: { [COLLECTED_PHONE_KEY]: "21911112222" } } as never,
      hist(["assistant", PEDIDO], ["user", "2198264-4836"]) as never,
      SETTINGS,
      IG,
      normalizeBrazilPhone,
    );
    expect(patch.custom_fields).toBeUndefined();
  });
});
