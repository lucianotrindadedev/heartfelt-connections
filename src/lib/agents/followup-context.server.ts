// Sub-agente de follow-up CONTEXTUAL.
// Recebe o histórico da conversa + instrução do step + system prompt do agente
// e gera UMA mensagem de reengajamento curta, alinhada ao tom do agente.
//
// Não usa o orchestrator/qualifier — é uma chamada LLM única, sem tools.

import { getSelfhost } from "@/integrations/selfhost/client.server";
import { decryptValue } from "@/lib/crypto.server";
import { DEFAULT_AUX_FALLBACK_MODEL, DEFAULT_LLM_MODEL } from "@/lib/llm-defaults";
import {
  avaliarTextoDoFollowup,
  diasFechadosDoExpediente,
  FOLLOWUP_SKIP_TOKEN,
  NOME_POR_EXTENSO,
  recorteSemValores,
  type FollowupVeredito,
} from "@/lib/followup-guard";
import { listClinicExpertsUnidades } from "@/lib/tools/clinic-experts.server";
import { listAccountAgendas } from "@/lib/tools/google-calendar.server";
import { callLlmWithFallback, type LlmMessage } from "./llm.server";

interface FollowupContextInput {
  accountId: string;
  agentId: string;
  conversationId: string;
  stepInstruction: string;
  stepOrdem: number;
}

interface FollowupContextOutput {
  reply: string;
  /** Se o texto pode ir ao lead — ver avaliarTextoDoFollowup. Quem chama NÃO
   *  envia quando action="skip". */
  veredito: FollowupVeredito;
  model: string;
  tokens_in: number;
  tokens_out: number;
  cost_usd: number;
}

export async function generateContextualFollowup(
  input: FollowupContextInput,
): Promise<FollowupContextOutput> {
  const sb = getSelfhost();

  // 1. Chave OpenRouter
  const secrets = await sb
    .from("account_secrets")
    .select("openrouter_api_key_enc")
    .eq("account_id", input.accountId)
    .single();
  if (!secrets.data?.openrouter_api_key_enc) {
    throw new Error("OpenRouter não configurada para a conta.");
  }
  const orKey = await decryptValue(secrets.data.openrouter_api_key_enc as unknown as string);
  if (!orKey) throw new Error("Falha ao descriptografar OpenRouter key.");

  // 2. Carrega agente
  const [agent, llmCfg] = await Promise.all([
    sb
      .from("agents")
      .select("id, system_prompt, settings, llm_model_override")
      .eq("id", input.agentId)
      .single(),
    sb
      .from("account_llm_config")
      .select("default_model, max_tokens, temperature")
      .eq("account_id", input.accountId)
      .single(),
  ]);
  if (agent.error || !agent.data) throw new Error("Agente não encontrado.");

  const model =
    (agent.data.llm_model_override as string | null) ||
    (llmCfg.data?.default_model as string | undefined) ||
    DEFAULT_LLM_MODEL;

  const basePrompt = (agent.data.system_prompt as string) || "";
  const settings = (agent.data.settings as Record<string, string> | null) ?? {};
  // Com várias agendas/unidades, cada uma tem o próprio expediente e o do agente
  // não vale: a Central MF Beauty marca sábado fechado e tem 16 agendamentos em
  // sábado (unidades Clinic Experts). Nesses casos a trava de dia fechado não roda.
  const [agendasGcal, unidadesCe] = await Promise.all([
    listAccountAgendas(input.accountId),
    listClinicExpertsUnidades(input.accountId),
  ]);
  const agendaUnica = agendasGcal.length < 2 && unidadesCe.length < 2;
  const diasFechados = agendaUnica ? diasFechadosDoExpediente(settings.business_hours_json) : [];
  // O follow-up só vê um recorte do prompt da clínica e sem as regras de QUANDO
  // cada valor vale. Linhas com valor saem do recorte: na Bomfim o recorte
  // começava pela trava da emergência com "O valor de investimento da consulta
  // é R$ 275,00" literal, e o modelo mandou isso para quem pediria a Consulta
  // de Diagnóstico (cortesia). Ver followup-guard.ts.
  const contextoDoAgente = recorteSemValores(basePrompt, 3000);

  // 3. Histórico da conversa (últimas 20 mensagens)
  const msgs = await sb
    .from("messages")
    .select("role, content, criado_em")
    .eq("conversation_id", input.conversationId)
    .order("criado_em", { ascending: false })
    .limit(20);
  const history =
    msgs.data
      ?.slice()
      .reverse()
      .filter((m) => m.role === "user" || m.role === "assistant")
      .map((m) => ({
        role: (m.role === "user" ? "user" : "assistant") as "user" | "assistant",
        content: (m.content as string) || "",
      })) ?? [];

  if (history.length === 0) {
    throw new Error("Conversa sem histórico — não é possível gerar follow-up contextual.");
  }

  // 4. Monta system prompt do follow-up
  const followupSystem = `Você é ${settings.assistant_name || "a assistente"} da ${settings.company_name || "empresa"}.

Você está enviando uma mensagem de FOLLOW-UP nº ${input.stepOrdem} para um lead
que NÃO respondeu há um tempo. Sua missão é reengajar SEM ser invasivo nem
soar como cobrança.

# REGRAS

0. O texto que você escrever é enviado DIRETO ao lead pelo WhatsApp, palavra por
   palavra. Você fala SEMPRE com o lead — nunca com a equipe, com o sistema ou
   sobre estas instruções. Nunca peça histórico, contexto ou informações a
   ninguém: o histórico que existe é o que está acima, e ele basta.
1. Gere APENAS uma mensagem curta (1-3 frases, máximo 250 caracteres).
2. Se a conversa trouxer algo concreto (nome, interesse, dor, dúvida), use para
   personalizar. Se não trouxer (ex.: o lead só mandou um link ou uma saudação),
   faça uma pergunta simples e acolhedora sobre o que ele procura — isso está
   certo, não é "genérico demais".
3. Termine com uma pergunta aberta que estimule resposta.
4. Mantenha o tom já estabelecido nas suas mensagens anteriores (não fique
   formal de repente se foi descontraído antes, e vice-versa).
5. NUNCA peça desculpa por "incomodar" nem use palavras como "perdão", "desculpe".
6. NUNCA mande lembretes do tipo "lembre-se que..." — soa robótico.
7. Não mencione que é "follow-up" nem que o lead "não respondeu".
8. Se NÃO deve haver mensagem — o lead pediu para parar, disse que não tem
   interesse, a conversa foi encerrada ou a pessoa não é um paciente/cliente —
   responda exatamente ${FOLLOWUP_SKIP_TOKEN} (só essa palavra) e nada mais.
9. 🚫 NUNCA cite valor, preço, "investimento", desconto ou parcelamento — nem
   se o lead perguntou. Você não tem a tabela de preços nem sabe qual tipo de
   consulta vale para ele. Se o lead perguntou de valor/pagamento, diga só que
   a equipe explica tudo na consulta, e pergunte se pode seguir com o agendamento.
10. 🚫 NUNCA ofereça dia, horário ou data, nem diga que agendou/vai agendar. Você
    não tem acesso à agenda. Para avançar, pergunte se pode mostrar os horários
    disponíveis — quem busca a agenda é o atendimento, depois que o lead responder.${
      diasFechados.length
        ? `\n11. A clínica NÃO atende: ${diasFechados.map((d) => NOME_POR_EXTENSO[d] ?? d).join(", ")}. Nunca cite esses dias, nem repetindo o que o lead disse.`
        : ""
    }

# INSTRUÇÃO ESPECÍFICA DESTE FOLLOW-UP (definida pelo dono do agente)

${input.stepInstruction}

# CONTEXTO DO AGENTE (resumido)

${contextoDoAgente}

# FORMATO DE SAÍDA

Responda APENAS com o texto da mensagem que será enviada ao lead (ou
${FOLLOWUP_SKIP_TOKEN}). Sem JSON, sem prefixos, sem "Resposta:", apenas o texto.`;

  // 5. Chama LLM via callLlmWithFallback — ele já faz: retry com budget MAIOR
  //    quando finish_reason=length (modelos com reasoning, ex.: gemini-flash,
  //    queimam tokens em "pensamento" e truncavam o follow-up) + fallback de
  //    modelo se o principal falhar. Antes, o fetch cru descartava a mensagem na
  //    1ª truncagem (era a causa de "[followup-seq] contextual falhou").
  const messages: LlmMessage[] = [
    ...history,
    {
      role: "user",
      // Instrução interna, não fala do lead. Antes era "(Sistema: ... Gere o
      // follow-up #N)" e, quando decidia não cumprir, o modelo respondia ao
      // "sistema" pedindo o histórico — e isso ia para o lead (ver
      // followup-guard.ts).
      content:
        `[Instrução interna — não é o lead falando.] Escreva agora a próxima mensagem para o lead, ` +
        `exatamente como ela será enviada a ele no WhatsApp (ou ${FOLLOWUP_SKIP_TOKEN}).`,
    },
  ];

  const turn = await callLlmWithFallback(
    orKey,
    {
      model,
      systemDynamic: followupSystem,
      messages,
      temperature: 0.7,
      maxTokens: 1500,
    },
    model === DEFAULT_AUX_FALLBACK_MODEL ? [] : [DEFAULT_AUX_FALLBACK_MODEL],
  );

  const reply = (turn.content ?? "").trim();
  if (!reply) throw new Error("LLM retornou resposta vazia.");
  // Salvaguarda: se ainda truncou mesmo após o retry de budget maior, descarta.
  if (turn.finishReason === "length") {
    throw new Error(
      `Follow-up truncado mesmo após retry (tokens_out=${turn.tokensOut}) — mensagem descartada.`,
    );
  }

  return {
    reply,
    veredito: avaliarTextoDoFollowup(reply, { diasFechados }),
    model: turn.modelUsed,
    tokens_in: turn.tokensIn,
    tokens_out: turn.tokensOut,
    cost_usd: turn.costUsd,
  };
}
