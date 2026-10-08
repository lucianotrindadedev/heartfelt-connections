// Mensagens da ATENDENTE HUMANA no histórico da conversa.
//
// A atendente escreve pelo WhatsApp da clínica e a mensagem chega pelo webhook
// como assistant/origem="humano" — exatamente como os ECOS das nossas próprias
// respostas (a Helena reentrega cada envio, em bolhas). O anti-eco do webhook
// compara com o que já está gravado, mas o eco costuma chegar ~1s ANTES de a
// resposta do agente ser gravada, então muitos ecos ficam sem `is_echo`.
//
// Caso real (Sorriamed, 21 95948-9650, 07/10): a atendente ofereceu "sábado dia
// 17 de outubro 9:30h ou 11:30h". O LLM recebeu isso como fala DELE mesmo,
// conferiu a agenda e "se corrigiu": "Poxa, desculpa! Acabei de verificar e a
// gente não abre aos sábados" — desmentindo a atendente 11s depois. E o
// follow-up, uma hora depois do "Seu agendamento foi concluído" dela, mandou
// "A gente funciona de segunda a sexta, ok?".
//
// Aqui, com a conversa inteira em mãos, dá para comparar com as respostas
// gravadas ANTES e DEPOIS: eco é cópia (ou bolha) de algo que nós enviamos
// minutos antes ou depois; fala da atendente não é.
//
// PURO: sem I/O.
import {
  OWN_OUTBOUND_ORIGINS,
  ECHO_FRESH_WINDOW_MS,
  classifyEchoAgainstOwnSends,
} from "@/lib/helena-echo.server";
import { isPlatformNotice } from "@/lib/platform-notice";

export interface HistoryMsg {
  role: string;
  content: string | null;
  meta: Record<string, unknown> | null;
  criado_em?: string | null;
}

/** Rótulo posto na frente da fala da atendente no histórico do LLM. */
export const HUMAN_STAFF_LABEL = "[Mensagem da equipe da clínica — não foi você que escreveu]";

/**
 * A mensagem `msgs[i]` foi escrita por uma pessoa da equipe (não é eco nosso)?
 *
 * Só olha assistant/origem="humano" com texto. Compara com as mensagens que
 * NÓS geramos (agente, follow-up, warm-up) na janela de ±10 min — o eco vem
 * em segundos, antes ou depois de a resposta ser gravada. Na dúvida (bolha
 * curta contida numa resposta nossa: "suspect"), NÃO é humana: tratar eco como
 * atendente pararia o follow-up à toa.
 */
export function isHumanStaffMessage(msgs: HistoryMsg[], i: number): boolean {
  const m = msgs[i];
  if (!m || m.role !== "assistant") return false;
  const meta = m.meta ?? {};
  if (meta.origem !== "humano" || meta.is_echo === true) return false;
  if (!(m.content ?? "").trim()) return false;

  const at = m.criado_em ? Date.parse(m.criado_em) : NaN;
  const ownSends = msgs
    .filter((o) => {
      if (o === m || o.role !== "assistant") return false;
      if (!OWN_OUTBOUND_ORIGINS.has(String(o.meta?.origem ?? ""))) return false;
      if (Number.isNaN(at) || !o.criado_em) return true;
      return Math.abs(Date.parse(o.criado_em) - at) <= ECHO_FRESH_WINDOW_MS;
    })
    .map((o) => o.content);
  return classifyEchoAgainstOwnSends(m.content, ownSends, { fromLead: false }) === "none";
}

/** Conteúdo como o LLM deve ver: fala da equipe vai rotulada. */
export function labelHumanStaff(content: string): string {
  return `${HUMAN_STAFF_LABEL} ${content}`;
}

/** O modelo às vezes copia o rótulo do histórico — nunca pode sair para o lead. */
export function stripHumanStaffLabel(reply: string): string {
  return reply.split(HUMAN_STAFF_LABEL).join("").replace(/^\s+/, "");
}

/** Resposta automática instantânea (ausência/saudação do WhatsApp Business) sai em segundos. */
const AUTO_REPLY_MAX_MS = 15_000;

/** A atendente está RESPONDENDO ao lead: ele escreveu nesta janela antes dela. */
const TAKEOVER_LEAD_WINDOW_MS = 2 * 60 * 60 * 1000;

/** A IA precisa ter falado nesta janela antes da atendente para ser "tomada". */
const TAKEOVER_AI_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Como o follow-up classifica a fala da equipe em `msgs[i]`:
 * - `takeover`: a atendente assumiu uma conversa que a IA estava conduzindo —
 *   respondeu ao lead (que escreveu nas últimas 2h) e a IA falou nas últimas 24h;
 * - `automatica`: aviso da plataforma, resposta a story ou resposta automática
 *   instantânea do WhatsApp Business — ninguém assumiu nada;
 * - `prospeccao`: a equipe escreveu sem o lead ter falado nas últimas 2h —
 *   disparo/campanha ("Olá, me chamo Kelly…", "Aqui é a Andressa…"), lembrete
 *   de consulta, "Oi tá aí?". O follow-up segue: é ele que insiste nesse lead;
 * - `sem_ia_recente`: a IA não falou nas últimas 24h — a conversa não era dela;
 * - `nao_humana`: não é fala da equipe (eco, lead, agente).
 *
 * Medido em produção (14 dias, 8.578 follow-ups): "última fala da equipe" pega
 * 462, a maioria SEM ninguém assumindo — ausência automática ("normalmente
 * respondo entre 08:00 e 20:00"), "*Atenção:* tipo não suportado", "Você
 * respondeu ao story", disparo em massa da equipe.
 */
export type StaffKind = "takeover" | "automatica" | "prospeccao" | "sem_ia_recente" | "nao_humana";

export function classifyStaffMessage(msgs: HistoryMsg[], i: number): StaffKind {
  if (!isHumanStaffMessage(msgs, i)) return "nao_humana";
  const m = msgs[i]!;
  const texto = (m.content ?? "").trim();
  if (isPlatformNotice(texto) || /^voc[êe] respondeu ao (?:seu )?story/i.test(texto)) {
    return "automatica";
  }
  const at = m.criado_em ? Date.parse(m.criado_em) : NaN;
  if (Number.isNaN(at)) return "takeover";

  // Fala anterior com texto: se é do lead e veio segundos antes, é automática.
  for (let j = i - 1; j >= 0; j--) {
    const p = msgs[j]!;
    if (!(p.content ?? "").trim() || p.meta?.is_echo === true) continue;
    if (p.role === "user" && p.criado_em && at - Date.parse(p.criado_em) < AUTO_REPLY_MAX_MS) {
      return "automatica";
    }
    break;
  }

  const leadRecente = msgs.some(
    (o, j) =>
      j < i &&
      o.role === "user" &&
      !!(o.content ?? "").trim() &&
      !!o.criado_em &&
      at - Date.parse(o.criado_em) <= TAKEOVER_LEAD_WINDOW_MS,
  );
  if (!leadRecente) return "prospeccao";

  const iaRecente = msgs.some(
    (o, j) =>
      j < i &&
      o.role === "assistant" &&
      o.meta?.origem === "agente" &&
      !!o.criado_em &&
      at - Date.parse(o.criado_em) <= TAKEOVER_AI_WINDOW_MS,
  );
  return iaRecente ? "takeover" : "sem_ia_recente";
}

/**
 * A ÚLTIMA fala da conversa (ignorando eventos vazios e ecos) foi a atendente
 * ASSUMINDO a conversa da IA (ver classifyStaffMessage)?
 *
 * O follow-up existe para resgatar o lead que parou de responder à IA. Quando
 * quem falou por último foi a equipe, a conversa é dela: o follow-up atropela o
 * que ela combinou. Caso real (Sorriamed, 21 95948-9650, 07/10): às 17:18 a
 * atendente escreveu "Seu agendamento foi concluído" (sábado 17/10, marcado à
 * mão — sem appointment_id na conversa) e às 18:20 o follow-up mandou "A gente
 * funciona de segunda a sexta, ok? Qual desses dois dias fica melhor".
 *
 * `msgs` em ordem cronológica (as últimas N da conversa bastam).
 */
export function lastSpeakerIsHumanStaff(msgs: HistoryMsg[]): boolean {
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i]!;
    if (!(m.content ?? "").trim()) continue;
    if (m.meta?.is_echo === true) continue;
    if (m.role === "assistant" && m.meta?.origem === "humano") {
      const tipo = classifyStaffMessage(msgs, i);
      if (tipo === "nao_humana") continue; // eco de resposta nossa: olha a anterior
      return tipo === "takeover";
    }
    return false;
  }
  return false;
}
