// Respostas reais (Sorriso Saúde, set/2026) em que a IA prometeu consultar a
// agenda sem ter consultado. promisesAvailabilityCheck decide quando o
// scheduler faz a busca de verdade e gera a resposta de novo.
import { describe, expect, it } from "vitest";
import { promisesAvailabilityCheck } from "./stage-signals";

describe("promisesAvailabilityCheck", () => {
  it.each([
    "Deixa eu verificar a disponibilidade a partir das 15 horas para você.",
    "Perfeito! Vou verificar os horários da semana que vem para você.",
    "Entendi, Claudecy. Deixa eu verificar outras opções para você nos próximos dias.",
    "Tudo bem, Josias. Deixa eu confirmar isso certinho com a equipe e já te retorno com mais opções, pode ser?",
    "Entendi. Deixa eu verificar outros dias à tarde para você.",
    "Perfeito, Josias Santos! 😊\n\nAgora vou verificar os horários disponíveis para sua Consulta de Diagnóstico com a gente.",
    "Perfeito! Vou verificar se consigo um horário de 9h30 na segunda ou 15h30 à tarde para você.",
  ])("promete verificar: %s", (reply) => {
    expect(promisesAvailabilityCheck(reply)).toBe(true);
  });

  it.each([
    // Oferta de verdade (tem pergunta): não é enrolação.
    "Tenho sexta-feira, 18/09 às 15:00. Fica bom pra você?",
    // Enrolação, mas não é de agenda.
    "Perfeito! Vou finalizar seu cadastro agora.",
    // Pedido de dado é progresso.
    "Me passa seu nome completo, por favor, que eu já consulto os horários disponíveis pra você",
  ])("não dispara: %s", (reply) => {
    expect(promisesAvailabilityCheck(reply)).toBe(false);
  });
});
