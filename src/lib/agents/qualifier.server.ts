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
import { callLlm, callLlmStructured, type LlmMessage, type LlmTool } from "./llm.server";
import { sanitizeStructuredAgentJson, stripNullishFields } from "./parse-llm-json.server";
import type { LeadData, Stage } from "./stage";
import { loadHelenaAccount, setHelenaContactTags } from "@/lib/helena.server";

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
];

interface ToolOutcome {
  result: string;
  patch?: Partial<LeadData>;
}

async function execAplicarTag(
  ctx: AgentContext,
  tag: string,
): Promise<ToolOutcome> {
  if (!ctx.helenaContact?.id) {
    return { result: JSON.stringify({ ok: false, error: "no_contact_id" }) };
  }
  try {
    const helena = await loadHelenaAccount(ctx.accountId);
    const res = await setHelenaContactTags(
      helena,
      ctx.helenaContact.id,
      [tag],
      "InsertIfNotExists",
    );
    if (!res.ok) {
      return { result: JSON.stringify({ ok: false, status: res.status }) };
    }
    return { result: JSON.stringify({ ok: true, tag }) };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { result: JSON.stringify({ ok: false, error: msg.slice(0, 200) }) };
  }
}

// ── Prompts ────────────────────────────────────────────────────────────────

function buildCachedSystemPrompt(ctx: AgentContext): string {
  const s = ctx.agentSettings;
  return `Você é ${s.assistant_name || "a assistente"}, ${s.assistant_role || "secretária"} da clínica ${s.company_name || "(nome da clínica)"}.

Você está no MÓDULO DE QUALIFICAÇÃO. Seu objetivo é entender o que o lead precisa, criar conexão humana e — somente quando o interesse estiver claro — sinalizar que o agendamento pode começar.

# ESTÁGIOS QUE VOCÊ OPERA

- **RECEPTION**: primeira mensagem do lead. Cumprimente, identifique-se e pergunte como pode ajudar. Se UTM Content já indicar o interesse, demonstre que sabe (sem mencionar UTM/sistemas).
- **QUALIFICATION**: faça perguntas SPIN para entender:
  • Situação atual (há quanto tempo está com a queixa, contexto)
  • Problema específico (dor, estética, função)
  • Impacto (como afeta o dia a dia, autoestima)
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
8. Tags de interesse SÓ no 2º ciclo em diante. No 1º ciclo (uma mensagem inbound apenas), JAMAIS chame aplicar_tag_interesse.
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

function buildDynamicSystemPrompt(ctx: AgentContext): string {
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

  return `# ESTADO ATUAL

- Agora (BRT): ${dateStr}
- Stage corrente: ${ctx.stage}
- Ciclos de conversa já completos: ${cycleCount}
- Canal: ${ctx.channel}
${utm?.content ? `- UTM Content (interesse PRIMÁRIO): "${utm.content}"` : "- UTM Content: (vazio — identifique pelo histórico)"}
${utm?.source ? `- UTM Source: ${utm.source}` : ""}
${utm?.medium ? `- UTM Medium: ${utm.medium}` : ""}
${tags.length > 0 ? `- Tags atuais no CRM: ${tags.join(", ")}` : "- Sem tags ainda"}

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

${cycleCount <= 1 ? "**1º CICLO** — proibido chamar tools. Só saudação + 1 pergunta de descoberta." : "Pode usar aplicar_tag_interesse se o interesse estiver identificado com segurança."}

${cycleCount >= 4 && ld.interest ? `**ALERTA**: já são ${cycleCount} ciclos com interest=${ld.interest} identificado. Avance: faça a oferta de horário transitando para next_stage="SLOT_OFFER". O scheduler assume a partir daí.` : ""}

# LEMBRETE DE FECHAMENTO

Toda mensagem precisa terminar com uma PERGUNTA que mantenha o lead engajado e o conduza ao próximo passo do agendamento. Exemplos válidos: "Posso te oferecer um horário ainda essa semana?", "Quer que eu já te mostre uns horários disponíveis?", "Você prefere consulta pela manhã ou à tarde?". NUNCA termine com afirmação solta tipo "Será um investimento por nossa conta." — sempre puxe para a próxima ação.`;
}

// ── Runner ────────────────────────────────────────────────────────────────

const MAX_TOOL_LOOPS = 3; // qualifier raramente precisa de mais de 1 tool

export async function runQualifierAgent(ctx: AgentContext): Promise<AgentResult> {
  const cached = buildCachedSystemPrompt(ctx);
  const dynamic = buildDynamicSystemPrompt(ctx);
  const history: LlmMessage[] = ctx.history.map((m) => ({ role: m.role, content: m.content }));

  let workingMessages: LlmMessage[] = [...history];
  const toolsCalled: string[] = [];
  let accumulatedPatch: Partial<LeadData> = {};
  let totalTokensIn = 0;
  let totalTokensOut = 0;
  let totalCostUsd = 0;

  // No 1º ciclo, força tool_choice=none (sem tools).
  const cycleCount = ctx.history.filter((m) => m.role === "user").length;
  const allowTools = cycleCount > 1;

  for (let loop = 0; loop < MAX_TOOL_LOOPS && allowTools; loop++) {
    const turn = await callLlm(ctx.orKey, {
      model: ctx.model,
      systemCached: cached,
      systemDynamic: dynamic,
      messages: workingMessages,
      tools: QUALIFIER_TOOLS,
      toolChoice: "auto",
      maxTokens: ctx.maxTokens,
      temperature: ctx.temperature,
      enableCaching: ctx.model.startsWith("anthropic/"),
    });

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

  // Resposta final estruturada (sem tools).
  const { result, response: finalResponse } = await callLlmStructured<QualifierJsonResult>(
    ctx.orKey,
    {
      model: ctx.model,
      systemCached: cached,
      systemDynamic: buildDynamicSystemPrompt(ctx),
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
