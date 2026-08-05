// QUALIFIER AGENT
// Conduz RECEPTION e QUALIFICATION. Identifica o interesse do lead (via UTM
// como fonte primária + conversa como fallback), aplica tag de qualificação
// e — quando o lead estiver claramente pronto — propõe SLOT_OFFER.
//
// Filosofia:
// - SEM acesso a ferramentas de agendamento. O qualifier não pode "pular"
//   pra agendar — só sinaliza o stage SLOT_OFFER e o scheduler assume.
// - Mensagens curtas, uma pergunta por vez (SPIN style).
// - No 1º ciclo NUNCA aplica tag (só observa).

import { z } from "zod";
import type { AgentContext, AgentResult } from "./context";
import {
  callLlmWithFallback,
  callLlmStructuredWithFallback,
  type LlmMessage,
  type LlmTool,
} from "./llm.server";
import { decideRagNeed } from "./rag-gate.server";
import { execListarHorarios } from "./scheduler.server";
import { APLICAR_TAG_TOOL, execAplicarTagInteresse } from "./tags.server";
import {
  buildConsultarPlanilhaTool,
  buildSheetsPromptBlock,
  execConsultarPlanilha,
} from "./sheets.server";
import { buildOwnerStylePromptBlock } from "./owner-style-prompt.server";
import {
  agentUsesTurmaClassifier,
  backfillBookingFieldsFromHistory,
  buildChannelPhonePromptBlock,
  mergeLeadDataPatch,
  scrubInventedTimeOffers,
  tagGateMissingField,
  turmaTagsForLead,
  turmaTagCandidates,
} from "@/lib/booking-template";
import { sanitizeStructuredAgentJson, stripNullishFields } from "./parse-llm-json.server";
import type { LeadData, Stage } from "./stage";
import { loadHelenaAccount } from "@/lib/helena.server";
import {
  applyTagByApproxName,
  applyOneOfTags,
  getInterestCandidateTagNames,
  NOT_SCHEDULED_SYNONYMS,
} from "@/lib/helena-tags.server";
import {
  searchKnowledge,
  formatChunksAsContext,
} from "@/lib/knowledge/retrieval.server";
import {
  sendMediaBySlug,
  getAvailableMediaForPrompt,
} from "./send-media.server";

const VALID_STAGES = ["RECEPTION", "QUALIFICATION", "SLOT_OFFER", "ESCALATED"] as const;

// custom_fields deve ser Record<string,string>, mas o LLM às vezes devolve
// números (ex: convidados: 150) ou booleans. Em vez de quebrar o turn inteiro
// na validação, coage número/boolean para string e descarta valores não
// representáveis (null, objetos, arrays).
const coercibleStringRecord = z.preprocess((val) => {
  if (val == null || typeof val !== "object" || Array.isArray(val)) return val;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
    if (typeof v === "string") out[k] = v;
    else if (typeof v === "number" || typeof v === "boolean") out[k] = String(v);
    // null/undefined/objeto/array: descarta silenciosamente
  }
  return out;
}, z.record(z.string()));

const ResultSchema = z.object({
  reply: z.string().min(1),
  // next_stage opcional — alguns modelos (Gemini Flash, Llama) as vezes omitem.
  // Quando ausente, usamos ctx.stage como fallback (mantém stage atual).
  next_stage: z.enum(VALID_STAGES).optional(),
  lead_data_patch: z
    .object({
      name: z.string().nullish(),
      interest: z.string().nullish(),
      notes: z.string().nullish(),
      escalation_reason: z.string().nullish(),
      retomar_em: z.string().nullish(),
      retorno_motivo: z.string().nullish(),
      custom_fields: coercibleStringRecord.nullish(),
    })
    // .nullish(): alguns modelos devolvem lead_data_patch:null em vez de omitir.
    .nullish(),
  reasoning: z.string().optional(),
});

type QualifierJsonResult = z.infer<typeof ResultSchema>;

// ── Tools do qualifier (apenas helena_tags) ────────────────────────────────

const QUALIFIER_TOOLS: LlmTool[] = [
  APLICAR_TAG_TOOL,
  {
    type: "function",
    function: {
      name: "enviar_midia",
      description:
        "Envia uma das mídias cadastradas (imagem, vídeo, áudio ou PDF) para o lead via WhatsApp. " +
        "Use somente quando fizer sentido no fluxo: ex. enviar antes/depois ao discutir um caso, " +
        "vídeo de localização ao confirmar agendamento, foto da equipe. " +
        "As mídias disponíveis estão listadas na seção 'MÍDIAS DISPONÍVEIS' do contexto.",
      parameters: {
        type: "object",
        properties: {
          slug: {
            type: "string",
            description: "Slug EXATO da mídia (ex: 'antes_depois_implante', 'localizacao').",
          },
          caption: {
            type: "string",
            description: "Legenda opcional que acompanha o arquivo (ex: 'Aqui está nossa localização!')",
          },
        },
        required: ["slug"],
      },
    },
  },
];

/** Alguma agenda ativa na conta? (mesma regra do scheduler). */
function hasBookingIntegration(ctx: AgentContext): boolean {
  return (
    ctx.integrations.googleCalendar ||
    ctx.integrations.clinicorp ||
    ctx.integrations.clinup ||
    ctx.integrations.clinicExperts
  );
}

/**
 * Consulta de agenda no qualifier — SOMENTE LEITURA.
 *
 * Por que o qualifier passou a ver a agenda: o repasse qualifier → scheduler é
 * decidido por heurística de texto em português (stage-signals) e erra sempre
 * que uma conta escreve o CTA de um jeito novo. Quando errava, quem respondia
 * era o qualifier — que não tinha NENHUMA tool de agenda e só sabia prometer
 * "vou verificar". Já foram 5 correções no mesmo ponto (c01a675, 8832ccc,
 * 96f9fda, e41baeb, 9a28fad) e o caso da MF Beauty Magé (28/07) foi a 6ª.
 *
 * Com a consulta disponível, um repasse perdido degrada pra "horário REAL, um
 * turno antes do previsto" em vez de "lead sem resposta útil". Criar/cancelar
 * continuam exclusivos do scheduler — o qualifier não escreve na agenda.
 */
const QUALIFIER_AGENDA_TOOL: LlmTool = {
  type: "function",
  function: {
    name: "listar_horarios",
    description:
      "Consulta os horários REAIS disponíveis na agenda da clínica (somente leitura). " +
      "Chame SEMPRE que o lead aceitar ver horários, perguntar disponibilidade ou citar uma data — " +
      "NUNCA responda 'vou verificar' sem chamar esta tool. " +
      "Você NÃO agenda: depois de ofertar, sinalize next_stage='SLOT_OFFER' e o módulo de agendamento finaliza. " +
      "Ofereça no máximo 2 horários, copiando date_label e time_label LITERALMENTE como vieram.",
    parameters: {
      type: "object",
      properties: {
        data_alvo: {
          type: "string",
          description:
            "Data específica pedida pelo lead no formato YYYY-MM-DD. A busca começa nessa data. Omita se o lead não citou uma data.",
        },
        periodo: {
          type: "string",
          enum: ["manha", "tarde", "noite"],
          description:
            "Turno pedido pelo lead: 'manha' (antes do meio-dia), 'tarde' (12:00–18:00) ou 'noite' (a partir das 18:00). SEMPRE informe quando o lead disser um período.",
        },
      },
      required: [],
    },
  },
};

/** Ferramentas do qualifier para este agente. Em agentes com classificação
 *  determinística de turma (turma_auto), removemos aplicar_tag_interesse — a
 *  tag de turma é aplicada pelo código, nunca pelo LLM (evita etiqueta no chute
 *  ou turma errada). Com agenda ativa, ganha a consulta de horários (read-only). */
function buildQualifierTools(ctx: AgentContext): LlmTool[] {
  let tools = QUALIFIER_TOOLS;
  if (agentUsesTurmaClassifier(ctx.agentSettings)) {
    tools = tools.filter((t) => t.function.name !== "aplicar_tag_interesse");
  }
  if (hasBookingIntegration(ctx)) {
    tools = [...tools, QUALIFIER_AGENDA_TOOL];
  }
  // Planilha (tabela de preços etc.): pergunta de valor chega quase sempre na
  // qualificação, então a consulta precisa existir aqui — não só no scheduler.
  const sheetTool = buildConsultarPlanilhaTool(ctx);
  if (sheetTool) tools = [...tools, sheetTool];
  return tools;
}

interface ToolOutcome {
  result: string;
  patch?: Partial<LeadData>;
}

/** Trava de etiquetagem: chave do dado que ainda falta (ou null). Detalhes em
 *  tagGateMissingField (booking-template). Ex.: escola só etiqueta turma após a
 *  data de nascimento (settings.tag_gate_field). */
function tagGateMissing(ctx: AgentContext): string | null {
  return tagGateMissingField(ctx.agentSettings, ctx.leadData);
}

/**
 * Aplica a tag de TURMA de forma determinística (Maple Bear / turma_auto):
 * calcula a turma pela data de nascimento e aplica a tag certa, MANTENDO a tag
 * N/A (InsertIfNotExists não remove as demais). Retorna a turma aplicada (para
 * gravar em interest) ou null. Idempotente: só aplica se a turma mudou.
 */
async function applyTurmaTagDeterministic(ctx: AgentContext): Promise<string | null> {
  // TODAS as turmas (suporta irmãos: dois filhos → duas turmas).
  const turmas = turmaTagsForLead(ctx.agentSettings, ctx.leadData);
  if (turmas.length === 0) return null;
  const joined = turmas.join(", ");
  if (ctx.leadData.interest === joined) return null; // já aplicadas neste lead

  if (ctx.dryRun || ctx.disableTags) {
    console.log(
      `[qualifier] turma(s) determinística(s) '${joined}' (pulada: ${ctx.disableTags ? "test_mode" : "dry_run"})`,
    );
    return joined; // grava interest mesmo assim (sem tocar o CRM em teste)
  }
  if (!ctx.helenaContact?.id) return joined;

  try {
    const helena = await loadHelenaAccount(ctx.accountId);
    const refYear = Number(ctx.agentSettings.turma_ano_letivo) || 2026;
    // O CRM costuma cadastrar a turma CODIFICADA ("06 Y126", "03 NS26"...), não
    // "YEAR 1"/"NURSERY". Tentamos os candidatos código→nome por turma. Aplicamos
    // UMA por vez, atualizando currentTags entre as aplicações — assim a segunda
    // turma NÃO derruba a primeira (o setHelenaContactTags faz ReplaceAll com a
    // união das tags atuais).
    const currentTags = [...(ctx.helenaContact.tagNames ?? [])];
    for (const turma of turmas) {
      const candidates = turmaTagCandidates(turma, refYear);
      const res = await applyOneOfTags(
        helena,
        ctx.helenaContact.id,
        candidates,
        "InsertIfNotExists",
        { currentTags },
      );
      if (res.ok && res.tag) {
        currentTags.push(res.tag);
        console.log(`[qualifier] turma aplicada: ${res.tag} (calc="${turma}")`);
      } else {
        console.warn(
          `[qualifier] turma '${turma}' não encontrada no CRM (tentados: ${candidates.join(", ")}) — crie a tag com um desses nomes`,
        );
      }
    }
  } catch (e) {
    console.warn("[qualifier] erro ao aplicar tag(s) de turma:", e);
  }
  return joined;
}


/**
 * Aplica a tag inicial de "lead recebido / não agendado" no primeiro contato.
 * Roda automaticamente (não é tool — o LLM não precisa pedir).
 * Procura no CRM a primeira tag que case com a lista de sinônimos
 * NOT_SCHEDULED_SYNONYMS ("N/A", "Não Agendado", "Lead", "Aguardando", etc).
 * Funciona para qualquer tipo de negócio (clínica, escola, etc) — desde que
 * uma das variantes esteja cadastrada no CRM.
 */
async function ensureInitialNotScheduledTag(ctx: AgentContext): Promise<void> {
  if (ctx.dryRun || ctx.disableTags) return;
  if (!ctx.helenaContact?.id) return;
  if (ctx.leadData.initial_tag_applied) return; // idempotente
  try {
    const helena = await loadHelenaAccount(ctx.accountId);
    const res = await applyOneOfTags(
      helena,
      ctx.helenaContact.id,
      NOT_SCHEDULED_SYNONYMS,
      "InsertIfNotExists",
      { currentTags: ctx.helenaContact.tagNames },
    );
    if (res.ok) {
      console.log(`[qualifier] tag inicial aplicada: ${res.tag}`);
    } else {
      console.log(`[qualifier] tag inicial não aplicada (motivo=${res.reason})`);
    }
  } catch (e) {
    console.warn("[qualifier] falha ao aplicar tag inicial:", e);
  }
}

// ── Prompts ────────────────────────────────────────────────────────────────

// Scaffold técnico — SEMPRE anexado quando o prompt do proprietário domina.
// Contém só o que o parser e a máquina de estados precisam (módulo, estágios
// válidos, ferramentas e formato JSON). O comportamento/persona vem do prompt.
/** O bloco de agenda muda conforme a conta TER ou NÃO integração ativa:
 *  com agenda o qualifier consulta horários reais (listar_horarios); sem
 *  agenda continua proibido de citar qualquer horário, que seria inventado. */
function buildAgendaScaffoldBlock(hasAgenda: boolean): string {
  if (!hasAgenda) {
    return `Você NÃO tem acesso à agenda/calendário. NUNCA diga "vou verificar",
"deixa eu dar uma olhadinha", "já te retorno" — você não consegue cumprir
e a conversa morre. Se o lead perguntar disponibilidade de data/horário,
use next_stage="SLOT_OFFER" e responda confirmando o interesse com uma
pergunta (ex: "Essa data é para qual tipo de evento?").

🚫 HORÁRIOS: pela MESMA razão (você não tem a agenda), NUNCA cite dias da
semana, datas ou horários concretos ("segunda às 14h", "amanhã às 10h") —
seriam INVENTADOS e podem cair em dia bloqueado, criando expectativa falsa.
Ao sinalizar next_stage="SLOT_OFFER", NÃO liste horários: pergunte uma
preferência neutra (ex.: "você prefere de manhã ou à tarde?") — o módulo de
agendamento consulta a agenda REAL e oferta os horários no turno seguinte.

Ferramentas disponíveis (chame quando fizer sentido no fluxo):
- aplicar_tag_interesse: registra o interesse do lead no CRM. Não use no 1º
  ciclo, exceto se a primeira mensagem já trouxer interesse explícito.
- enviar_midia: envia uma mídia cadastrada (ver seção "MÍDIAS DISPONÍVEIS").`;
  }

  return `📅 AGENDA: você TEM consulta de agenda (listar_horarios), somente leitura.
NUNCA diga "vou verificar", "deixa eu dar uma olhadinha", "já te retorno" —
CHAME a tool na hora. Chame listar_horarios sempre que o lead:
- aceitar ver horários ("quero sim", "pode ser", "manda"),
- perguntar disponibilidade ("tem vaga?", "tem horário essa semana?"),
- citar uma data ou turno ("dia 25", "quinta", "de manhã") — passe \`data_alvo\`
  (YYYY-MM-DD) e/ou \`periodo\` ("manha"/"tarde"/"noite").

🚫 HORÁRIOS: NUNCA cite dia, data ou hora que não tenha vindo de listar_horarios
nesta conversa — seriam inventados e podem cair em dia bloqueado. Ao ofertar,
copie \`date_label\` e \`time_label\` LITERALMENTE como vieram da tool e ofereça
no MÁXIMO 2 opções. Se a tool voltar vazia, diga que vai verificar as próximas
datas e sinalize next_stage="SLOT_OFFER" — nunca invente um horário.

Você NÃO agenda: criar, cancelar e remarcar são do módulo de agendamento. Assim
que o lead escolher (ou você ofertar) um horário, use next_stage="SLOT_OFFER" —
o módulo de agendamento confirma o horário e coleta os dados restantes.

Ferramentas disponíveis (chame quando fizer sentido no fluxo):
- listar_horarios: consulta os horários REAIS da agenda (somente leitura).
- aplicar_tag_interesse: registra o interesse do lead no CRM. Não use no 1º
  ciclo, exceto se a primeira mensagem já trouxer interesse explícito.
- enviar_midia: envia uma mídia cadastrada (ver seção "MÍDIAS DISPONÍVEIS").`;
}

function buildQualifierTechnicalScaffold(ctx: AgentContext): string {
  const hasAgenda = hasBookingIntegration(ctx);
  return `# ⚙️ REGRAS TÉCNICAS DO SISTEMA (não exibir ao lead)

Você opera no MÓDULO DE QUALIFICAÇÃO (estágios RECEPTION e QUALIFICATION).
Você NÃO agenda — quando o interesse estiver claro e o lead demonstrar
disposição de avançar, sinalize next_stage="SLOT_OFFER" e o módulo de
agendamento assume a partir daí.

${
  ctx.integrations.googleSheets
    ? `🚫 PREÇO/VALOR: só existe UMA fonte de valor — a tool \`consultar_planilha\`.
Perguntou preço? CHAME a tool e copie o valor LITERALMENTE como veio (mesmo
número, mesma unidade). Se a tool não achou a linha, ou se o dado não está na
planilha, diga que vai confirmar com a equipe e conduza ao agendamento.
NUNCA invente, estime, arredonde, converta, parcele nem calcule total —
mesmo que o lead insista ou pressione dizendo que só decide sabendo o valor.`
    : `🚫 PREÇO/VALOR: NUNCA informe preço, valor, "a partir de" ou "investimento
de R$" de consulta, avaliação ou procedimento — mesmo que o lead insista ou
pressione dizendo que só decide sabendo o valor. Só cite um valor se ele
estiver ESCRITO EXPLICITAMENTE nas instruções acima (prompt do proprietário).
Se não estiver, responda que o valor é definido na avaliação presencial (cada
caso é único) e conduza ao agendamento. NUNCA invente nem estime um número.`
}
${buildSheetsPromptBlock(ctx)}

${buildAgendaScaffoldBlock(hasAgenda)}

Valores válidos de next_stage:
- "RECEPTION" → primeira mensagem, só saudação
- "QUALIFICATION" → continuando a descoberta do interesse
- "SLOT_OFFER" → interesse claro + sinal de avanço (preço, horário, "quero")
- "ESCALATED" → pedido de humano, situação delicada ou falha grave

# FORMATO DE SAÍDA OBRIGATÓRIO

Responda APENAS em JSON válido:
{
  "reply": "mensagem curta a enviar ao lead",
  "next_stage": "RECEPTION" | "QUALIFICATION" | "SLOT_OFFER" | "ESCALATED",
  "lead_data_patch": {
    "interest": "interesse identificado",
    "name": "nome COMPLETO (nome + sobrenome) se já mencionado — nunca abrevie nem guarde só o primeiro nome",
    "notes": "queixa principal em 1 frase",
    "custom_fields": { "chave": "valor" },
    "escalation_reason": "se next_stage=ESCALATED",
    "retomar_em": "ISO 8601 com fuso -03:00 — SÓ se o lead pediu para ser contatado em outra data/hora; senão omita"
  },
  "reasoning": "1 frase do raciocínio"
}`;
}

function buildCachedSystemPrompt(ctx: AgentContext): string {
  const s = ctx.agentSettings;

  // O prompt do proprietário DOMINA quando presente: vai no topo como
  // comportamento principal, seguido apenas do scaffold técnico necessário.
  // O template padrão abaixo é só a "semente" — usada quando ainda não há
  // prompt configurado.
  if (ctx.basePrompt && ctx.basePrompt.trim()) {
    return `${ctx.basePrompt.trim()}

${buildOwnerStylePromptBlock()}

${buildQualifierTechnicalScaffold(ctx)}`;
  }

  return `Você é ${s.assistant_name || "a assistente"}, ${s.assistant_role || "atendente virtual"} de ${s.company_name || "(nome da empresa)"}.

Você está no MÓDULO DE QUALIFICAÇÃO. Seu objetivo é entender o que o lead precisa, criar conexão humana e — somente quando o interesse estiver claro — sinalizar que o agendamento pode começar.

# ESTÁGIOS QUE VOCÊ OPERA

- **RECEPTION**: primeira mensagem do lead. Comportamento depende do que ele enviou:

  **CASO A — M1 vaga ("Oi", "Tudo bem?", "Bom dia")**: cumprimente, identifique-se
  e pergunte como pode ajudar. Use UTM Content se disponível para insinuar o
  interesse sem mencionar UTM/sistemas.

  **CASO B — M1 com interesse explícito ("quero saber sobre tráfego pago",
  "tô com dor no dente", "quero matricular minha filha")**: NÃO pergunte
  "como posso te ajudar?" — isso ignora o que o lead já disse. Em vez disso:
    1. Cumprimente brevemente reconhecendo o interesse ("Oi! Que ótimo que se
       interessou por X — fico feliz em te ajudar.")
    2. Faça JÁ a primeira pergunta SPIN de descoberta sobre esse interesse
       (ex.: "Como você prefere que eu te chame?" + "Você já trabalhou com
       tráfego pago antes ou está começando agora?")
    3. Aplique a tag de interesse correspondente neste mesmo turno (regra #7
       é flexibilizada para M1 com interesse claro).
    4. next_stage="QUALIFICATION" (não fica em RECEPTION).

- **QUALIFICATION**: faça perguntas SPIN para entender:
  • Situação atual (há quanto tempo está com a queixa, contexto)
  • Problema específico (dor, estética, função, necessidade)
  • Impacto (como afeta o dia a dia, autoestima, decisão)
  • Necessidade declarada (o que está procurando)

# REGRAS ABSOLUTAS

1. **TODA mensagem DEVE terminar com uma pergunta que mantenha o diálogo ativo e direcione o lead para o agendamento.** Nunca finalize com afirmação solta.
2. UMA pergunta por vez. Mensagens curtas (máx 3 frases por turno).
3. Para enviar 2 bolhas no WhatsApp, separe blocos com linha em branco no campo reply (use \\n\\n entre saudação e pergunta, ou entre contexto e pergunta).
4. NUNCA mencione ferramentas, automações, CRM, tags ou sistemas.
5. NUNCA invente fatos clínicos ou prometa resultados.
${
  ctx.integrations.googleSheets
    ? `5b. 🚫 **PREÇO/VALOR:** a ÚNICA fonte de valor é a tool \`consultar_planilha\`. Perguntou preço → CHAME a tool e copie o valor LITERALMENTE. Não achou na planilha → diga que vai confirmar com a equipe. NUNCA invente, estime, arredonde nem calcule total, mesmo sob insistência.`
    : `5b. 🚫 **PREÇO/VALOR:** NUNCA informe preço, valor, "a partir de" ou "investimento de R$" de consulta, avaliação ou procedimento — mesmo sob insistência do lead. Só cite um valor se estiver ESCRITO EXPLICITAMENTE no prompt do proprietário. Se não estiver, diga que o valor é definido na avaliação presencial e conduza ao agendamento. NUNCA invente nem estime um número.`
}
${buildSheetsPromptBlock(ctx)}
${
  hasBookingIntegration(ctx)
    ? `5c. 🚫 **HORÁRIOS:** só cite dia, data ou hora que tenha vindo de \`listar_horarios\` NESTA conversa — qualquer outro seria inventado e pode cair em dia bloqueado. Ao ofertar, copie \`date_label\` e \`time_label\` LITERALMENTE e ofereça no MÁXIMO 2 opções.
6. NUNCA tente agendar você mesma (criar/cancelar/remarcar são do módulo de agendamento). Chame \`listar_horarios\` e sinalize next_stage="SLOT_OFFER" quando:
   • O interesse principal estiver identificado com clareza
   • O lead manifestar disposição (explícita ou implícita) de avançar
   • OU o lead perguntar disponibilidade de data/horário ("tem data livre dia 25/07?") — nesse caso CHAME \`listar_horarios\` com \`data_alvo\` no MESMO turno. NUNCA diga "vou verificar", "deixa eu olhar", "já te retorno" sem chamar a tool.`
    : `5c. 🚫 **HORÁRIOS:** você NÃO tem acesso à agenda — NUNCA cite dias da semana, datas ou horários concretos ("segunda às 14h") ao ofertar atendimento; seriam inventados e podem cair em dia bloqueado. Ao sinalizar SLOT_OFFER, pergunte uma preferência neutra ("prefere de manhã ou à tarde?") — os horários REAIS vêm da agenda no turno seguinte.
6. NUNCA tente agendar você mesma — só sinalize next_stage="SLOT_OFFER" quando:
   • O interesse principal estiver identificado com clareza
   • O lead manifestar disposição (explícita ou implícita) de avançar
   • OU o lead perguntar disponibilidade de data/horário ("tem data livre dia 25/07?") — nesse caso sinalize SLOT_OFFER IMEDIATAMENTE. Você NÃO tem acesso à agenda: NUNCA diga "vou verificar", "deixa eu olhar", "já te retorno".`
}
7. Se o lead pedir explicitamente humano, atendente, "falar com a doutora", reclamação delicada → next_stage="ESCALATED" + lead_data_patch.escalation_reason
8. Tags de interesse:
   • Se a M1 do lead JÁ contém interesse claro (caso B do RECEPTION) → APLIQUE a tag de interesse JÁ no 1º ciclo.
   • Se a M1 é vaga ("Oi", "Tudo bem?") → não aplique tag ainda; aguarde o 2º ciclo, quando o interesse ficar claro.
9. **NÃO repita pedaços do prompt em sequência sem evolução.** Se o lead respondeu "sim", "ok", "uhum", "blz" — avance: faça a próxima pergunta SPIN ou ofereça horário. NUNCA fique repetindo o mesmo discurso de valor.
10. **Dados extras do fluxo** que o lead fornecer espontaneamente (ou que o prompt do proprietário pedir explicitamente) → salve em \`lead_data_patch.custom_fields\` com uma chave descritiva. NÃO invente nem peça campos que o negócio não solicitou. Preserve dados já coletados ao avançar para SLOT_OFFER. **Nunca repita pergunta de campo já presente em LEAD_DATA.**
11. **Após 3-4 ciclos com interesse claro e lead responsivo, transite para SLOT_OFFER.** Não fique infinitamente em QUALIFICATION.

# DECISÃO DE next_stage

- next_stage="RECEPTION" → apenas se ainda é a primeira mensagem e você fez só saudação
- next_stage="QUALIFICATION" → continuando a descoberta
- next_stage="SLOT_OFFER" → interesse claro + sinal de avanço (ex: "quero saber preço", "tem horário?")
- next_stage="ESCALATED" → pedido de humano, situação delicada, falha técnica grave

# DADOS DA CLÍNICA

- Nome: ${s.company_name || "(não informado)"}
- Profissional principal: ${s.doctor_name || "(não informado)"}
- Endereço: ${s.company_address || "(não informado)"}
- Horário: ${s.business_hours || "(não informado)"}
- Diferenciais: ${s.featured_services || "(não informado)"}

${buildOwnerStylePromptBlock()}

# FORMATO DE SAÍDA OBRIGATÓRIO

Responda APENAS em JSON válido:
{
  "reply": "mensagem curta a enviar ao lead (emojis permitidos se o proprietário pedir)",
  "next_stage": "RECEPTION" | "QUALIFICATION" | "SLOT_OFFER" | "ESCALATED",
  "lead_data_patch": {
    "interest": "IMPLANTE | FACETAS | PROTESE | CLAREAMENTO | ORTODONTIA | OUTRO",
    "name": "nome COMPLETO (nome + sobrenome) se já mencionado — nunca abrevie nem guarde só o primeiro nome",
    "notes": "queixa principal em 1 frase",
    "escalation_reason": "se next_stage=ESCALATED",
    "retomar_em": "ISO 8601 com fuso -03:00 — SÓ se o lead pediu para ser contatado em outra data/hora; senão omita"
  },
  "reasoning": "1 frase do raciocínio"
}`;
}

function buildDynamicSystemPrompt(ctx: AgentContext, candidateTags: string[]): string {
  const TZ = "America/Sao_Paulo";
  const dateStr = new Intl.DateTimeFormat("pt-BR", {
    timeZone: TZ,
    weekday: "long",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date());

  const ld = ctx.leadData;
  const utm = ctx.helenaContact?.utm;
  const tags = ctx.helenaContact?.tagNames ?? [];

  const cycleCount = ctx.history.filter((m) => m.role === "user").length;

  // Detecta se a M1 (primeira mensagem do lead) já carrega interesse explícito.
  // Heurística: >= 20 caracteres E não é saudação genérica E contém palavras
  // de intenção ("quero", "preciso", "gostaria", "tô com", "estou com",
  // "informações", "matrícula", "sobre", "preço", "valor", "horário")
  // OU já temos UTM Content (que sempre carrega o interesse da campanha).
  const firstUserMsg = ctx.history.find((m) => m.role === "user")?.content ?? "";
  const m1Trimmed = firstUserMsg.trim().toLowerCase();
  const isGreetingOnly = /^(oi|ola|olá|bom dia|boa tarde|boa noite|hey|opa|e aí|eai|tudo bem\??)[!.\s]*$/i.test(m1Trimmed);
  const hasIntentWords = /\b(quero|gostaria|preciso|to com|tô com|estou com|sobre|interesse|informaç|matric|preço|valor|horário|horario|orçament|orcament|consulta|atend|servic|servi[çc]o|curso|aula)\b/i.test(m1Trimmed);
  const hasExplicitInterestInM1 =
    !!utm?.content ||
    (m1Trimmed.length >= 20 && !isGreetingOnly && hasIntentWords);

  const phoneBlock = buildChannelPhonePromptBlock(ctx.channel, ctx.effectivePhone);
  const ownerPromptDominant = !!(ctx.basePrompt && ctx.basePrompt.trim());

  // Trava de pré-requisito de etiquetagem (ex.: só etiquetar após a data de
  // nascimento). Quando o dado ainda falta, avisamos o LLM para não tentar.
  const tagGateField = tagGateMissing(ctx);
  const tagGateBlock = tagGateField
    ? `\n- ⛔ NÃO aplique NENHUMA tag de interesse ainda: falta o dado obrigatório "${tagGateField}". Pergunte/colete esse dado primeiro; só depois escolha a tag correspondente.`
    : "";

  // Turma determinística (turma_auto): o CÓDIGO calcula a turma e etiqueta. O
  // prompt recebe a turma oficial para o LLM FALAR a mesma coisa que a tag —
  // sem recalcular (o LLM erra o corte 31/03 e contradizia a etiqueta).
  const turmaAuto = agentUsesTurmaClassifier(ctx.agentSettings);
  const turmasCalc = turmaAuto ? turmaTagsForLead(ctx.agentSettings, ctx.leadData) : [];
  const multiChildBlock = turmaAuto
    ? `\n\n# MAIS DE UMA CRIANÇA (irmãos)\nSe o responsável tiver MAIS de um filho, trate cada criança individualmente: colete o NOME e a DATA DE NASCIMENTO de CADA uma. Peça uma criança por vez (ex.: "Qual a data de nascimento do Miguel?" e, depois da resposta, "E a da Maria Alice?"). Se o lead responder CITANDO/respondendo uma mensagem específica, o contexto virá marcado como [Em resposta à mensagem: "..."] — use-o para saber a qual criança a data pertence. Registre TODAS as datas de nascimento (uma por criança) — o sistema calcula e etiqueta a turma de CADA criança automaticamente.`
    : "";
  const turmaBlock = !turmaAuto
    ? ""
    : turmasCalc.length > 0
      ? `\n\n# TURMA(S) — CÁLCULO OFICIAL DO SISTEMA\nTurma(s) correta(s) para a(s) data(s) informada(s): **${turmasCalc.join(", ")}**. Ao falar com o lead, use EXATAMENTE esse(s) nome(s) — NÃO recalcule e NÃO diga outra turma. A(s) etiqueta(s) já é(são) aplicada(s) automaticamente; você NÃO deve etiquetar.${multiChildBlock}`
      : `\n\n# TURMA\nAinda não há data de nascimento válida. NÃO afirme nenhuma turma ao lead enquanto não tiver a data. Quando a data chegar, o sistema calcula e etiqueta a turma automaticamente.${multiChildBlock}`;

  // Retorno agendado pelo lead: instrução SEMPRE presente (vai no stateBlock,
  // que é o único bloco entregue quando o prompt do proprietário domina).
  const callbackBlock = `

# RETORNO AGENDADO PELO LEAD (NÃO é agendamento de consulta)
Se o lead disser que NÃO pode falar agora e pedir para ser contatado DEPOIS
("me chama amanhã", "fala comigo semana que vem", "só consigo segunda à tarde"):
- Responda educadamente confirmando que você retorna na data combinada.
- Calcule a data/hora em ISO 8601 com fuso -03:00 a partir de "Agora (BRT)" acima
  (ex.: "amanhã às 15h" → "${(() => { const d = new Date(Date.now() + 86400000); const p = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit" }).format(d); return `${p}T15:00:00-03:00`; })()}"; "semana que vem" sem hora → escolha um horário comercial, ex.: 10:00).
- Preencha lead_data_patch.retomar_em com essa data e retorno_motivo com o pedido
  em 1 frase. Isso PAUSA os follow-ups automáticos até a data combinada.
NÃO preencha retomar_em quando o lead quer MARCAR consulta (isso é o fluxo de
horários/slots) nem quando ele só está respondendo normalmente.`;

  // Bloco de ESTADO + tags = DADOS, não comportamento. Sempre presente.
  const stateBlock = `# ESTADO ATUAL

- 📅 HOJE é ${dateStr} (horário de São Paulo). Esta é a SUA referência de tempo: antes de falar de qualquer dia/data, localize-se por ela. NUNCA mencione ou ofereça datas no PASSADO. Ao interpretar "amanhã", "semana que vem", "sexta", "dia 15", "hoje à tarde", calcule SEMPRE a partir de HOJE.
- Stage corrente: ${ctx.stage}
- Ciclos de conversa já completos: ${cycleCount}
- Canal: ${ctx.channel}
${phoneBlock ? `\n${phoneBlock}\n` : ""}${utm?.content ? `- UTM Content (interesse PRIMÁRIO): "${utm.content}"` : "- UTM Content: (vazio — identifique pelo histórico)"}
${utm?.source ? `- UTM Source: ${utm.source}` : ""}
${utm?.medium ? `- UTM Medium: ${utm.medium}` : ""}
${tags.length > 0 ? `- Tags atuais no CRM neste contato: ${tags.join(", ")}` : "- Sem tags ainda neste contato"}${turmaBlock}

# TAGS DE INTERESSE DISPONÍVEIS NO CRM

A lista abaixo foi consultada AGORA via GET /core/v1/tag. São as tags de
interesse cadastradas neste CRM (já excluídas as de status N/A/AGENDADO/IA
Desligada que são gerenciadas pelo sistema). Escolha UMA que case com o
interesse identificado na conversa. Use o NOME EXATO — não altere caixa,
acento, pontuação. Não invente nomes novos.

${candidateTags.length > 0 ? candidateTags.map((t) => `- ${t}`).join("\n") : "  (nenhuma tag de interesse cadastrada no CRM — peça ao proprietário para criar)"}

## REGRA DE TAGS

- O agente atende negócios variados (clínicas, escolas, cursos, etc.) —
  use a tag que melhor represente o interesse, independente do nicho.
- Aplique APENAS UMA tag de interesse por contato.
- ⚠️ COERÊNCIA OBRIGATÓRIA: a tag DEVE corresponder EXATAMENTE à
  turma/interesse que você identificou e comunicou ao lead. Se você disse ao
  lead que a turma é "YEAR 2", aplique a tag dessa MESMA turma (ex.: a tag
  "YEAR 2" ou o código equivalente "Y226") — NUNCA a de outra turma (Nursery,
  TODDLER, etc.). Antes de chamar aplicar_tag_interesse, releia a turma que
  você afirmou e confira, na lista acima, o nome EXATO da tag que corresponde a
  ELA. Se a lista tiver tanto código (Y226) quanto nome (YEAR 2) para a mesma
  turma, qualquer um serve — desde que seja da turma CERTA.
- Se nenhuma tag bate com o interesse identificado, NÃO invente — deixe sem
  tag de interesse (melhor sem tag do que com a tag errada).
- A tag de status inicial ("N/A Não Agendado" ou equivalente) já é aplicada
  automaticamente — você não precisa pedir.
- A tag "Agendado" é aplicada automaticamente quando o agendamento conclui
  — você também não precisa pedir.${tagGateBlock}

# LEAD_DATA JÁ COLETADO

${JSON.stringify(
  {
    name: ld.name ?? null,
    interest: ld.interest ?? null,
    notes: ld.notes ?? null,
  },
  null,
  2,
)}${callbackBlock}`;

  // Quando o prompt do proprietário domina, entregamos SÓ estado/dados. A
  // abertura, o ritmo de ciclos e o fechamento vêm do prompt dele — injetar
  // prescrições aqui competiria com (e venceria) o que ele escreveu.
  if (ownerPromptDominant) return stateBlock;

  // Template padrão (semente) — mantém os blocos comportamentais originais.
  return `${stateBlock}

${
  cycleCount <= 1 && hasExplicitInterestInM1
    ? `# ⚡ ATENÇÃO — M1 com interesse explícito

A primeira mensagem do lead foi: "${firstUserMsg.slice(0, 200)}"

Ele JÁ disse o que quer. NÃO pergunte "como posso te ajudar?" — isso ignora
o que ele acabou de dizer e gera fricção. Em vez disso:
  1. Cumprimente reconhecendo o tema ("Oi! Que ótimo seu interesse em X...")
  2. Pergunte o NOME do lead
  3. Sinalize que vai te ajudar com isso
  4. Aplique a tag de interesse compatível NESTE turno (chame aplicar_tag_interesse)
`
    : ""
}

# REGRA DE CICLOS

${
  cycleCount <= 1
    ? hasExplicitInterestInM1
      ? "**1º CICLO COM INTERESSE EXPLÍCITO** — o lead já disse o que quer. Reconheça o interesse, aplique a tag de interesse correspondente JÁ neste turno (caso B do RECEPTION). NÃO pergunte 'como posso ajudar' — pule direto para descoberta SPIN."
      : "**1º CICLO M1 VAGA** — só saudação + 1 pergunta de descoberta. Não aplique tags ainda."
    : "Pode usar aplicar_tag_interesse se o interesse estiver identificado com segurança."
}

${cycleCount >= 4 && ld.interest ? `**ALERTA**: já são ${cycleCount} ciclos com interest=${ld.interest} identificado. Avance: faça a oferta de horário transitando para next_stage="SLOT_OFFER". O scheduler assume a partir daí.` : ""}

# LEMBRETE DE FECHAMENTO

Toda mensagem precisa terminar com uma PERGUNTA que mantenha o lead engajado e o conduza ao próximo passo do agendamento. Exemplos válidos: "Posso te oferecer um horário ainda essa semana?", "Quer que eu já te mostre uns horários disponíveis?", "Você prefere consulta pela manhã ou à tarde?". NUNCA termine com afirmação solta tipo "Será um investimento por nossa conta." — sempre puxe para a próxima ação.`;
}

// ── Runner ────────────────────────────────────────────────────────────────

const MAX_TOOL_LOOPS = 3; // qualifier raramente precisa de mais de 1 tool

export async function runQualifierAgent(ctx: AgentContext): Promise<AgentResult> {
  // 1) Lista tags CANDIDATAS A INTERESSE (cacheado por 1min) — exclui as de
  //    sistema (N/A, AGENDADO, IA Desligada) que são gerenciadas pelo código
  // 2) Aplica tag inicial "não agendado" se ainda não aplicada
  // 3) Busca conhecimento relevante (RAG) — best effort, não bloqueia
  let candidateTags: string[] = [];
  try {
    const helena = await loadHelenaAccount(ctx.accountId);
    // Exclui as blocked_tags do agente (status como "Paciente") das candidatas
    // de INTERESSE — a IA só decide interesse, nunca status do contato.
    const blockedRaw = (ctx.agentSettings as Record<string, string>).blocked_tags ?? "";
    const blocked = blockedRaw.split(/[,;\n]/).map((t) => t.trim()).filter(Boolean);
    candidateTags = await getInterestCandidateTagNames(helena, blocked);
  } catch (e) {
    console.warn("[qualifier] falha ao listar tags Helena:", e);
  }
  let initialTagApplied = ctx.leadData.initial_tag_applied ?? false;
  if (!initialTagApplied) {
    await ensureInitialNotScheduledTag(ctx);
    initialTagApplied = true; // marca mesmo se a tag não existe no CRM, evita re-tentar
  }

  // Backfill determinístico dos campos de booking a partir do histórico (nome da
  // criança, DATA DE NASCIMENTO, etc. coletados durante a qualificação). CRÍTICO
  // para a etiquetagem por turma: o dado que chega NESTE turn (ex.: a data de
  // nascimento) só entraria em lead_data depois do tool loop. Sem este backfill,
  // o gate de etiquetagem (que exige data de nascimento) bloquearia a tag da
  // turma exatamente no turn em que a turma é identificada — e o qualifier não
  // roda de novo após avançar para o agendamento. Também garante que esses
  // campos persistam para o scheduler.
  const channelCtxBackfill =
    ctx.channel != null
      ? { channel: ctx.channel, effectivePhone: ctx.effectivePhone ?? null }
      : undefined;
  const backfillPatch = backfillBookingFieldsFromHistory(
    ctx.leadData,
    ctx.history,
    ctx.agentSettings,
    channelCtxBackfill,
  );
  if (Object.keys(backfillPatch).length > 0) {
    ctx.leadData = mergeLeadDataPatch(ctx.leadData, backfillPatch);
    console.log(
      `[qualifier] backfill campos do histórico: ${Object.keys(backfillPatch.custom_fields ?? {}).join(",") || "—"}`,
    );
  }

  // RAG com Gate: primeiro um modelo barato decide se a msg precisa de RAG.
  // Quando precisa, ele já reescreve a query pra busca semântica. Isso
  // economiza embedding API call + vector search + ~700 tokens injetados
  // no prompt principal em conversas triviais ("ok", "tudo bem", saudações).
  const lastUserMsg = [...ctx.history].reverse().find((m) => m.role === "user")?.content ?? "";
  let ragContext = "";
  const gateCost = { costUsd: 0, tokensIn: 0, tokensOut: 0 };
  if (lastUserMsg) {
    const gate = await decideRagNeed(ctx.orKey, ctx.ragGateModel, ctx.history, lastUserMsg);
    gateCost.costUsd = gate.costUsd;
    gateCost.tokensIn = gate.tokensIn;
    gateCost.tokensOut = gate.tokensOut;
    if (gate.need) {
      const ragChunks = await searchKnowledge(ctx.agentId, gate.query || lastUserMsg, 5);
      ragContext = formatChunksAsContext(ragChunks);
      console.log(
        `[qualifier] RAG: gate=true (${gate.reasoning ?? "ok"}) query="${(gate.query || lastUserMsg).slice(0, 60)}" → ${ragChunks.length} chunks`,
      );
    } else {
      console.log(`[qualifier] RAG: gate=false (${gate.reasoning ?? "skip"}) — busca evitada`);
    }
  }

  // Mídias disponíveis (para a tool enviar_midia)
  const mediaContext = await getAvailableMediaForPrompt(ctx.agentId);

  const cached = buildCachedSystemPrompt(ctx);
  const baseDynamic = buildDynamicSystemPrompt(ctx, candidateTags);
  const extras = [ragContext, mediaContext].filter(Boolean).join("\n\n");
  const dynamic = extras ? baseDynamic + "\n\n" + extras : baseDynamic;
  const history: LlmMessage[] = ctx.history.map((m) => ({ role: m.role, content: m.content }));

  let workingMessages: LlmMessage[] = [...history];
  const toolsCalled: string[] = [];
  let accumulatedPatch: Partial<LeadData> = mergeLeadDataPatch(
    { initial_tag_applied: initialTagApplied } as LeadData,
    backfillPatch,
  );
  let totalTokensIn = gateCost.tokensIn;
  let totalTokensOut = gateCost.tokensOut;
  let totalCostUsd = gateCost.costUsd;

  // Etiquetagem de TURMA determinística (turma_auto): assim que houver data de
  // nascimento válida, o CÓDIGO aplica a tag da turma certa (mantendo N/A). O
  // LLM nem tem a tool de tag nesses agentes — acaba a "etiqueta no chute".
  if (agentUsesTurmaClassifier(ctx.agentSettings)) {
    const turmaApplied = await applyTurmaTagDeterministic(ctx);
    if (turmaApplied) {
      accumulatedPatch = mergeLeadDataPatch(accumulatedPatch as LeadData, {
        interest: turmaApplied,
      });
      ctx.leadData = mergeLeadDataPatch(ctx.leadData, { interest: turmaApplied });
    }
  } else if (ctx.leadData.custom_fields?.child_birth_date) {
    // Hint de diagnóstico: já há data de nascimento mas a classificação de turma
    // está desligada — provavelmente falta a flag settings.turma_auto="true".
    console.log(
      `[qualifier] turma_auto DESLIGADO (settings.turma_auto=${JSON.stringify((ctx.agentSettings as Record<string, unknown>).turma_auto)}) — defina "true" p/ etiquetar turma automaticamente conv=${ctx.conversationId}`,
    );
  }

  // No 1º ciclo, tools são proibidas — EXCETO quando a M1 já carrega interesse
  // explícito ("quero saber sobre tráfego pago", "tô com dor no dente").
  // Nesses casos, faz sentido aplicar a tag de interesse JÁ no 1º turno.
  const cycleCount = ctx.history.filter((m) => m.role === "user").length;
  const firstUserMsg = ctx.history.find((m) => m.role === "user")?.content ?? "";
  const m1Lower = firstUserMsg.trim().toLowerCase();
  const isGreetingOnly = /^(oi|ola|olá|bom dia|boa tarde|boa noite|hey|opa|e aí|eai|tudo bem\??)[!.\s]*$/i.test(m1Lower);
  const hasIntentWords = /\b(quero|gostaria|preciso|to com|tô com|estou com|sobre|interesse|informaç|matric|preço|valor|horário|horario|orçament|orcament|consulta|atend|servic|servi[çc]o|curso|aula)\b/i.test(m1Lower);
  const hasExplicitInterestInM1 =
    !!ctx.helenaContact?.utm?.content ||
    (m1Lower.length >= 20 && !isGreetingOnly && hasIntentWords);
  // Pergunta de preço logo na M1 ("quanto custa o botox?") não bate em
  // hasIntentWords ("custa" não está na lista) nem no piso de 20 caracteres —
  // e ficaria sem consultar a planilha justo no turno em que o lead perguntou.
  // Só vale para conta COM planilha: sem ela, não há o que consultar e a trava
  // do 1º ciclo continua valendo inteira.
  const priceQuestionInM1 =
    ctx.integrations.googleSheets &&
    /pre[çc]o|valor(es)?|quanto\s+(custa|fica|sai)|custa\s+quanto|or[çc]amento|tabela/i.test(m1Lower);
  const allowTools = cycleCount > 1 || hasExplicitInterestInM1 || priceQuestionInM1;

  for (let loop = 0; loop < MAX_TOOL_LOOPS && allowTools; loop++) {
    const turn = await callLlmWithFallback(ctx.orKey, {
      model: ctx.qualifierModel,
      systemCached: cached,
      systemDynamic: dynamic,
      messages: workingMessages,
      tools: buildQualifierTools(ctx),
      toolChoice: "auto",
      maxTokens: ctx.maxTokens,
      temperature: ctx.temperature,
      modelTemperatures: ctx.modelTemperatures,
      enableCaching: ctx.qualifierModel.startsWith("anthropic/"),
    }, ctx.qualifierFallbackModels);

    totalTokensIn += turn.tokensIn;
    totalTokensOut += turn.tokensOut;
    totalCostUsd += turn.costUsd;

    if (turn.toolCalls.length === 0) break;

    workingMessages.push({
      role: "assistant",
      content: turn.content,
      tool_calls: turn.toolCalls,
    });

    for (const tc of turn.toolCalls) {
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(tc.function.arguments) as Record<string, unknown>;
      } catch {
        args = {};
      }

      let outcome: ToolOutcome = { result: JSON.stringify({ error: "tool desconhecida" }) };
      if (tc.function.name === "aplicar_tag_interesse" && typeof args.tag === "string") {
        outcome = await execAplicarTagInteresse(ctx, args.tag, "qualifier");
      } else if (tc.function.name === "listar_horarios") {
        // Reusa o MESMO executor do scheduler — nada de segunda implementação
        // de busca de horário (filtro de turno, prioridade por hora pedida,
        // auto-ampliação da janela e checagem de expediente vivem lá dentro).
        try {
          outcome = await execListarHorarios(
            ctx,
            undefined,
            undefined,
            typeof args.data_alvo === "string" ? args.data_alvo : undefined,
            typeof args.periodo === "string" ? args.periodo : undefined,
          );
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          outcome = { result: JSON.stringify({ count: 0, slots: [], error: msg.slice(0, 200) }) };
        }
      } else if (tc.function.name === "consultar_planilha") {
        outcome = { result: await execConsultarPlanilha(ctx, args) };
      } else if (tc.function.name === "enviar_midia" && typeof args.slug === "string") {
        const res = await sendMediaBySlug(
          ctx,
          args.slug,
          typeof args.caption === "string" ? args.caption : undefined,
        );
        outcome = {
          result: JSON.stringify(
            res.ok
              ? { ok: true, media_title: res.media_title }
              : { ok: false, error: res.error },
          ),
        };
      }

      toolsCalled.push(tc.function.name);
      if (outcome.patch) {
        accumulatedPatch = { ...accumulatedPatch, ...outcome.patch };
        ctx.leadData = { ...ctx.leadData, ...outcome.patch };
      }
      console.log(`[qualifier] tool ${tc.function.name} → ${outcome.result.slice(0, 200)}`);

      workingMessages.push({
        role: "tool",
        tool_call_id: tc.id,
        content: outcome.result,
      });
    }
  }

  // Resposta final estruturada (sem tools) — com fallback.
  const { result, response: finalResponse } = await callLlmStructuredWithFallback<QualifierJsonResult>(
    ctx.orKey,
    {
      model: ctx.qualifierModel,
      systemCached: cached,
      systemDynamic: dynamic,
      messages:
        workingMessages.length === history.length
          ? // não houve tools — chama direto pedindo JSON
            [...history]
          : [
              ...workingMessages,
              {
                role: "user",
                content:
                  "Gere agora a resposta final em JSON conforme o schema instruído.",
              },
            ],
      maxTokens: ctx.maxTokens,
      temperature: ctx.temperature,
      modelTemperatures: ctx.modelTemperatures,
      enableCaching: ctx.qualifierModel.startsWith("anthropic/"),
      toolChoice: "none",
    },
    (raw) => ResultSchema.parse(sanitizeStructuredAgentJson(raw)),
    ctx.qualifierFallbackModels,
  );

  totalTokensIn += finalResponse.tokensIn;
  totalTokensOut += finalResponse.tokensOut;
  totalCostUsd += finalResponse.costUsd;

  // Com turma_auto, "interest" é EXCLUSIVO do classificador determinístico
  // (applyTurmaTagDeterministic, já mesclado em accumulatedPatch acima) —
  // nunca do texto livre do LLM. Sem este filtro, o LLM sobrescreve o valor
  // canônico ("YEAR 2") com a própria paráfrase ("2 ano do fundamental") a
  // cada turno: a tag real no CRM continua certa (é aplicada direto na API),
  // mas lead_data.interest fica errado — contaminando os templates de
  // notificação/{{interest}} e o sync de "interesse mudou" do Leads360, além
  // de fazer o guard de idempotência (interest === turma calculada) falhar e
  // reaplicar a tag toda hora. Caso real (Maple Bear Osasco, 09/07).
  const llmPatch = stripNullishFields(
    (result.lead_data_patch ?? {}) as Record<string, unknown>,
  );
  if (agentUsesTurmaClassifier(ctx.agentSettings)) {
    delete llmPatch.interest;
  }
  const mergedPatch = {
    ...accumulatedPatch,
    ...llmPatch,
  } as Partial<LeadData>;

  // Fallback: se LLM nao retornou next_stage, mantem o stage atual da conversa.
  const finalStage: Stage = (result.next_stage as Stage | undefined) ?? ctx.stage;

  // ── Trava anti-horário-inventado ───────────────────────────────────────────
  // Sem offered_slots o qualifier não tem agenda nenhuma: qualquer "segunda às
  // 14h" é inventado (pode cair em dia bloqueado). Caso real: Costa Lima Recreio
  // 18/07, "segunda-feira às 14h ou terça-feira às 10h" com a segunda bloqueada.
  //
  // COM offered_slots a checagem continua valendo — e é aqui que ela roda agora.
  // Antes o guard era pulado assim que houvesse slots, mas a chamada de
  // listar_horarios do PRÓPRIO turn já preenche offered_slots (ctx.leadData é
  // atualizado no loop de tools acima), então o cenário mais comum ficava
  // descoberto: o agente consulta a agenda e mesmo assim desloca o horário para
  // o que o lead pediu. Caso real (04/08/2026, Implanto Master Venda Nova,
  // Sérgio 31 98727-1682): agenda devolveu 08:00 e 08:30, lead tinha pedido
  // "as 9:00 horas", o agente ofertou "amanhã às 9h ou às 9h30".
  let finalReply = result.reply;
  let inventedOfferScrubbed = false;
  const scrub = scrubInventedTimeOffers(finalReply, ctx.leadData.offered_slots);
  if (scrub.scrubbed) {
    finalReply = scrub.reply;
    inventedOfferScrubbed = true;
    console.warn(
      `[qualifier] oferta de horário fora da agenda removida conv=${ctx.conversationId} stage=${ctx.stage}->${finalStage} (offered_slots=${ctx.leadData.offered_slots?.length ?? 0})`,
    );
  }

  return {
    reply: finalReply,
    next_stage: finalStage,
    lead_data_patch: mergedPatch,
    reasoning: result.reasoning,
    tools_called: toolsCalled,
    tokens_in: totalTokensIn,
    tokens_out: totalTokensOut,
    cost_usd: totalCostUsd,
    telemetry: inventedOfferScrubbed ? { invented_time_offer_scrubbed: true } : undefined,
  };
}
