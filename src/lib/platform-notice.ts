// Avisos que a PLATAFORMA (Helena/WhatsApp) injeta na conversa e que chegam ao
// webhook como se fossem fala do LEAD — `role: "user"`, `origem: "lead"`.
//
// Eles não são mensagem de ninguém: são um recado da API dizendo que o tipo de
// conteúdo enviado não pôde ser entregue (figurinha, reação, enquete, pedido,
// pagamento). O estrago é o mesmo do eco da Helena: entram no histórico do LLM
// e, pior, viram "a última mensagem do lead" — a âncora de várias heurísticas
// determinísticas.
//
// Caso real (Clínica Bomfim, Instagram @wallaceblacklima, 24/08): o lead mandou
// o telefone "2198264-4836" às 17:58:04 e 3 segundos depois entrou o aviso
// "*Atenção:* o tipo da mensagem enviada pelo contato não é suportado.". A
// captura determinística do telefone lê a última mensagem do lead, leu o aviso,
// não achou número nenhum e não gravou nada — 42 segundos depois o agente
// perguntou "qual é o seu WhatsApp com DDD?", com o número já na tela.
//
// Volume medido em produção (60 dias): 2.494 avisos gravados como fala do lead.

/**
 * O texto é um aviso da plataforma (e não algo que o lead escreveu)?
 *
 * Exige as DUAS marcas juntas — o prefixo em negrito do WhatsApp (`*Atenção:*`,
 * que a plataforma sempre usa) E a explicação de não-suporte. Um "Atenção:" sem
 * asteriscos é texto de gente e continua passando: em produção existe um lead
 * que abre mensagem com "Atenção: Nossa tabela de preços foi reajustada...".
 */
export function isPlatformNotice(text: string | null | undefined): boolean {
  const t = (text ?? "").trim();
  if (!t) return false;
  if (!/^\*aten[çc][ãa]o:\*/i.test(t)) return false;
  return /(n[ãa]o\s+(?:é|e)\s+suportad|n[ãa]o\s+suportada\s+pela\s+api|this\s+message\s+is\s+unavailable|message\s+type\s+unknown)/i.test(
    t,
  );
}
