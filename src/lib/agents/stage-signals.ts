// Camada deterministica de stage signals.
//
// Filosofia: o LLM continua propondo `next_stage` no JSON, mas a maquina
// deterministica tem PRIORIDADE quando detecta sinais inequivocos no historico
// ou no lead_data. Isso isola o fluxo critico (agendamento) das oscilacoes
// do modelo (especialmente Gemini Flash Lite, que e barato mas fragil em
// instructions-following).
//
// Cada funcao aqui e PURA — sem I/O, sem side-effects — para facilitar testes
// e raciocinio. Spread sobre essa camada deve ser preferido a logica inline
// no orchestrator.

import {
  isSlotAcceptanceMessage,
  looksLikeBirthDate,
  looksLikeSchedulingPreference,
} from "@/lib/booking-template";
import type { LeadData, Stage } from "./stage";

export interface StageSignalsContext {
  /** Stage atual lido de conversations.meta. */
  stage: Stage;
  /** lead_data atual (apos backfill + normalizacao). */
  leadData: LeadData;
  /** Historico ja filtrado (sem fallbacks). */
  history: { role: "user" | "assistant"; content: string }[];
  /** Integracoes de agendamento ativas (clinicorp, clinup ou gcal). */
  hasBookingIntegration: boolean;
}

export interface DetectedSignals {
  /** Ultima mensagem do usuario (trim). */
  lastUserMsg: string;
  /** Ultima mensagem do assistente (raw). */
  lastAssistantMsg: string;
  /** Usuario mandou texto que indica escolha/aceitacao de horario? */
  slotSelectionTurn: boolean;
  /** Assistente acabou de propor agendamento ("posso agendar?", "vamos marcar?"). */
  lastAssistantProposedScheduling: boolean;
  /** Usuario respondeu confirmacao curta ("sim", "ok", "pode", etc). */
  isShortYes: boolean;
  /** QUALIFICATION + assistente propos agendar + usuario disse sim. */
  userAcceptedSchedulingProposal: boolean;
  /** RECEPTION/QUALIFICATION + lead perguntou disponibilidade/data especifica
   *  ("tem disponibilidade para 25/07?"). Roteia direto pro scheduler — o
   *  qualifier nao tem tool de agenda e alucina "vou verificar" sem voltar. */
  userAskedDateAvailability: boolean;
}

const SCHEDULING_PROPOSAL_REGEX =
  /\b(posso (?:te )?agendar|vamos (?:agendar|marcar)|podemos (?:agendar|marcar)|que tal (?:agendar|marcar)|posso (?:te )?(?:reservar|propor) (?:um )?(?:hor[áa]rio|visita)|topa (?:agendar|marcar)|aceita (?:agendar|marcar)|gostaria de agendar|deseja (?:agendar|marcar)|posso te ofer)/i;

/**
 * Proposta de CONSULTAR a agenda: "Quer que eu veja os horários disponíveis?",
 * "Posso consultar a agenda?", "Se quiser, já posso ver os próximos horários".
 *
 * Família DISTINTA de "posso agendar?" e muito mais comum nos prompts reais —
 * era o CTA padrão da MF Beauty (aparecia 8x no prompt) e nenhuma alternativa
 * do SCHEDULING_PROPOSAL_REGEX o reconhecia. Resultado: o lead respondia "quero
 * sim", o repasse pro scheduler nunca disparava, o qualifier (sem tool de
 * agenda) prometia "vou consultar" e o guard anti-stall devolvia uma pergunta
 * genérica. Caso real: MF Beauty Magé, ig:olucianodev, 28/07.
 */
const SCHEDULING_LOOKUP_PROPOSAL_REGEX =
  /\b(?:quer|quero|queres|queria|quiser|quisesse|gostaria|deseja|posso|podemos)\b[^.!?\n]{0,30}\b(?:ver|veja|vejo|olhar|olhe|consultar|consulte|verificar|verifique|buscar|busque|mostrar|mostre|trazer|traga|checar|cheque|separar|separe)\b[^.!?\n]{0,30}\b(?:hor[áa]rio|agenda|vaga|disponibilidade|op[çc][õo]es de hor[áa]rio)/i;

/**
 * Confirmações curtas. A versão antiga era ancorada em UMA palavra
 * (`^(sim|ok|quero|…)$`), então "quero sim", "pode sim", "sim, quero" e "claro
 * que sim" — as formas mais naturais em português — NÃO casavam e o repasse
 * morria. Aqui aceitamos até 4 tokens, exigindo que TODOS pertençam ao
 * vocabulário afirmativo//filler e ao menos um seja um núcleo afirmativo.
 *
 * Conservador de propósito: qualquer palavra fora das listas (inclusive "não",
 * "saber", "cancelar", "quanto") reprova a frase inteira. Um falso positivo aqui
 * empurra o lead pro agendamento cedo demais — pior que um falso negativo.
 */
const AFFIRMATIVE_CORE = new Set([
  "sim", "ok", "okay", "claro", "topo", "topa", "pode", "podemos", "aceito",
  "aceita", "quero", "queria", "gostaria", "adoraria", "isso", "vamos", "vamo",
  "bora", "blz", "beleza", "combinado", "fechado", "fechou", "perfeito", "otimo",
  "show", "certo", "uhum", "aham", "positivo", "manda", "mande", "simm", "ss",
  // "com certeza" / "por favor" / "por gentileza": afirmativas inteiras cujos
  // dois tokens seriam filler. O núcleo fica no substantivo — as frases que o
  // usariam em sentido oposto ("não tenho certeza", "faça o favor de parar")
  // trazem palavras fora das listas e são reprovadas antes.
  "certeza", "favor", "gentileza",
]);

const AFFIRMATIVE_FILLER = new Set([
  "por", "com", "que", "eu", "a", "o", "os",
  "as", "um", "uma", "de", "do", "da", "pra", "para", "me", "te", "ver", "ser",
  "sim", "obrigado", "obrigada", "entao", "agora", "ja", "e",
]);

/** Normaliza para comparação: minúsculas, sem acento, sem pontuação/emoji. */
function normalizeForTokens(text: string): string[] {
  return (text ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // marcas de acento
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

export function isShortAffirmative(text: string): boolean {
  const tokens = normalizeForTokens(text);
  if (tokens.length === 0 || tokens.length > 4) return false;
  let hasCore = false;
  for (const t of tokens) {
    if (AFFIRMATIVE_CORE.has(t)) {
      hasCore = true;
      continue;
    }
    if (!AFFIRMATIVE_FILLER.has(t)) return false;
  }
  return hasCore;
}

// Lead perguntando disponibilidade ou citando data especifica (dd/mm ou
// "25 de julho"). Mantido conservador para evitar falso positivo em
// QUALIFICATION (ex: "sábado" sozinho NAO casa).
const DATE_AVAILABILITY_REGEX =
  /(disponibilidade|dispon[ií]vel|tem\s+(?:data|vaga|hor[aá]rio|agenda)|data\s+(?:livre|dispon[ií]vel)|agenda\s+(?:livre|aberta)|\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b|\b\d{1,2}\s+de\s+(?:janeiro|fevereiro|mar[cç]o|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro)\b)/i;

export function detectSignals(ctx: StageSignalsContext): DetectedSignals {
  const lastUserMsg =
    [...ctx.history].reverse().find((m) => m.role === "user")?.content?.trim() ?? "";
  const lastAssistantMsg =
    [...ctx.history].reverse().find((m) => m.role === "assistant")?.content ?? "";

  const slotSelectionTurn =
    isSlotAcceptanceMessage(lastUserMsg) || looksLikeSchedulingPreference(lastUserMsg);

  const lastAssistantProposedScheduling =
    SCHEDULING_PROPOSAL_REGEX.test(lastAssistantMsg) ||
    SCHEDULING_LOOKUP_PROPOSAL_REGEX.test(lastAssistantMsg);
  const isShortYes = isShortAffirmative(lastUserMsg);
  // RECEPTION entrou junto com QUALIFICATION: o qualifier às vezes propõe ver
  // horários já na saudação (prompt com voucher/oferta) e o lead aceita no 2º
  // turno — com o stage ainda em RECEPTION o repasse não disparava.
  const userAcceptedSchedulingProposal =
    (ctx.stage === "QUALIFICATION" || ctx.stage === "RECEPTION") &&
    lastAssistantProposedScheduling &&
    isShortYes;

  // Data de nascimento (resposta de campo) nunca conta como pedido de
  // disponibilidade — evita roteamento errado quando o lead responde "15/03/2019".
  const userAskedDateAvailability =
    (ctx.stage === "RECEPTION" || ctx.stage === "QUALIFICATION") &&
    DATE_AVAILABILITY_REGEX.test(lastUserMsg) &&
    !looksLikeBirthDate(lastUserMsg);

  return {
    lastUserMsg,
    lastAssistantMsg,
    slotSelectionTurn,
    lastAssistantProposedScheduling,
    isShortYes,
    userAcceptedSchedulingProposal,
    userAskedDateAvailability,
  };
}

/**
 * Calcula o stage que deve ser PASSADO ao sub-agente (effective stage).
 * Difere do stage persistido em casos onde sinais deterministicos indicam
 * que devemos rotear/promptar como se estivessemos em outro stage.
 *
 * Exemplos:
 * - QUALIFICATION + usuario aceitou agendar → roteia como SLOT_OFFER (scheduler)
 * - SLOT_OFFER + ja tem selected_slot_iso → roteia como NAME_COLLECT
 * - NAME_COLLECT sem selected_slot_iso → roteia como SLOT_OFFER (volta listar)
 */
export interface InferEffectiveStageResult {
  effectiveStage: Stage;
  reason?: string;
}

export function inferEffectiveStage(
  ctx: StageSignalsContext,
  signals: DetectedSignals,
  isReadyForBooking: boolean,
): InferEffectiveStageResult {
  const { stage, leadData, hasBookingIntegration } = ctx;

  if (signals.userAcceptedSchedulingProposal && hasBookingIntegration) {
    return {
      effectiveStage: "SLOT_OFFER",
      reason: "lead_accepted_scheduling_proposal",
    };
  }

  // Lead pediu disponibilidade/data especifica → scheduler responde JA neste
  // turno com horarios reais (listar_horarios + data_alvo). Sem isso, o
  // qualifier (sem tool de agenda) promete "vou verificar" e a conversa morre.
  if (
    (stage === "RECEPTION" || stage === "QUALIFICATION") &&
    hasBookingIntegration &&
    signals.userAskedDateAvailability &&
    !leadData.appointment_id
  ) {
    return {
      effectiveStage: "SLOT_OFFER",
      reason: "lead_asked_date_availability",
    };
  }

  if (stage === "SLOT_OFFER" && leadData.selected_slot_iso) {
    return {
      effectiveStage: "NAME_COLLECT",
      reason: "slot_already_selected",
    };
  }

  if (stage === "NAME_COLLECT" && !leadData.selected_slot_iso) {
    return {
      effectiveStage: "SLOT_OFFER",
      reason: "name_collect_without_slot",
    };
  }

  if (
    (stage === "NAME_COLLECT" || stage === "BOOKING") &&
    hasBookingIntegration &&
    !leadData.appointment_id &&
    isReadyForBooking
  ) {
    return {
      effectiveStage: "BOOKING",
      reason: "all_fields_collected",
    };
  }

  return { effectiveStage: stage };
}

/**
 * Aplica overrides deterministicos APOS o LLM ter proposto next_stage.
 * Usado para garantir progressao mesmo quando o LLM "trava" no mesmo stage.
 */
export interface ApplyOverridesInput {
  /** Stage validado pelo resolveNextStage (ja aplicou regras de transicao). */
  proposedNextStage: Stage;
  /** Stage que estava registrado em conversations.meta antes do turn. */
  originalStage: Stage;
  /** effectiveStage que foi passado ao LLM. */
  effectiveStage: Stage;
  leadData: LeadData;
  hasBookingIntegration: boolean;
  signals: DetectedSignals;
}

export interface OverrideResult {
  stage: Stage;
  reason?: string;
}

export function applyDeterministicStageOverrides(input: ApplyOverridesInput): OverrideResult {
  const { proposedNextStage, originalStage, effectiveStage, leadData, hasBookingIntegration, signals } = input;
  let result = proposedNextStage;
  let reason: string | undefined;

  // Reagendamento pendente: já existe appointment_id, mas o horário que o lead
  // selecionou agora (selected_slot_iso) ainda é DIFERENTE do que está de fato
  // reservado (booked_slot_iso) — a mudança ainda não foi executada por
  // remarcar_agendamento. Nenhum override abaixo deve AVANÇAR o stage nessa
  // condição: avançar (mesmo que só até NAME_COLLECT, não direto pra CONFIRMED)
  // faria o fluxo "esquecer" que existe uma remarcação pendente, mesmo que um
  // guard downstream (scheduler) já tenha evitado a confirmação falsa nesse
  // mesmo turn — reabrindo a mesma classe de bug por outra porta. Caso real
  // (Clínica Bomfim, 09/07): o guard do scheduler barrou "Fechado! Reservado
  // para 15/07" sem tool chamada, mas os overrides abaixo empurrariam o stage
  // adiante mesmo assim, porque só olhavam "existe appointment_id"/"existe
  // selected_slot_iso", nunca se o horário bate com o real.
  const hasPendingReschedule =
    !!leadData.selected_slot_iso &&
    !!leadData.booked_slot_iso &&
    leadData.selected_slot_iso !== leadData.booked_slot_iso;

  // RECEPTION entra junto com QUALIFICATION porque a tabela de transições
  // bloqueia RECEPTION → SLOT_OFFER: sem este override o avanço era descartado
  // e o lead que aceitou ver horários na saudação ficava preso na recepção.
  if (
    signals.userAcceptedSchedulingProposal &&
    hasBookingIntegration &&
    effectiveStage === "SLOT_OFFER" &&
    (originalStage === "QUALIFICATION" || originalStage === "RECEPTION") &&
    (result === "QUALIFICATION" || result === "RECEPTION")
  ) {
    result = "SLOT_OFFER";
    reason = "force_slot_offer_after_accept";
  }

  // Pedido de disponibilidade roteado pro scheduler (effectiveStage=SLOT_OFFER):
  // persiste o avanco mesmo vindo de RECEPTION, onde a tabela de transicoes
  // bloqueia RECEPTION → SLOT_OFFER (o resolveNextStage devolve o stage antigo).
  if (
    signals.userAskedDateAvailability &&
    hasBookingIntegration &&
    effectiveStage === "SLOT_OFFER" &&
    (originalStage === "RECEPTION" || originalStage === "QUALIFICATION") &&
    (result === "RECEPTION" || result === "QUALIFICATION")
  ) {
    result = "SLOT_OFFER";
    reason = reason ?? "force_slot_offer_after_date_ask";
  }

  if (
    originalStage === "SLOT_OFFER" &&
    leadData.selected_slot_iso &&
    result === "SLOT_OFFER" &&
    !hasPendingReschedule
  ) {
    result = "NAME_COLLECT";
    reason = reason ?? "slot_selected_advance_to_name_collect";
  }

  if (
    leadData.appointment_id &&
    !hasPendingReschedule &&
    (result === "NAME_COLLECT" || result === "BOOKING")
  ) {
    result = "CONFIRMED";
    reason = reason ?? "appointment_created_advance_to_confirmed";
  }

  if (result === "NAME_COLLECT" && !leadData.selected_slot_iso) {
    result = "SLOT_OFFER";
    reason = reason ?? "name_collect_requires_slot";
  }

  return { stage: result, reason };
}

// Resposta "stall/filler": o agente PROMETE agir ("vou finalizar seu cadastro",
// "só um instante", "já te confirmo", "estou organizando") mas NÃO entrega — e
// a conversa morre esperando uma ação que nunca vem. Diferente da afirmação
// FALSA de agendamento ("agendei/marquei/confirmado"), que é tratada à parte:
// aqui o agente nem afirma que concluiu, só enrola. Bug real observado no
// SLOT_OFFER→BOOKING (lead escolhe o horário e o agente fica "vou criar seu
// cadastro rapidinho" sem nunca agendar).
//
// verificar/checar/consultar (caso real 09/07, Costa Lima Recreio): lead pede
// outra semana ("só semana que vem"), o agente responde "vou verificar a
// agenda" SEM chamar listar_horarios nesse turn — e a conversa morre esperando
// os novos horários que nunca chegam (nada re-aciona o agente depois).
//
// "vou deixar reservado / logo te envio a confirmação" (caso real 13/07, MF
// Beauty BSB, Maria de Fátima): sem agendamento criado (appointment_id nulo), o
// agente disse "Já vou deixar tudo reservado por aqui e logo te envio a
// confirmação" — uma promessa de reserva + confirmação FUTURA que o sistema
// nunca cumpre sozinho (só reage a mensagem nova do lead). A lead achou que
// estava agendada e agradeceu. Não bate nas palavras de confirmação PASSADA
// ("agendei/reservei") do false_booking_claim, nem no "já te envio" (o gatilho
// aqui é "logo", não "já"), então escapava dos dois guards.
const STALL_REPLY_REGEX =
  /(s[óo]\s+um\s+(instant(?:e|inho)|minut(?:o|inho)|moment(?:o|inho)|segund(?:o|inho))|um\s+(instant(?:e|inho)|moment(?:o|inho)|minutinho)|aguard[ae]\b|aguardar\b|(?:j[áa]|logo|em\s+seguida)\s+(?:te\s+|lhe\s+)?(retorno|volto|confirmo|aviso|respondo|envio|mando|passo|finalizo|verifico|checo|consulto|busco|procuro)|vou\s+(finalizar|criar|fazer|registrar|organizar|gerar|preparar|montar|cadastrar|verificar|checar|consultar|buscar|procurar|pesquisar|ver|olhar|levantar|separar|localizar|dar\s+uma\s+olhada)\b|vou\s+deixar\s+(?:tudo\s+|isso\s+|j[áa]\s+)?(reservad|agendad|marcad|pronto|prontinho|certinh|garantid|organizad)|te\s+(envio|mando|passo)\s+(?:a\s+|o\s+)?(confirma[çc]|agendament)|estou\s+(finalizando|criando|organizando|registrando|preparando|gerando|cadastrando|verificando|checando|consultando|buscando|procurando|pesquisando)|t[ôo]\s+(finalizando|criando|organizando|registrando|cadastrando|verificando|checando|consultando|buscando|procurando)|deixa?\s+eu\s+(finalizar|criar|organizar|registrar|cadastrar|verificar|checar|consultar|buscar|procurar|ver|dar\s+uma\s+olhada)|pe[çc]o\s+que\s+aguarde|me\s+d[êe]\s+um\s+(instante|instantinho|momento|minutinho)|rapidinho\s+(aqui|aí|pra))/i;

/**
 * Fechos retóricos no FIM da frase ("…já te mostro, tá bem?", "…, ok?"). Não
 * pedem nada acionável ao lead — são só cortesia fechando uma promessa. Sem
 * removê-los, o "?" deles fazia o reply passar por "pergunta = progresso" e
 * DESARMAVA o guard anti-stall. Caso real (Odonto Carioca Campo Grande,
 * 21 98817-7687): "Deixa eu verificar a disponibilidade de sábado e já te mostro
 * os horários que temos, tá bem?" — nenhuma tool foi chamada, a promessa saiu e
 * a conversa morreu (nada re-aciona o agente depois).
 */
const RHETORICAL_TAG_REGEX =
  /[,;\s]*\b(t[áa]\s*(bem|bom|certo|ok)?|ok|okay|tudo\s+(bem|certo)|certo|combinado|beleza|blz|pode\s+ser|sim|n[ée])\s*\?+\s*$/i;

/** Remove os fechos retóricos do fim (até 3, p/ "…, tá bem? ok?"). */
function stripRhetoricalTags(text: string): string {
  let out = text.trim();
  for (let i = 0; i < 3; i++) {
    const next = out.replace(RHETORICAL_TAG_REGEX, "").trim();
    if (next === out) break;
    out = next;
  }
  return out;
}

/**
 * PEDIDO DIRETO de um dado ao lead, na forma imperativa e SEM "?" — "Me passa
 * seu nome completo, por favor", "Me confirma seu WhatsApp com DDD".
 *
 * Isso é PROGRESSO, não enrolação: a bola volta pro lead com uma ação clara.
 * Sem esta exceção o guard anti-stall destruía a resposta certa sempre que ela
 * vinha acompanhada de uma promessa ("...que eu já consulto os horários") — e
 * várias clínicas escrevem exatamente assim no próprio prompt. Caso real (MF
 * Beauty Magé, 28/07): a resposta "Me passa seu nome completo, por favor, que eu
 * já consulto os horários disponíveis pra você" era substituída pelo texto
 * genérico "Pra seguir com seu agendamento, qual horário fica melhor pra você?",
 * que ignorava o dado que faltava e pedia ao lead que adivinhasse a agenda.
 *
 * Complementar ao strip de fechos retóricos: lá o problema era um "?" FALSO
 * desarmando o guard; aqui é um pedido REAL sem "?" nenhum sendo confundido com
 * enrolação. Por isso o teste roda sobre o texto JÁ limpo dos fechos.
 */
const DIRECT_ASK_REGEX =
  /\b(?:me\s+(?:passa|passe|manda|mande|envia|envie|informa|informe|confirma|confirme|diz|diga|fala|fale|d[áa]|d[êe])|pode\s+me\s+(?:passar|mandar|enviar|informar|confirmar|dizer|falar)|preciso\s+(?:do|da|de)\s+seu|s[óo]\s+preciso\s+(?:do|da|de)\s+seu|qual\s+(?:é\s+)?(?:o|a)\s+seu)\b/i;

/**
 * True quando o `reply` do agente é só "enrolação" (promessa de agir / pedido
 * para aguardar) sem fazer pergunta REAL nem pedir nada concreto. Um reply que
 * faz pergunta ("Qual seu nome completo?") é progresso — por isso o "?"
 * desqualifica, mas só depois de descartar os fechos retóricos ("tá bem?") — e
 * um pedido imperativo ("Me passa seu nome completo") também é, mesmo sem "?".
 * PURA: o orquestrador decide o que fazer (perguntar campo, ofertar slot, etc.).
 */
export function looksLikeStallReply(reply: string): boolean {
  const r = (reply ?? "").trim();
  if (!r) return false;
  const semTags = stripRhetoricalTags(r);
  if (!semTags) return false; // era só o fecho retórico, não há promessa
  if (semTags.includes("?")) return false; // pergunta REAL é avançar, não enrolar
  if (DIRECT_ASK_REGEX.test(semTags)) return false; // pedir um dado também é avançar
  return STALL_REPLY_REGEX.test(semTags);
}

/**
 * O texto faz uma pergunta REAL — ou seja, algo que o lead precisa responder.
 * Um fecho retórico ("…, tá bem?") NÃO conta. Usado para saber "de quem é a
 * vez": com pergunta real, a bola está com o LEAD; sem pergunta, quem deve agir
 * é o AGENTE (e, se ele não agir, a conversa morre — ver retomada-slot-offer).
 */
export function hasRealQuestion(text: string): boolean {
  const t = (text ?? "").trim();
  if (!t) return false;
  const semTags = stripRhetoricalTags(t);
  if (semTags.includes("?")) return true;
  // O ÚNICO "?" pode ter sido consumido pelo fecho retórico ("Qual prefere, tá
  // bem?") — aí a pergunta real fica invisível. Só nesse caso (houve strip)
  // uma palavra interrogativa no texto restante ainda conta como pergunta.
  // Restrito a marcadores FORTES: "como"/"onde" são comuns em frase afirmativa
  // ("como você trabalha de manhã, vou buscar…") e dariam falso positivo.
  if (semTags === t) return false;
  return /\b(qual|quais|quando|que\s+horas|quantos?|quantas?|prefere|prefer[ei]ria|consegue|topa|aceita|pode(?:ria)?\s+(?:me|nos)\b|me\s+(?:informa|diz|manda|envia|passa))\b/i.test(
    semTags,
  );
}
