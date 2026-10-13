// Trava do follow-up contextual. Casos reais tirados de followup_step_runs
// (varredura de 90 dias, scripts/diag/followup-trava-corpus.diag.ts).
import { describe, expect, it } from "vitest";
import { avaliarTextoDoFollowup, FOLLOWUP_SKIP_TOKEN } from "@/lib/followup-guard";

const pula = (t: string) => avaliarTextoDoFollowup(t).action === "skip";

describe("avaliarTextoDoFollowup — barra texto que fala com a equipe", () => {
  it.each([
    // Odonto Carioca Campo Grande, 21 98009-7705 (27 e 28/09)
    "Desculpe, mas preciso do histórico real da conversa com este lead para gerar um follow-up personalizado e genuíno.\n\nVocê pode me fornecer:\n- Nome do lead (se tiver)",
    "Não consigo gerar o follow-up sem o histórico real da conversa.\n\nPode compartilhar o histórico da conversa?",
    // Recusa COM motivo, mandada a quem pediu para parar (Costa Lima, 22/09)
    "**NÃO ENVIAR FOLLOW-UP**\n\nO lead pediu explicitamente para **encerrar a conversa**.",
    // Sorriamed Barra, 19/09
    "Não há contexto válido para follow-up neste caso. Este número foi identificado pelo sistema como sendo exclusivo para autenticação.",
    // Variações sem a palavra follow-up
    "Preciso do contexto completo da conversa para escrever algo personalizado. Poderia compartilhar?",
    "Sem o histórico da conversa eu geraria algo genérico para esse lead.",
  ])("barra: %s", (t) => {
    expect(pula(t)).toBe(true);
  });

  it("registra o motivo", () => {
    const v = avaliarTextoDoFollowup("Não consigo gerar o follow-up sem o histórico.");
    expect(v).toEqual({ action: "skip", reason: expect.stringMatching(/follow-up/) });
  });
});

describe("avaliarTextoDoFollowup — PULAR", () => {
  it.each([FOLLOWUP_SKIP_TOKEN, "pular", "  PULAR.", "**PULAR**", '"PULAR"'])("pula: %s", (t) => {
    expect(avaliarTextoDoFollowup(t)).toEqual({ action: "skip", reason: expect.stringMatching(/PULAR/) });
  });
  it("vazio também não é enviado", () => {
    expect(pula("   ")).toBe(true);
  });
});

describe("avaliarTextoDoFollowup — deixa passar mensagem boa", () => {
  it.each([
    "Oi! Tudo bem? 😊 Me conta, o que você está buscando para o seu sorriso?",
    // Menções legítimas a "sistema" (barradas pela 1ª versão da trava)
    "Raphael, só tô aqui pra confirmar seu horário no sistema! Me passa seu WhatsApp com DDD?",
    "Ó, só falta eu ter seu nome pra colocar aqui no nosso sistema e deixar tudo certo pra sexta 09:00!",
    "Opa, ficou curioso pelo sistema? 😄 Mas já que você tá por aqui, me conta: tem algo específico que te incomoda?",
    // "histórico" do PACIENTE, não da conversa
    "Oi! Imagino como é chato essa prótese superior — com seu histórico do implante perdido, vale avaliar presencialmente, né?",
    "Jô, conversei com o nosso especialista e ele confirmou que dá para usar sua prótese atual como modelo. 😊 Que dia fica melhor?",
    "Pulando de alegria aqui: consegui um horário pra você amanhã às 10h! Pode ser?",
    // Negrito do WhatsApp (um asterisco) é normal
    "Seu horário está *reservado* para quinta às 14:00. Posso confirmar?",
  ])("passa: %s", (t) => {
    expect(avaliarTextoDoFollowup(t)).toEqual({ action: "send" });
  });
});

// O modelo decide não mandar nada e, em vez de PULAR, explica a decisão — e a
// explicação ia para o lead. Os 8 casos reais de 90 dias (todos liberados pela
// versão anterior da trava). Caso que abriu: Clínica Bomfim, 21 98127-9491, 13/10.
describe("avaliarTextoDoFollowup — barra explicação de 'não há mensagem a enviar'", () => {
  it.each([
    "Não há próxima mensagem a enviar neste momento. Aguardando resposta de Rahyane sobre a disponibilidade de ver os horários.",
    "Não há mensagem a enviar neste momento. Estou aguardando a resposta de Priscila sobre qual dos dois horários (15:00 ou 15:30 na quinta-feira) ela prefere para a consulta",
    "Aguardando resposta de Marcela. Não há novo contexto para enviar mensagem neste momento.",
    "Neste momento, estou aguardando a resposta de Maria sobre qual unidade fica melhor para ela. Não há mensagem a enviar agora.",
    "Estou aguardando a resposta do José Augusto sobre qual horário ele prefere: 9hs ou 10hs no dia 13/10.\n\nNão há nova mensagem a enviar neste momento",
    "Estou aguardando a resposta de Gisele para continuar com a próxima mensagem. Ela ainda não respondeu à minha pergunta sobre há quanto tempo está sem o dente",
    "Aguardando resposta de Marta à pergunta anterior. Não há mensagem para enviar neste momento.",
    "Estou aguardando a resposta de Ozania sobre sua situação. Sem essa informação, não devo enviar próxima mensagem.",
  ])("barra: %s", (t) => {
    expect(pula(t)).toBe(true);
  });

  it.each([
    // Mesmas palavras falando COM o lead
    "Fico aguardando sua resposta, Rahyane! Ainda está com dor? Quer que eu veja os horários mais próximos?",
    "Estou aguardando seu retorno pra reservar o horário, tá? 😊",
    // Caso real que casava com uma 1ª versão da regra (follow-up legítimo, 09/10)
    "Pra não enviar coisas que não te interessam: você procura uma formação pessoal, algo pra sua escola/equipe, ou consultoria estratégica? 😊",
  ])("passa: %s", (t) => {
    expect(avaliarTextoDoFollowup(t)).toEqual({ action: "send" });
  });
});
