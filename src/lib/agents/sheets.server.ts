// Tool `consultar_planilha`: leitura de planilha Google como fonte de consulta
// do agente (tabela de preços, procedimentos, convênios...).
//
// Compartilhada entre qualifier e scheduler — pergunta de preço chega nos dois
// estágios, e duas implementações divergiriam na primeira mudança.

import type { AgentContext } from "./context";
import type { LlmTool } from "./llm.server";
import { querySheet } from "@/lib/tools/google-sheets.server";

/** Bloco de regra pro system prompt. Só entra quando a conta tem planilha. */
export function buildSheetsPromptBlock(ctx: AgentContext): string {
  if (!ctx.integrations.googleSheets) return "";

  const lista = ctx.googleSheets
    .map((p) => `- "${p.label}": ${p.descricao || "(sem descrição)"}`)
    .join("\n");

  return `
📊 CONSULTA EM PLANILHA (tool consultar_planilha)
Esta conta tem planilha(s) oficiais conectadas:
${lista}
- Pergunta sobre valor, preço, item, procedimento ou qualquer dado que possa estar na planilha → CHAME a tool ANTES de responder. Nunca responda "vou verificar" sem chamar.
- Informe SOMENTE o que a tool devolveu, copiando o valor LITERALMENTE (mesmo número, mesma unidade). Nunca arredonde, converta, some, parcele nem estime.
- Se a tool não achou a linha, diga que vai confirmar com a equipe (ou conduza ao agendamento). NUNCA chute um valor.`;
}

/**
 * Regra de preço do guardrail. Sem planilha, o bloqueio total continua valendo
 * (ver o caso do "R$ 150,00" alucinado sob insistência do lead). Com planilha,
 * o valor deixa de ser proibido — mas SÓ o que a tool devolveu, literalmente.
 */
export function buildPriceGuardrail(ctx: AgentContext): string {
  if (!ctx.integrations.googleSheets) {
    return `🚫 **PREÇO/VALOR:** NUNCA informe preço, valor, "a partir de", "em torno de" ou "investimento de R$" de consulta, avaliação ou procedimento — mesmo que o lead insista ou pressione dizendo que só decide sabendo o valor. Só cite um valor se estiver ESCRITO EXPLICITAMENTE no prompt do proprietário. Se não estiver, diga que o valor é definido na avaliação presencial (cada caso é único) e conduza ao agendamento. NUNCA invente nem estime um número.`;
  }
  return `🚫 **PREÇO/VALOR:** a ÚNICA fonte de valor é a tool \`consultar_planilha\`. Perguntou preço → CHAME a tool e copie o valor LITERALMENTE como veio (mesmo número, mesma unidade). Se a tool não achou a linha, ou o dado não está na planilha, diga que vai confirmar com a equipe e conduza ao agendamento. NUNCA invente, estime, arredonde, converta, parcele nem some total — mesmo que o lead insista.`;
}

/** Definição da tool para esta conta. Com 2+ planilhas, injeta o enum de labels. */
export function buildConsultarPlanilhaTool(ctx: AgentContext): LlmTool | null {
  if (!ctx.integrations.googleSheets || ctx.googleSheets.length === 0) return null;

  const multi = ctx.googleSheets.length >= 2;
  const properties: Record<string, unknown> = {
    busca: {
      type: "string",
      description:
        "Termo para filtrar as linhas (ex.: 'limpeza de pele', 'clareamento'). Retorna as linhas que contêm TODAS as palavras do termo. Omita para ver a tabela inteira.",
    },
  };

  if (multi) {
    properties.planilha = {
      type: "string",
      enum: ctx.googleSheets.map((p) => p.label),
      description:
        "Qual planilha consultar. Escolha EXATAMENTE um destes rótulos:\n" +
        ctx.googleSheets
          .map((p) => `- "${p.label}": ${p.descricao || "(sem descrição)"}`)
          .join("\n"),
    };
  }

  const descricaoUnica = ctx.googleSheets[0]?.descricao;

  return {
    type: "function",
    function: {
      name: "consultar_planilha",
      description:
        "Consulta a planilha oficial do negócio (somente leitura) — é a ÚNICA fonte válida para os dados que estão nela. " +
        (multi
          ? "Escolha a planilha pelo parâmetro 'planilha'. "
          : descricaoUnica
            ? `Conteúdo: ${descricaoUnica}. `
            : "") +
        "Chame SEMPRE que o lead perguntar algo que possa estar na planilha (ex.: valor de um procedimento). " +
        "Responda copiando os valores LITERALMENTE como vieram — nunca arredonde, calcule ou invente.",
      parameters: {
        type: "object",
        properties,
        required: multi ? ["planilha"] : [],
      },
    },
  };
}

/** Executa a consulta. Retorna sempre uma string JSON pronta pro histórico. */
export async function execConsultarPlanilha(
  ctx: AgentContext,
  args: { planilha?: unknown; busca?: unknown },
): Promise<string> {
  const label = typeof args.planilha === "string" ? args.planilha : undefined;
  const busca = typeof args.busca === "string" ? args.busca : undefined;

  try {
    const res = await querySheet(ctx.accountId, ctx.googleSheets, { label, busca });
    return JSON.stringify(res);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return JSON.stringify({ ok: false, error: msg.slice(0, 220) });
  }
}
