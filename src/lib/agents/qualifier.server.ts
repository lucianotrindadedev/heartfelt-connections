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

const ResultSchema = z.object({
  reply: z.string().min(1),
  next_stage: z.enum(VALID_STAGES),
  lead_data_patch: z
    .object({
      name: z.string().nullish(),
      interest: z.string().nullish(),
      notes: z.string().nullish(),
      escalation_reason: z.string().nullish(),
    })
    .optional(),
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

interface ToolOutcome {
  result: string;
  patch?: Partial<LeadData>;
}

async function execAplicarTag(
  ctx: AgentContext,
  tag: string,
): Promise<ToolOutcome> {
  if (ctx.dryRun) {
    return { result: JSON.stringify({ ok: true, tag, dry_run: true }) };
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
  if (ctx.dryRun) return;
  if (!ctx.helenaContact?.id) return;
  if (ctx.leadData.initial_tag_applied) return; // idempotente
  try {
    const helena = await loadHelenaAccount(ctx.accountId);
    const res = await applyOneOfTags(
      helena,
      ctx.helenaContact.id,
      NOT_SCHEDULED_SYNONYMS,
      "InsertIfNotExists",
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

function buildCachedSystemPrompt(ctx: AgentContext): string {
  const s = ctx.agentSettings;
  return `Você é ${s.assistant_name || "a assistente"}, ${s.assistant_role || "secretária"} da clínica ${s.company_name || "(nome da clínica)"}.

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
7. Se o lead pedir explicitamente humano, atendente, "falar com a doutora", reclamação delicada → next_stage="ESCALATED" + lead_data_patch.escalation_reason
8. Tags de interesse:
   • Se a M1 do lead JÁ contém interesse claro (caso B do RECEPTION) → APLIQUE a tag de interesse JÁ no 1º ciclo.
   • Se a M1 é vaga ("Oi", "Tudo bem?") → não aplique tag ainda; aguarde o 2º ciclo, quando o interesse ficar claro.
9. **NÃO repita pedaços do prompt em sequência sem evolução.** Se o lead respondeu "sim", "ok", "uhum", "blz" — avance: faça a próxima pergunta SPIN ou ofereça horário. NUNCA fique repetindo o mesmo discurso de valor.
10. **Após 3-4 ciclos com interesse claro e lead responsivo, transite para SLOT_OFFER.** Não fique infinitamente em QUALIFICATION.

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

${ctx.basePrompt ? `\n# INSTRUÇÕES ADICIONAIS DO PROPRIETÁRIO\n\n${ctx.basePrompt}` : ""}

# FORMATO DE SAÍDA OBRIGATÓRIO

Responda APENAS em JSON válido:
{
  "reply": "mensagem curta a enviar ao paciente",
  "next_stage": "RECEPTION" | "QUALIFICATION" | "SLOT_OFFER" | "ESCALATED",
  "lead_data_patch": {
    "interest": "IMPLANTE | FACETAS | PROTESE | CLAREAMENTO | ORTODONTIA | OUTRO",
    "name": "nome se já mencionado",
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

  return `# ESTADO ATUAL

- Agora (BRT): ${dateStr}
- Stage corrente: ${ctx.stage}
- Ciclos de conversa já completos: ${cycleCount}
- Canal: ${ctx.channel}
${utm?.content ? `- UTM Content (interesse PRIMÁRIO): "${utm.content}"` : "- UTM Content: (vazio — identifique pelo histórico)"}
${utm?.source ? `- UTM Source: ${utm.source}` : ""}
${utm?.medium ? `- UTM Medium: ${utm.medium}` : ""}
${tags.length > 0 ? `- Tags atuais no CRM neste contato: ${tags.join(", ")}` : "- Sem tags ainda neste contato"}

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
- Se nenhuma tag bate com o interesse identificado, NÃO invente — deixe sem
  tag de interesse (melhor sem tag do que com a tag errada).
- A tag de status inicial ("N/A Não Agendado" ou equivalente) já é aplicada
  automaticamente — você não precisa pedir.
- A tag "Agendado" é aplicada automaticamente quando o agendamento conclui
  — você também não precisa pedir.

# LEAD_DATA JÁ COLETADO

${JSON.stringify(
  {
    name: ld.name ?? null,
    interest: ld.interest ?? null,
    notes: ld.notes ?? null,
  },
  null,
  2,
)}

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
  let accumulatedPatch: Partial<LeadData> = { initial_tag_applied: initialTagApplied };
  let totalTokensIn = 0;
  let totalTokensOut = 0;
  let totalCostUsd = 0;

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
      model: ctx.model,
      systemCached: cached,
      systemDynamic: dynamic,
      messages: workingMessages,
      tools: QUALIFIER_TOOLS,
      toolChoice: "auto",
      maxTokens: ctx.maxTokens,
      temperature: ctx.temperature,
      enableCaching: ctx.model.startsWith("anthropic/"),
    }, ctx.fallbackModels);

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
      model: ctx.model,
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
      enableCaching: ctx.model.startsWith("anthropic/"),
      toolChoice: "none",
    },
    (raw) => ResultSchema.parse(sanitizeStructuredAgentJson(raw)),
    ctx.fallbackModels,
  );

  totalTokensIn += finalResponse.tokensIn;
  totalTokensOut += finalResponse.tokensOut;
  totalCostUsd += finalResponse.costUsd;

  const mergedPatch = {
    ...accumulatedPatch,
    ...stripNullishFields((result.lead_data_patch ?? {}) as Record<string, unknown>),
  } as Partial<LeadData>;

  return {
    reply: result.reply,
    next_stage: result.next_stage as Stage,
    lead_data_patch: mergedPatch,
    reasoning: result.reasoning,
    tools_called: toolsCalled,
    tokens_in: totalTokensIn,
    tokens_out: totalTokensOut,
    cost_usd: totalCostUsd,
  };
}
