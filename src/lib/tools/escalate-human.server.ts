// Escalada para atendimento humano:
// 1. Tag "IA Desligada" no contato Helena
// 2. Alerta no grupo Evolution API configurado, ENRIQUECIDO com:
//    - identificação do lead (nome, telefone, interesse)
//    - estágio em que estava + motivo bruto do qualifier
//    - resumo IA da situação (contexto, sentimento, urgência, sugestão)
//    - última mensagem do lead (literal entre aspas)
//    - dados coletados (custom_fields, notes)
//
// Fonte das credenciais Evolution:
//  - URL + API key: GLOBAIS do SAAS (system_evolution_config)
//  - Instancia + grupo: POR AGENTE (agent_escalation.evolution_instance / grupo_alerta)
//  - Toggle ativo: POR AGENTE (agent_escalation.ativo)
import { getSelfhost } from "@/integrations/selfhost/client.server";
import {
  EvolutionApiError,
  EvolutionConfigMissingError,
  sendText as evoSendText,
} from "@/lib/evolution.server";
import { loadHelenaAccount, setHelenaContactTags } from "@/lib/helena.server";
import type { LeadData, Stage } from "@/lib/agents/stage";

const AI_DISABLED_TAG = "IA Desligada";
const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

interface EnrichedContext {
  /** Resumo 2-4 frases: situação, expectativa do lead, o que tentamos. */
  contexto: string;
  /** Tom emocional dominante (ex.: "frustrado", "ansioso", "neutro"). */
  sentimento: string;
  /** Nível de urgência: "alta" | "media" | "baixa". */
  urgencia: "alta" | "media" | "baixa";
  /** 1 frase: o que o atendente deve fazer primeiro. */
  sugestao: string;
}

export async function escalateToHuman(params: {
  agentId: string;
  accountId: string;
  phone: string;
  sessionId?: string;
  helenaContactId?: string;
  /** Motivo bruto vindo do qualifier (lead_data.escalation_reason). */
  reason?: string;
  /** Nome amigável do agente (agents.nome). */
  agentName?: string;
  /** Estágio em que a conversa estava antes do ESCALATED. */
  stage?: Stage;
  /** Lead data completo no momento da escalada. */
  leadData?: LeadData;
  /** Histórico recente (mesmo formato do orquestrador). */
  history?: { role: "user" | "assistant"; content: string }[];
  /** OpenRouter API key (para gerar resumo IA). Sem ela, pula o resumo. */
  orKey?: string;
  /** Modelo barato para o resumo (ex.: ragGateModel). */
  summaryModel?: string;
}): Promise<{ tagged: boolean; alerted: boolean }> {
  const sb = getSelfhost();

  const { data: cfg } = await sb
    .from("agent_escalation")
    .select("grupo_alerta, evolution_instance, ativo")
    .eq("agent_id", params.agentId)
    .single();

  let tagged = false;
  let alerted = false;

  // 1. Tag "IA Desligada" no contato Helena — usa a MESMA API dos comandos
  //    pausar/ativar (setHelenaContactTags). O fetch cru anterior usava um
  //    endpoint/payload diferente e falhava silenciosamente, então a escalada
  //    desligava a IA internamente mas nada aparecia no CRM. Com a tag visível,
  //    o atendente vê que foi escalado e, ao REMOVER a tag, a IA volta sozinha
  //    (o webhook checa as tags do contato a cada mensagem recebida).
  if (params.helenaContactId) {
    try {
      const helena = await loadHelenaAccount(params.accountId);
      const res = await setHelenaContactTags(
        helena,
        params.helenaContactId,
        [AI_DISABLED_TAG],
        "InsertIfNotExists",
      );
      tagged = res.ok;
      if (!res.ok) {
        console.error(
          `[escalate] tag "${AI_DISABLED_TAG}" falhou: ${res.status} ${res.body?.slice(0, 200)}`,
        );
      } else {
        console.log(
          `[escalate] tag "${AI_DISABLED_TAG}" aplicada — contact ${params.helenaContactId}`,
        );
      }
    } catch (e) {
      console.error("[escalate] falha ao taguear no Helena:", e);
    }
  } else {
    console.warn(
      "[escalate] sem helenaContactId — tag IA Desligada NÃO aplicada (IA não será pausada no CRM)",
    );
  }

  // 2. Alerta no grupo Evolution API (apenas se o agente tem instancia+grupo configurados)
  if (cfg?.ativo && cfg.grupo_alerta && cfg.evolution_instance) {
    try {
      // Resumo IA — best-effort, segue sem se falhar
      let enriched: EnrichedContext | null = null;
      if (params.orKey && params.summaryModel && params.history?.length) {
        enriched = await summarizeEscalationContext({
          orKey: params.orKey,
          model: params.summaryModel,
          history: params.history,
          leadData: params.leadData,
          reason: params.reason,
          stage: params.stage,
        });
      }

      const alertText = buildEscalationMessage({
        phone: params.phone,
        reason: params.reason,
        agentName: params.agentName,
        stage: params.stage,
        leadData: params.leadData,
        history: params.history,
        enriched,
      });

      const res = await evoSendText({
        instance: cfg.evolution_instance as string,
        number: cfg.grupo_alerta as string,
        text: alertText,
      });
      alerted = res.ok;
      if (!res.ok) {
        console.error(
          `[escalate] Evolution sendText falhou ${res.status}: ${res.body.slice(0, 200)}`,
        );
      }
    } catch (e) {
      if (e instanceof EvolutionConfigMissingError) {
        console.warn(
          "[escalate] Evolution global nao configurada — alerta nao enviado",
        );
      } else if (e instanceof EvolutionApiError) {
        console.error(`[escalate] Evolution API error: ${e.message}`);
      } else {
        console.error("[escalate] falha ao enviar alerta Evolution:", e);
      }
    }
  }

  return { tagged, alerted };
}

// ─────────────────────────────────────────────────────────────────────────────
// Formatação da mensagem rica
// ─────────────────────────────────────────────────────────────────────────────

function formatPhoneDisplay(phone: string): string {
  const digits = (phone ?? "").replace(/\D/g, "");
  if (!digits) return phone;
  if (digits.startsWith("55") && digits.length >= 12) return `+${digits}`;
  if (digits.length === 10 || digits.length === 11) return `+55${digits}`;
  return `+${digits}`;
}

const URGENCY_EMOJI: Record<EnrichedContext["urgencia"], string> = {
  alta: "🔴",
  media: "🟡",
  baixa: "🟢",
};

const URGENCY_LABEL: Record<EnrichedContext["urgencia"], string> = {
  alta: "ALTA",
  media: "MÉDIA",
  baixa: "BAIXA",
};

const STAGE_LABEL: Record<Stage, string> = {
  RECEPTION: "Recepção (1ª msg)",
  QUALIFICATION: "Qualificação",
  SLOT_OFFER: "Oferta de horários",
  NAME_COLLECT: "Coleta de nome",
  BOOKING: "Agendando",
  CONFIRMED: "Pós-agendamento",
  ESCALATED: "Escalado",
};

function truncate(s: string, max: number): string {
  const t = (s ?? "").trim();
  if (t.length <= max) return t;
  return t.slice(0, max - 1).trimEnd() + "…";
}

function lastUserMessage(
  history?: { role: string; content: string }[],
): string | null {
  if (!history?.length) return null;
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i];
    if (m.role === "user" && m.content?.trim()) return m.content.trim();
  }
  return null;
}

function buildEscalationMessage(args: {
  phone: string;
  reason?: string;
  agentName?: string;
  stage?: Stage;
  leadData?: LeadData;
  history?: { role: "user" | "assistant"; content: string }[];
  enriched: EnrichedContext | null;
}): string {
  const lines: string[] = [];
  const title =
    args.enriched && args.enriched.urgencia === "alta"
      ? "🚨 *ESCALADA HUMANA — URGENTE*"
      : "🚨 *ESCALADA HUMANA*";
  lines.push(args.agentName ? `${title}  •  _${args.agentName}_` : title);
  lines.push("");

  // Bloco identificação
  const leadName = args.leadData?.name?.trim();
  lines.push(`👤 *Lead:* ${leadName || "(não identificado)"}`);
  lines.push(`📱 *Telefone:* ${formatPhoneDisplay(args.phone)}`);

  const idLine: string[] = [];
  if (args.leadData?.interest) idLine.push(`🎯 *Interesse:* ${args.leadData.interest}`);
  if (args.stage) idLine.push(`📍 *Estágio:* ${STAGE_LABEL[args.stage] ?? args.stage}`);
  if (idLine.length) lines.push(idLine.join("  •  "));

  if (args.enriched) {
    lines.push(
      `${URGENCY_EMOJI[args.enriched.urgencia]} *Urgência:* ${URGENCY_LABEL[args.enriched.urgencia]}  •  *Sentimento:* ${args.enriched.sentimento}`,
    );
  }

  // Motivo (bruto do qualifier)
  if (args.reason?.trim()) {
    lines.push("");
    lines.push(`📝 *Motivo:*`);
    lines.push(truncate(args.reason, 400));
  }

  // Contexto IA
  if (args.enriched?.contexto?.trim()) {
    lines.push("");
    lines.push(`🧠 *Contexto da conversa:*`);
    lines.push(truncate(args.enriched.contexto, 800));
  }

  // Última mensagem do lead
  const lastUser = lastUserMessage(args.history);
  if (lastUser) {
    lines.push("");
    lines.push(`💬 *Última mensagem do lead:*`);
    lines.push(`"${truncate(lastUser, 400)}"`);
  }

  // Dados coletados
  const dataBullets = formatLeadDataBullets(args.leadData);
  if (dataBullets.length) {
    lines.push("");
    lines.push(`📋 *Dados coletados:*`);
    for (const b of dataBullets) lines.push(`• ${b}`);
  }

  // Sugestão de ação
  if (args.enriched?.sugestao?.trim()) {
    lines.push("");
    lines.push(`💡 *Sugestão de ação:*`);
    lines.push(truncate(args.enriched.sugestao, 300));
  }

  lines.push("");
  lines.push(`_O atendimento foi transferido para humano._`);

  return lines.join("\n");
}

function formatLeadDataBullets(leadData?: LeadData): string[] {
  if (!leadData) return [];
  const out: string[] = [];

  if (leadData.notes?.trim()) {
    out.push(`Queixa/observação: ${truncate(leadData.notes, 200)}`);
  }

  if (leadData.selected_slot_iso) {
    try {
      const d = new Date(leadData.selected_slot_iso);
      if (!Number.isNaN(d.getTime())) {
        const tz = "America/Sao_Paulo";
        const date = new Intl.DateTimeFormat("pt-BR", {
          timeZone: tz,
          day: "2-digit",
          month: "2-digit",
          year: "numeric",
        }).format(d);
        const time = new Intl.DateTimeFormat("pt-BR", {
          timeZone: tz,
          hour: "2-digit",
          minute: "2-digit",
        }).format(d);
        out.push(`Horário escolhido: ${date} às ${time}`);
      }
    } catch {
      // ignora ISO inválido
    }
  }

  if (leadData.appointment_id) {
    out.push(`Agendamento existente: #${leadData.appointment_id}`);
  }

  if (leadData.custom_fields) {
    for (const [k, v] of Object.entries(leadData.custom_fields)) {
      if (!v?.toString().trim()) continue;
      const label = k.replace(/_/g, " ");
      out.push(`${label}: ${truncate(String(v), 120)}`);
    }
  }

  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Enriquecimento IA — gera contexto, sentimento, urgência e sugestão
// ─────────────────────────────────────────────────────────────────────────────

async function summarizeEscalationContext(args: {
  orKey: string;
  model: string;
  history: { role: "user" | "assistant"; content: string }[];
  leadData?: LeadData;
  reason?: string;
  stage?: Stage;
}): Promise<EnrichedContext | null> {
  const transcript = args.history
    .map((m) => `${m.role === "user" ? "Lead" : "Agente"}: ${m.content}`)
    .join("\n")
    .slice(-6000); // últimos ~6k chars (final da conversa é o que importa)

  if (!transcript.trim()) return null;

  const leadFacts: string[] = [];
  if (args.leadData?.name) leadFacts.push(`Nome: ${args.leadData.name}`);
  if (args.leadData?.interest) leadFacts.push(`Interesse: ${args.leadData.interest}`);
  if (args.leadData?.notes) leadFacts.push(`Notas: ${args.leadData.notes}`);
  if (args.leadData?.custom_fields) {
    for (const [k, v] of Object.entries(args.leadData.custom_fields)) {
      if (v) leadFacts.push(`${k}: ${v}`);
    }
  }
  if (args.stage) leadFacts.push(`Estágio: ${args.stage}`);
  if (args.reason) leadFacts.push(`Motivo (resumido pelo bot): ${args.reason}`);

  const system =
    "Você analisa conversas de atendimento que acabaram de ser transferidas " +
    "para um humano e produz um briefing curto para o atendente. Seja " +
    "objetivo, sem saudações, sem primeira pessoa, em português. Responda " +
    "APENAS um JSON válido (sem markdown, sem ```), exatamente nesta forma:\n" +
    `{
  "contexto": "2-4 frases descrevendo a situação atual, o que o lead quer, e o que já foi tentado",
  "sentimento": "uma palavra ou expressão curta (ex.: frustrado, ansioso, neutro, calmo, irritado)",
  "urgencia": "alta | media | baixa",
  "sugestao": "1 frase com o próximo passo recomendado ao atendente humano"
}`;

  const userPrompt =
    `Fatos do lead/conversa:\n${leadFacts.join("\n") || "(nenhum)"}\n\n` +
    `Transcrição (final da conversa):\n${transcript}`;

  try {
    const res = await fetch(OPENROUTER_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${args.orKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: args.model,
        messages: [
          { role: "system", content: system },
          { role: "user", content: userPrompt },
        ],
        temperature: 0.2,
        max_tokens: 400,
        response_format: { type: "json_object" },
      }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) {
      console.warn(`[escalate] resumo IA falhou ${res.status}`);
      return null;
    }
    const json = (await res.json()) as {
      choices?: { message?: { content?: string | null } }[];
    };
    const raw = (json.choices?.[0]?.message?.content ?? "").trim();
    if (!raw) return null;

    // Tolera ```json ... ``` no caso do modelo ignorar response_format
    const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
    const parsed = JSON.parse(cleaned) as Partial<EnrichedContext>;

    const urgencia: EnrichedContext["urgencia"] =
      parsed.urgencia === "alta" || parsed.urgencia === "media" || parsed.urgencia === "baixa"
        ? parsed.urgencia
        : "media";

    return {
      contexto: (parsed.contexto ?? "").toString().trim(),
      sentimento: (parsed.sentimento ?? "neutro").toString().trim(),
      urgencia,
      sugestao: (parsed.sugestao ?? "").toString().trim(),
    };
  } catch (e) {
    console.warn("[escalate] resumo IA erro:", e);
    return null;
  }
}
