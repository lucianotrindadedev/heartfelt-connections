// Trava do follow-up contextual: decide se o texto que o modelo gerou pode ir
// para o lead.
//
// Caso real (Odonto Carioca Campo Grande, 21 98009-7705, 27–28/09): o lead só
// mandou um link do Facebook; o gerador, proibido de ser genérico e sem nada
// para citar, respondeu ao "(Sistema: ...)" como se falasse com um operador —
// "Não consigo gerar o follow-up sem o histórico real da conversa... Pode
// compartilhar o histórico?" — e o texto foi ENVIADO ao lead, duas vezes.
// Varredura de 90 dias: 29 mensagens assim em 17 conversas de 8 clínicas,
// inclusive recusas do tipo "**NÃO ENVIAR FOLLOW-UP** — o lead pediu para
// encerrar" mandadas justamente a quem pediu para não ser incomodado.

/** Resposta combinada: o modelo devolve só isto quando NÃO deve haver follow-up
 *  (lead pediu para parar, disse que não tem interesse, não é paciente...). */
export const FOLLOWUP_SKIP_TOKEN = "PULAR";

export type FollowupVeredito =
  | { action: "send" }
  | { action: "skip"; reason: string };

/** Frases de quem fala com a EQUIPE/SISTEMA, nunca com o lead. Tiradas das 29
 *  mensagens reais; cada uma sozinha já basta para barrar. */
const FALA_COM_OPERADOR: { re: RegExp; motivo: string }[] = [
  { re: /follow[\s-]?ups?/i, motivo: "cita 'follow-up'" },
  { re: /(?<!\p{L})leads?(?!\p{L})/iu, motivo: "chama a pessoa de 'lead'" },
  { re: /hist[óo]rico(?: \p{L}+)? da conversa/iu, motivo: "pede o histórico da conversa" },
  { re: /contexto (?:completo |real )?da conversa/i, motivo: "pede o contexto da conversa" },
  {
    re: /pode(?:ria)?s? (?:me )?(?:compartilhar|fornecer|colar|enviar o hist)/i,
    motivo: "pede informação a quem gerou",
  },
  { re: /recomenda[çc][ãa]o\s*:/i, motivo: "recomendação à equipe" },
  { re: /\*\*[^*\n]+\*\*/, motivo: "formatação de relatório (**negrito**)" },
];

/**
 * O texto gerado pode ser enviado ao lead?
 *
 *  - `PULAR` → o modelo avisou que não deve haver follow-up: pula o passo.
 *  - fala com operador/sistema → pula o passo e registra o motivo. Não tenta de
 *    novo: o cron regeraria a cada minuto e o modelo tende a repetir a recusa.
 */
export function avaliarTextoDoFollowup(texto: string): FollowupVeredito {
  const t = (texto ?? "").trim();
  if (!t) return { action: "skip", reason: "texto vazio" };
  if (new RegExp(`^[\\s*_"'\`]*${FOLLOWUP_SKIP_TOKEN}(?![\\p{L}])`, "iu").test(t)) {
    return { action: "skip", reason: "modelo pediu para pular (PULAR)" };
  }
  for (const { re, motivo } of FALA_COM_OPERADOR) {
    if (re.test(t)) return { action: "skip", reason: `texto fala com a equipe, não com o lead: ${motivo}` };
  }
  return { action: "send" };
}
