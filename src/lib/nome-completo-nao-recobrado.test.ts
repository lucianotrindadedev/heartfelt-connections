import { describe, expect, it } from "vitest";

import {
  bookingFieldQuestion,
  getBookingFields,
  getMissingBookingFields,
  looksLikeSentenceNotName,
} from "./booking-template";

// Caso real: Odonto Carioca Campo Grande, Adriana Amazonas de Araújo
// (21) 98746-4703, 24/08/2026.
//
//   10:31  lead    "Adriana Amazonas de Araújo"
//   10:41  agente  "Desculpa insistir! Só me confirma o sobrenome do Adriana..."
//
// A segunda cobrança não veio do modelo: o reply original dele era uma oferta de
// horários, que a trava anti-loop (duplicate_reply_blocked) substituiu. O ramo
// da trava escolhia o texto pelo ESTÁGIO — effectiveStage era NAME_COLLECT só
// porque havia slot escolhido — e nunca olhava se ainda faltava algum campo.
//
// Que o nome estava completo é provado pelo próprio turno: o erro registrado foi
// intent_hold, e o portão de intenção roda DEPOIS de todas as barreiras de nome
// do criar_agendamento (campos pendentes → sobrenome → frase → validador LLM).
//
// Estes testes travam a invariante que o ramo passou a respeitar: com o nome
// completo não há campo pendente, logo não há o que recobrar.

const CLINICA: Record<string, string> = {}; // template padrão de clínica: só "name"

function pendentes(name: string) {
  return getMissingBookingFields(getBookingFields(CLINICA), { name } as never);
}

describe("a trava anti-loop não recobra nome já coletado", () => {
  it("nome completo da Adriana não deixa campo pendente", () => {
    expect(pendentes("Adriana Amazonas de Araújo")).toEqual([]);
  });

  it("primeiro nome sozinho continua pendente — e a pergunta pede só o sobrenome", () => {
    const missing = pendentes("Adriana");
    expect(missing).toHaveLength(1);
    expect(bookingFieldQuestion(missing[0]!, { name: "Adriana" } as never)).toBe(
      "Adriana, me confirma seu sobrenome? Preciso do nome completo pro cadastro.",
    );
  });

  it("nome com partícula conta como completo", () => {
    expect(pendentes("Ana de Souza")).toEqual([]);
    expect(pendentes("Ana de")).toHaveLength(1);
  });

  // O ramo mantém um segundo teste além de getMissingBookingFields: nome que é
  // FRASE tem 2+ palavras e passa por ele, mas nunca vira cadastro de paciente.
  // Caso real (Odonto Carioca Campo Grande, 21 96543-1529): name ficou preso em
  // "Ja te mandei" por seis dias.
  it("nome que é frase passa por getMissingBookingFields — por isso a checagem extra", () => {
    expect(pendentes("Ja te mandei")).toEqual([]);
    expect(looksLikeSentenceNotName("Ja te mandei")).toBe(true);
    expect(looksLikeSentenceNotName("Adriana Amazonas de Araújo")).toBe(false);
  });
});
