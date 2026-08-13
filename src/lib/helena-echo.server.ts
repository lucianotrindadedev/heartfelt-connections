// Classificação de eco/loopback da Helena.
//
// A Helena reentrega como evento de webhook as mensagens que ESTA plataforma
// acabou de enviar (resposta do agente, follow-up, warm-up). Esses ecos chegam
// com `userId` — parecendo atendente humano — e, quando gravados como mensagem
// normal, causam dois estragos:
//   1) poluem o histórico do LLM (e já chegaram a CRUZAR leads);
//   2) viram a ÚLTIMA mensagem da conversa e SUPRIMEM a resposta do agente,
//      porque `conversationNeedsAgentReply` só responde quando a última
//      mensagem é do lead.
//
// Caso real (Maple Bear Guarujá, 13 99602-7940, 13/08): o agente perguntou
// "Como você se chama?", a lead respondeu "Larissa" às 10:32 e 1 segundo depois
// a Helena reentregou o eco da pergunta. O turno abortou com "já respondida" e
// a lead ficou 1h04 sem resposta — só o follow-up automático resgatou.
//
// A detecção não depende de campos internos da Helena: o eco é sempre cópia de
// algo que NÓS enviamos há pouco.

/** Origens das mensagens que ESTA plataforma gera e envia (não são do lead nem
 *  de atendente humano). São elas que voltam como eco. */
export const OWN_OUTBOUND_ORIGINS = new Set(["agente", "followup", "warmup", "warm-up"]);

/** Abaixo deste tamanho, `containment` deixa de ser sinal confiável de eco —
 *  uma frase curta de atendente real pode estar contida na nossa resposta. */
const SHORT_TEXT_LEN = 25;

/** Janela em que um eco pode ser DESCARTADO (a reentrega normal vem em segundos). */
export const ECHO_FRESH_WINDOW_MS = 10 * 60 * 1000;

/**
 * Janela em que um eco só pode ser MARCADO (`is_echo`), nunca descartado.
 *
 * A Helena às vezes reentrega um lote inteiro horas depois. Caso real (Escudero,
 * 12 99189-4420, 13/08): às 15:36 chegaram de uma vez 10 mensagens, incluindo a
 * saudação e a pergunta que o agente tinha feito às **01:49** — 14h antes. Só o
 * dedupe por `helena_msg_id` pegou 9 delas; a que era primeira entrega de uma
 * bolha passou e envelheceu o contexto do LLM.
 *
 * Descartar por semelhança de texto tão tarde seria arriscado (um atendente pode
 * copiar e colar a nossa própria frase horas depois e essa mensagem é real), por
 * isso aqui o veredicto máximo é `suspect`: a mensagem fica gravada e auditável,
 * apenas não polui o histórico do LLM nem esconde o lead sem resposta.
 */
export const ECHO_STALE_WINDOW_MS = 24 * 60 * 60 * 1000;

export function normalizeEcho(s: string | null | undefined): string {
  return (s ?? "").toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * - `confirmed`: cópia literal (ou containment em texto longo) → descartar, não gravar.
 * - `suspect`: bolha curta contida numa resposta nossa → gravar com `is_echo: true`
 *   (fica auditável no banco, mas nunca entra no histórico do LLM nem esconde o lead).
 * - `none`: mensagem real.
 */
export type EchoVerdict = "none" | "suspect" | "confirmed";

/**
 * Compara o texto recebido com o que esta plataforma enviou recentemente.
 *
 * @param ownSends textos gerados por nós na janela considerada (qualquer conversa
 *   da conta — pega eco cruzado), já filtrados por `OWN_OUTBOUND_ORIGINS`.
 * @param fromLead a mensagem chegou classificada como entrada do lead (FROM_HUB).
 *   Nesse caso textos curtos NUNCA são tratados como eco: um "bom dia" real da
 *   lead coincide com o nosso e não pode ser engolido.
 * @param stale os textos vieram da janela antiga (`ECHO_STALE_WINDOW_MS`). Aí o
 *   veredicto é rebaixado para `suspect`: marca, mas nunca descarta.
 */
export function classifyEchoAgainstOwnSends(
  content: string | null | undefined,
  ownSends: Array<string | null | undefined>,
  { fromLead, stale = false }: { fromLead: boolean; stale?: boolean },
): EchoVerdict {
  const target = normalizeEcho(content);
  if (!target) return "none";

  const short = target.length < SHORT_TEXT_LEN;
  // Texto curto vindo do lead: risco de falso positivo alto demais, não mexemos.
  if (short && fromLead) return "none";

  const hit = (verdict: EchoVerdict): EchoVerdict =>
    stale && verdict === "confirmed" ? "suspect" : verdict;

  let contained = false;
  for (const raw of ownSends) {
    const stored = normalizeEcho(raw);
    if (!stored) continue;
    // Igualdade exata é eco em qualquer tamanho — era exatamente o furo do piso
    // de 25 chars, que deixava passar "Como você se chama?" (19).
    if (stored === target) return hit("confirmed");
    if (stored.includes(target) || target.includes(stored)) contained = true;
  }

  if (!contained) return "none";
  // O envio em bolhas faz a mensagem gravada (resposta inteira) diferir do eco
  // (uma bolha só) — por isso o containment nos dois sentidos. Em texto curto
  // ("Perfeito!", "(dia, mês e ano)") isso pode coincidir com fala real de
  // atendente: grava, mas marcado como eco.
  return short ? "suspect" : hit("confirmed");
}
