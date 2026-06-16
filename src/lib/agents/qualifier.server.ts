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
import { buildOwnerStylePromptBlock } from "./owner-style-prompt.server";
import {
  agentUsesTurmaClassifier,
  backfillBookingFieldsFromHistory,
  buildChannelPhonePromptBlock,
  mergeLeadDataPatch,
  tagGateMissingField,
  turmaTagForLead,
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
      custom_fields: coercibleStringRecord.nullish(),
    })
    // .nullish(): alguns modelos devolvem lead_data_patch:null em vez de omitir.
    .nullish(),
  reasoning: z.string().optional(),
});

type QualifierJsonResult = z.infer<typeof ResultSchema>;

// ── Tools do qualifier (apenas helena_tags) ────────────────────────────────

const QUALIFIER_TOOLS: LlmTool[] = [
  {
    type: "function",
    function: {
      name: "aplicar_tag_interesse",
      description:
        "Aplica UMA tag de qualificação ao contato no Helena, refletindo o interesse identificado. " +
        "Use APENAS quando o interesse estiver claramente identificado E não estivermos no 1º ciclo. " +
        "Use apenas tags relacionadas a interesse/qualificação (ex: 'INTERESSE EM IMPLANTE'). " +
        "NUNCA use tags operacionais como 'IA Agendou' ou 'N/A Não Agendado'.",
      parameters: {
        type: "object",
        properties: {
          tag: {
            type: "string",
            description: "Nome exato da tag a aplicar (ex.: 'INTERESSE EM PRÓTESE PROTOCOLO').",
          },
        },
        required: ["tag"],
      },
    },
  },
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

/** Ferramentas do qualifier para este agente. Em agentes com classificação
 *  determinística de turma (turma_auto), removemos aplicar_tag_interesse — a
 *  tag de turma é aplicada pelo código, nunca pelo LLM (evita etiqueta no chute
 *  ou turma errada). Os demais agentes seguem com a tool normal. */
function buildQualifierTools(ctx: AgentContext): LlmTool[] {
  if (agentUsesTurmaClassifier(ctx.agentSettings)) {
    return QUALIFIER_TOOLS.filter(
      (t) => t.function.name !== "aplicar_tag_interesse",
    );
  }
  return QUALIFIER_TOOLS;
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
  const turma = turmaTagForLead(ctx.agentSettings, ctx.leadData);
  if (!turma) return null;
  if (ctx.leadData.interest === turma) return null; // já aplicada neste lead

  if (ctx.dryRun || ctx.disableTags) {
    console.log(
      `[qualifier] turma determinística '${turma}' (pulada: ${ctx.disableTags ? "test_mode" : "dry_run"})`,
    );
    return turma; // grava interest mesmo assim (sem tocar o CRM em teste)
  }
  if (!ctx.helenaContact?.id) return turma;

  try {
    const helena = await loadHelenaAccount(ctx.accountId);
    const res = await applyTagByApproxName(
      helena,
      ctx.helenaContact.id,
      turma,
      "InsertIfNotExists",
      { currentTags: ctx.helenaContact.tagNames },
    );
    if (res.ok) {
      console.log(`[qualifier] turma determinística aplicada: ${res.tag}`);
    } else {
      console.warn(
        `[qualifier] turma '${turma}' não encontrada no CRM (${res.reason}) — crie a tag com esse nome`,
      );
    }
  } catch (e) {
    console.warn("[qualifier] erro ao aplicar tag de turma:", e);
  }
  return turma;
}

async function execAplicarTag(
  ctx: AgentContext,
  tag: string,
): Promise<ToolOutcome> {
  // Trava: não etiquetar antes de ter o dado que define a tag (ex.: data de
  // nascimento → turma). Roda ANTES do test_mode para o LLM receber o feedback
  // certo ("colete o dado") mesmo durante testes.
  const missingField = tagGateMissing(ctx);
  if (missingField) {
    console.log(
      `[qualifier] aplicar_tag bloqueada — falta '${missingField}' (tag_gate_field) tag pedida='${tag}'`,
    );
    return {
      result: JSON.stringify({
        ok: false,
        reason: "missing_required_data",
        required_field: missingField,
        note: `Não aplique nenhuma tag de interesse antes de coletar '${missingField}'. Pergunte esse dado ao lead primeiro.`,
      }),
    };
  }

  if (ctx.dryRun || ctx.disableTags) {
    return {
      result: JSON.stringify({
        ok: true,
        tag,
        skipped: ctx.disableTags ? "test_mode" : "dry_run",
      }),
    };
  }
  if (!ctx.helenaContact?.id) {
    return { result: JSON.stringify({ ok: false, error: "no_contact_id" }) };
  }
  try {
    const helena = await loadHelenaAccount(ctx.accountId);
    // Resolve o nome aproximado para o nome EXATO já existente no CRM.
    // Não cria tags novas — se não achar, retorna erro para o LLM tentar outra.
    const result = await applyTagByApproxName(
      helena,
      ctx.helenaContact.id,
      tag,
      "InsertIfNotExists",
      { currentTags: ctx.helenaContact.tagNames },
    );
    if (!result.ok) {
      return {
        result: JSON.stringify({
          ok: false,
          reason: result.reason ?? "unknown",
          requested: tag,
        }),
      };
    }
    return { result: JSON.stringify({ ok: true, tag: result.tag }) };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { result: JSON.stringify({ ok: false, error: msg.slice(0, 200) }) };
  }
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
const QUALIFIER_TECHNICAL_SCAFFOLD = `# ⚙️ REGRAS TÉCNICAS DO SISTEMA (não exibir ao lead)

Você opera no MÓDULO DE QUALIFICAÇÃO (estágios RECEPTION e QUALIFICATION).
Você NÃO agenda — quando o interesse estiver claro e o lead demonstrar
disposição de avançar, sinalize next_stage="SLOT_OFFER" e o módulo de
agendamento assume a partir daí.

Você NÃO tem acesso à agenda/calendário. NUNCA diga "vou verificar",
"deixa eu dar uma olhadinha", "já te retorno" — você não consegue cumprir
e a conversa morre. Se o lead perguntar disponibilidade de data/horário,
use next_stage="SLOT_OFFER" e responda confirmando o interesse com uma
pergunta (ex: "Essa data é para qual tipo de evento?").

Ferramentas disponíveis (chame quando fizer sentido no fluxo):
- aplicar_tag_interesse: registra o interesse do lead no CRM. Não use no 1º
  ciclo, exceto se a primeira mensagem já trouxer interesse explícito.
- enviar_midia: envia uma mídia cadastrada (ver seção "MÍDIAS DISPONÍVEIS").

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
    "escalation_reason": "se next_stage=ESCALATED"
  },
  "reasoning": "1 frase do raciocínio"
}`;

function buildCachedSystemPrompt(ctx: AgentContext): string {
  const s = ctx.agentSettings;

  // O prompt do proprietário DOMINA quando presente: vai no topo como
  // comportamento principal, seguido apenas do scaffold técnico necessário.
  // O template padrão abaixo é só a "semente" — usada quando ainda não há
  // prompt configurado.
  if (ctx.basePrompt && ctx.basePrompt.trim()) {
    return `${ctx.basePrompt.trim()}

${buildOwnerStylePromptBlock()}

${QUALIFIER_TECHNICAL_SCAFFOLD}`;
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
6. NUNCA tente agendar você mesma — só sinalize next_stage="SLOT_OFFER" quando:
   • O interesse principal estiver identificado com clareza
   • O lead manifestar disposição (explícita ou implícita) de avançar
   • OU o lead perguntar disponibilidade de data/horário ("tem data livre dia 25/07?") — nesse caso sinalize SLOT_OFFER IMEDIATAMENTE. Você NÃO tem acesso à agenda: NUNCA diga "vou verificar", "deixa eu olhar", "já te retorno".
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
    "escalation_reason": "se next_stage=ESCALATED"
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
  const turmaCalc = turmaAuto ? turmaTagForLead(ctx.agentSettings, ctx.leadData) : null;
  const turmaBlock = !turmaAuto
    ? ""
    : turmaCalc
      ? `\n\n# TURMA — CÁLCULO OFICIAL DO SISTEMA\nA turma correta para a data de nascimento informada é **${turmaCalc}**. Ao falar com o lead, use EXATAMENTE "${turmaCalc}" — NÃO recalcule e NÃO diga outra turma. A etiqueta da turma já é aplicada automaticamente; você NÃO deve etiquetar.`
      : `\n\n# TURMA\nAinda não há data de nascimento válida. NÃO afirme nenhuma turma ao lead enquanto não tiver a data. Quando a data chegar, o sistema calcula e etiqueta a turma automaticamente.`;

  // Bloco de ESTADO + tags = DADOS, não comportamento. Sempre presente.
  const stateBlock = `# ESTADO ATUAL

- Agora (BRT): ${dateStr}
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
)}`;

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
    candidateTags = await getInterestCandidateTagNames(helena);
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
  if (lastUserMsg) {
    const gate = await decideRagNeed(ctx.orKey, ctx.ragGateModel, ctx.history, lastUserMsg);
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
  let totalTokensIn = 0;
  let totalTokensOut = 0;
  let totalCostUsd = 0;

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
  const allowTools = cycleCount > 1 || hasExplicitInterestInM1;

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
        outcome = await execAplicarTag(ctx, args.tag);
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
      enableCaching: ctx.qualifierModel.startsWith("anthropic/"),
      toolChoice: "none",
    },
    (raw) => ResultSchema.parse(sanitizeStructuredAgentJson(raw)),
    ctx.qualifierFallbackModels,
  );

  totalTokensIn += finalResponse.tokensIn;
  totalTokensOut += finalResponse.tokensOut;
  totalCostUsd += finalResponse.costUsd;

  const mergedPatch = {
    ...accumulatedPatch,
    ...stripNullishFields((result.lead_data_patch ?? {}) as Record<string, unknown>),
  } as Partial<LeadData>;

  // Fallback: se LLM nao retornou next_stage, mantem o stage atual da conversa.
  const finalStage: Stage = (result.next_stage as Stage | undefined) ?? ctx.stage;

  return {
    reply: result.reply,
    next_stage: finalStage,
    lead_data_patch: mergedPatch,
    reasoning: result.reasoning,
    tools_called: toolsCalled,
    tokens_in: totalTokensIn,
    tokens_out: totalTokensOut,
    cost_usd: totalCostUsd,
  };
}
