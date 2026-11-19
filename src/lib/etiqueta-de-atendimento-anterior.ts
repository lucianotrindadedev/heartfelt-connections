// "IA Desligada" herdada de um atendimento ANTERIOR não pode calar um lead que
// volta e abre um atendimento NOVO.
//
// Caso real (Alfa Implantes, 12–18/11/2026): 13 leads mandaram a mensagem do
// anúncio ("Tenho interesse na Prótese Protocolo…") e ninguém respondeu. Eram
// contatos de fevereiro a agosto que voltaram com a etiqueta "IA Desligada"
// de um atendimento antigo: a IA respeitava a etiqueta, a sessão nova da
// Helena ficava PENDENTE sem atendente, e o lead esperava para sempre. 30 na
// semana anterior.
//
// A etiqueta é removida só quando a sessão ATUAL ainda não teve nenhuma fala
// da clínica (IA, atendente ou o aparelho do WhatsApp): então quem pausou não
// foi ninguém deste atendimento. Pausa feita neste atendimento ("Olá!" da
// atendente, escalada, opt-out) sempre deixa uma fala da clínica ou um pedido
// de opt-out do lead na sessão, e aí a etiqueta fica.

export interface MensagemDaSessao {
  direction?: string | null;
  type?: string | null;
  text?: string | null;
}

/**
 * true = a etiqueta "IA Desligada" é de um atendimento anterior e pode sair.
 *
 * @param mensagens todas as mensagens da sessão ATUAL da Helena (qualquer ordem).
 * @param ehOptOut  reconhece pedido de opt-out do lead ("sair", "parar"...).
 */
export function etiquetaEhDeAtendimentoAnterior(
  mensagens: MensagemDaSessao[],
  ehOptOut: (texto: string) => boolean,
): boolean {
  if (mensagens.length === 0) return false; // sem dados = não arrisca
  for (const m of mensagens) {
    const dir = (m.direction ?? "").toUpperCase();
    const tipo = (m.type ?? "").toUpperCase();
    // TRACK = evento de rastreamento da própria Helena ("contato enviou
    // mensagem"), não é fala de ninguém.
    if (dir === "TO_HUB" && tipo !== "TRACK") return false;
    if (dir === "FROM_HUB" && m.text && ehOptOut(m.text)) return false;
  }
  return true;
}
