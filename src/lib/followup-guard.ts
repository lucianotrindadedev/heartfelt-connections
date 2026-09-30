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

export type FollowupVeredito = { action: "send" } | { action: "skip"; reason: string };

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
 * O follow-up não tem agenda, tabela de preços nem o prompt inteiro da clínica
 * — só um recorte. Tudo que depende disso é proibido nele.
 *
 * Casos reais (set/2026, depois que o follow-up voltou a sair em todas as
 * contas): Clínica Bomfim mandou "O valor de investimento da consulta é
 * R$ 275,00" para a Janete Rosa — valor que é SÓ da Consulta de Emergência; a
 * dela era a de Diagnóstico, que é cortesia. O recorte do prompt começa pela
 * trava da emergência, com essa frase literal, e o modelo copiou. Outro lead da
 * Bomfim recebeu "Vou agendar sua Consulta de Diagnóstico... O investimento é
 * R$ 275,00". Costa Lima mandou faixas de preço inventadas. E 12 follow-ups
 * sugeriram dia em que a clínica não abre ("domingo é nosso melhor dia",
 * "Sábado, domingo ou segunda até 15h?").
 */
const FALA_DE_PRECO: RegExp[] = [
  /R\$\s?\d/i,
  /(?<!\d)\d{1,3}(?:\.\d{3})*,\d{2}(?!\d)/,
  /(?<!\p{L})\d+(?:[.,]\d+)?\s*(?:mil\s+)?reais(?!\p{L})/iu,
  /(?<!\p{L})valor(?:es)?\s+(?:de\s+investimento|da\s+consulta|do\s+tratamento|da\s+avalia)/iu,
  // "é"/"de"/"fica", nunca "e": "faz diferença no investimento e no resultado"
  // não é citar valor (falso positivo medido em produção).
  /(?<!\p{L})investimento\s+(?:é|de|fica)\s/iu,
];

const PROMETE_AGENDAMENTO =
  /(?<!\p{L})(?:vou|j[áa]\s+vou|vou\s+j[áa])\s+(?:te\s+|lhe\s+)?(?:agendar|marcar|reservar)|(?<!\p{L})(?:agendei|marquei|reservei)(?!\p{L})|(?<!\p{L})(?:est[áa]|ficou|fica|j[áa]\s+est[áa])\s+(?:agendad|marcad|confirmad|reservad)/iu;

const NOME_DO_DIA: Record<string, RegExp> = {
  domingo: /(?<!\p{L})domingos?(?!\p{L})/iu,
  segunda: /(?<!\p{L})segundas?(?:-feiras?)?(?!\p{L})/iu,
  terca: /(?<!\p{L})ter[çc]as?(?:-feiras?)?(?!\p{L})/iu,
  quarta: /(?<!\p{L})quartas?(?:-feiras?)?(?!\p{L})/iu,
  quinta: /(?<!\p{L})quintas?(?:-feiras?)?(?!\p{L})/iu,
  sexta: /(?<!\p{L})sextas?(?:-feiras?)?(?!\p{L})/iu,
  sabado: /(?<!\p{L})s[áa]bados?(?!\p{L})/iu,
};

const CHAVE_DO_DIA: Record<string, string> = {
  dom: "domingo",
  domingo: "domingo",
  seg: "segunda",
  segunda: "segunda",
  ter: "terca",
  terca: "terca",
  terça: "terca",
  qua: "quarta",
  quarta: "quarta",
  qui: "quinta",
  quinta: "quinta",
  sex: "sexta",
  sexta: "sexta",
  sab: "sabado",
  sabado: "sabado",
  sábado: "sabado",
};

/**
 * Dias que a clínica marcou como FECHADOS no expediente (settings.
 * business_hours_json). Só conta o dia desligado de propósito — `active:false`
 * / `enabled:false` / lista vazia. Dia ativo sem horário de término (o sábado
 * da Bomfim está "09:00–") continua aberto: barrar esse dia derrubaria
 * follow-up legítimo.
 */
export function diasFechadosDoExpediente(raw: string | null | undefined): string[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== "object") return [];
  const fechados: string[] = [];
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    const chave = CHAVE_DO_DIA[k.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")];
    if (!chave) continue;
    const desligado =
      (Array.isArray(v) && v.length === 0) ||
      (!!v &&
        typeof v === "object" &&
        !Array.isArray(v) &&
        ((v as { active?: unknown }).active === false ||
          (v as { enabled?: unknown }).enabled === false));
    if (desligado) fechados.push(chave);
  }
  return fechados;
}

/** Nome por extenso, para o prompt ("domingo", "sábado"). */
export const NOME_POR_EXTENSO: Record<string, string> = {
  domingo: "domingo",
  segunda: "segunda-feira",
  terca: "terça-feira",
  quarta: "quarta-feira",
  quinta: "quinta-feira",
  sexta: "sexta-feira",
  sabado: "sábado",
};

/**
 * Recorte do prompt da clínica para o follow-up, sem as linhas que citam valor.
 * O corte é feito DEPOIS de remover as linhas, então o recorte não perde
 * espaço para elas.
 */
export function recorteSemValores(prompt: string, limite: number): string {
  return (prompt ?? "")
    .split("\n")
    .filter((linha) => !FALA_DE_PRECO.some((re) => re.test(linha)))
    .join("\n")
    .slice(0, limite);
}

/**
 * Linha para o prompt do atendimento (qualifier/scheduler) com os dias em que a
 * clínica NÃO abre. O texto livre de business_hours da Bomfim ("Seg: 10–20 /
 * Ter–Sex: 9–20 / Sáb: 9–") não diz "domingo fechado", e a IA ecoou a
 * disponibilidade da lead — "a gente agenda nos seus horários: sábado, domingo
 * ou segunda até 15h" (Janete Rosa, 29/09). Vazia quando nada está fechado.
 * Dado fixo do agente: pode ir no prompt cacheado.
 */
export function linhaDiasFechados(raw: string | null | undefined): string {
  const dias = diasFechadosDoExpediente(raw);
  if (dias.length === 0) return "";
  const nomes = dias.map((d) => NOME_POR_EXTENSO[d] ?? d).join(", ");
  return `- 🚫 Dias em que NÃO atendemos: ${nomes}. Nunca proponha, aceite nem repita esses dias como opção de agendamento — se o lead disser que só pode num deles, avise que nesse dia a clínica não abre e ofereça os dias em que atendemos.\n`;
}

/**
 * O expediente do AGENTE vale para a agenda? Só com agenda única. Com 2+
 * agendas Google ou 2+ unidades Clinic Experts, cada uma tem horário próprio —
 * a Central MF Beauty marca sábado fechado no agente e agenda 16 sábados nas
 * unidades. Dizer "não atendemos sábado" ali quebraria esses agendamentos.
 */
export function agendaUnicaDoAgente(ctx: {
  googleAgendas?: unknown[] | null;
  clinicExpertsUnidades?: unknown[] | null;
}): boolean {
  return (ctx.googleAgendas?.length ?? 0) < 2 && (ctx.clinicExpertsUnidades?.length ?? 0) < 2;
}

export interface FollowupContexto {
  /** Dias fechados da clínica — ver diasFechadosDoExpediente. */
  diasFechados?: string[];
}

/**
 * O texto gerado pode ser enviado ao lead?
 *
 *  - `PULAR` → o modelo avisou que não deve haver follow-up: pula o passo.
 *  - fala com operador/sistema → pula o passo e registra o motivo. Não tenta de
 *    novo: o cron regeraria a cada minuto e o modelo tende a repetir a recusa.
 *  - cita valor, promete agendamento ou sugere dia em que a clínica não abre →
 *    pula o passo. Um follow-up a menos custa pouco; um preço errado ou uma
 *    visita num domingo fechado custa o lead.
 */
export function avaliarTextoDoFollowup(
  texto: string,
  contexto: FollowupContexto = {},
): FollowupVeredito {
  const t = (texto ?? "").trim();
  if (!t) return { action: "skip", reason: "texto vazio" };
  if (new RegExp(`^[\\s*_"'\`]*${FOLLOWUP_SKIP_TOKEN}(?![\\p{L}])`, "iu").test(t)) {
    return { action: "skip", reason: "modelo pediu para pular (PULAR)" };
  }
  for (const { re, motivo } of FALA_COM_OPERADOR) {
    if (re.test(t))
      return { action: "skip", reason: `texto fala com a equipe, não com o lead: ${motivo}` };
  }
  if (FALA_DE_PRECO.some((re) => re.test(t))) {
    return { action: "skip", reason: "follow-up citou valor/preço" };
  }
  if (PROMETE_AGENDAMENTO.test(t)) {
    return { action: "skip", reason: "follow-up prometeu/afirmou agendamento (não tem agenda)" };
  }
  for (const dia of contexto.diasFechados ?? []) {
    const re = NOME_DO_DIA[dia];
    if (re?.test(t)) {
      return {
        action: "skip",
        reason: `follow-up citou ${NOME_POR_EXTENSO[dia] ?? dia}, dia em que a clínica não abre`,
      };
    }
  }
  return { action: "send" };
}
