// Caso real (Odonto Sorrisos, Rosa Maria de Souza, 87 99996-1903, 19/09/2026).
//
// O create do Clinicorp falhou às 09:04. O scheduler fez a coisa certa: gerou
// TECH_RETRY_REPLY, o aviso honesto de "deu problema técnico, já tento de
// novo". A lead nunca leu esse aviso.
//
// TECH_RETRY_REPLY contém "só um instantinho" — exatamente o padrão que
// looksLikeStallReply caça. A trava anti-enrolação do orquestrador classificou
// o aviso como enrolação do modelo e trocou por "Quase lá! Só me confirma que
// posso garantir esse horário pra você que eu finalizo o agendamento. 😊".
//
// No meta da mensagem ficou a prova: stall_reply_blocked=true e
// reply_llm_original com o texto que ela deveria ter recebido.
//
// Efeito: a lead respondeu "Sim" achando que faltava confirmação DELA. A 2ª
// tentativa falhou igual e a conversa escalou com falha_tecnica_agendamento.
// Ela passou nome, escolheu horário e confirmou — e saiu sem agendamento e sem
// nunca saber que o problema era do nosso lado desde o primeiro minuto.
//
// A trava existe para promessa vazia do MODELO. TECH_RETRY_REPLY é fala fixa do
// nosso código, e a nova tentativa acontece de fato no turno seguinte.

import { describe, expect, it } from "vitest";

import { TECH_ESCALATE_REPLY, TECH_RETRY_REPLY, isTechRetryReply } from "./booking-failure";
import { looksLikeStallReply } from "./stage-signals";

/** A condição exata do guard em orchestrator.server.ts. */
const travaEngole = (reply: string) => looksLikeStallReply(reply) && !isTechRetryReply(reply);

describe("aviso de retry técnico x trava anti-enrolação", () => {
  it("o aviso AINDA parece enrolação para o detector genérico (por isso a isenção existe)", () => {
    // Se algum dia isto virar false, a isenção ficou redundante — mas inofensiva.
    expect(looksLikeStallReply(TECH_RETRY_REPLY)).toBe(true);
  });

  it("REGRESSÃO: a trava NÃO engole mais o aviso de retry técnico", () => {
    expect(isTechRetryReply(TECH_RETRY_REPLY)).toBe(true);
    expect(travaEngole(TECH_RETRY_REPLY)).toBe(false);
  });

  it("reconhece o aviso mesmo com algo emendado antes (joinLeadIn e afins)", () => {
    expect(isTechRetryReply(`Rosa Maria, ${TECH_RETRY_REPLY}`)).toBe(true);
  });

  it("a fala de escalada não depende da isenção (nunca pareceu enrolação)", () => {
    expect(looksLikeStallReply(TECH_ESCALATE_REPLY)).toBe(false);
    expect(travaEngole(TECH_ESCALATE_REPLY)).toBe(false);
  });

  it("enrolação de verdade do modelo continua sendo barrada", () => {
    // Casos reais que motivaram a trava (Costa Lima Recreio 15/07, MF Beauty
    // BSB 11/07): promessa de buscar agenda que nunca se cumpre.
    for (const enrolacao of [
      "Deixa eu verificar os horários disponíveis pra você!",
      "Como você trabalha pela manhã, vou buscar as opções da tarde. Só um instantinho.",
      "Vou encaminhar você agora mesmo pra nossa agenda. Só um minutinho!",
      "Só um instantinho que já te trago as opções.",
    ]) {
      expect(travaEngole(enrolacao)).toBe(true);
    }
  });

  it("a isenção é estreita: não libera qualquer frase com 'problema técnico'", () => {
    expect(
      isTechRetryReply("Tive um problema técnico aqui, me dá um instantinho que já volto!"),
    ).toBe(false);
  });
});
