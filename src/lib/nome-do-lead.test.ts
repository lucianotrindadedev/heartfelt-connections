import { describe, expect, it } from "vitest";

import {
  looksLikeIntentMessage,
  looksLikeSentenceNotName,
  sanitizeLeadDataPatch,
} from "./booking-template";

// ── Caso Odonto Carioca Campo Grande, (21) 96543-1529, 07–13/08 ────────────
// A lead mandou o nome completo QUATRO vezes ao longo de seis dias. Toda vez o
// nome foi descartado na captura e o agente pediu de novo. Ela desistiu:
// "Ja confirmei tudo e vc nao resolve nada tchau".
//
// Duas causas independentes, as duas cobertas aqui:
//   1. o nome tem 7 palavras e o limite era 6;
//   2. "Filho"/"Filha" — sobrenomes comuns — colidiam com "meu filho".
//
// A assimetria deste fluxo é o OPOSTO da do agendamento: recusar um nome válido
// trava a conversa em loop até o lead sair; aceitar um nome estranho custa uma
// correção na recepção. Na dúvida, aceita.

/** É aceito como nome do paciente? (o que a captura de fato faz) */
function aceitoComoNome(texto: string): boolean {
  const patch = sanitizeLeadDataPatch(
    { name: texto },
    { current: {}, lastAssistantText: "Para finalizar, me envia por favor seu nome completo?" },
  );
  return typeof patch.name === "string" && patch.name.trim().length > 0;
}

describe("nomes reais de lead PRECISAM ser aceitos", () => {
  it("o nome literal do caso (7 palavras)", () => {
    expect(aceitoComoNome("Karla deborah da Silva nunes de lima")).toBe(true);
  });

  it("sobrenome Filho/Filha não é 'meu filho'", () => {
    for (const n of [
      "Relandy Izabel Filho",
      "Jose herminio filho",
      "Ana Paula Filha",
      "Antonio Carlos Ribeiro Filho",
    ]) {
      expect(aceitoComoNome(n), n).toBe(true);
    }
  });

  it("nomes brasileiros longos, com partículas", () => {
    for (const n of [
      "Maria da Conceicao dos Santos Oliveira Lima",
      "Ana Lucia Valentim do Nascimento",
      "Wagner Walter Santos dos Santos",
      "Maria Cleonice Silva Lopes",
      "Jenny Dias Pereira",
      "Luiz Antonio da Silva Pereira de Souza Neto",
    ]) {
      expect(aceitoComoNome(n), n).toBe(true);
    }
  });

  it("o limite de palavras só corta o que já não é nome plausível", () => {
    // 10 palavras ainda é nome; 11 já não.
    expect(
      looksLikeIntentMessage("Ana Beatriz da Silva dos Santos Lima Costa Pereira Neto"),
    ).toBe(false); // 10
    expect(
      looksLikeIntentMessage("Ana Beatriz da Silva dos Santos Lima Costa Pereira Neto Junior"),
    ).toBe(true); // 11
  });
});

describe("frases NÃO podem virar o nome do paciente", () => {
  it("as frases exatas que o caso real gravou", () => {
    // "Ja te mandei" foi salvo como name e travou a conversa por seis dias.
    for (const t of [
      "Ja te mandei",
      "Jesus já mandei",
      "Já mandei meu nome completo.",
      "Ja mandei meu nome verificar ai por favor",
      "Esquece o atendimento de vcs e péssimo já mandei meu nome completo várias vesez",
    ]) {
      expect(aceitoComoNome(t), t).toBe(false);
    }
  });

  it("pergunta sobre a clínica em 3ª pessoa (escapava dos DOIS classificadores)", () => {
    // Real: uma conversa tinha name="Fazem atendimento aos sábados".
    for (const t of [
      "Fazem atendimento aos sábados",
      "Vocês atendem convênio",
      "Aceitam cartão",
      "Trabalham com implante",
    ]) {
      expect(aceitoComoNome(t), t).toBe(false);
    }
  });

  it("intenção e saudação continuam barradas (sem regressão)", () => {
    for (const t of [
      "Gostaria de informações",
      "Gostaria de saber se consegue me atender",
      "Bom dia",
      "Eu preciso ir aí e ver tudo isso",
      "No momento eu não vou na consulta",
      "Estes horário da para mim comparecer",
      "Neste horário não tenho como comparecer não",
      "Quero muito resolver logo meu sorriso",
    ]) {
      expect(aceitoComoNome(t), t).toBe(false);
    }
  });

  it("'meu filho'/'minha filha' seguem sendo intenção, não nome", () => {
    for (const t of [
      "é para o meu filho",
      "quero para minha filha",
      "a consulta é da filha",
      "vou levar o filho",
    ]) {
      expect(looksLikeIntentMessage(t), t).toBe(true);
    }
  });
});

describe("looksLikeSentenceNotName — a segunda barreira", () => {
  it("aceita nome, rejeita frase", () => {
    expect(looksLikeSentenceNotName("Karla deborah da Silva nunes de lima")).toBe(false);
    expect(looksLikeSentenceNotName("Relandy Izabel Filho")).toBe(false);
    expect(looksLikeSentenceNotName("Ja te mandei")).toBe(true);
    expect(looksLikeSentenceNotName("Fazem atendimento aos sábados")).toBe(true);
  });
});
