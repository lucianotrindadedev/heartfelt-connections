// Tool de etiquetagem de interesse, COMPARTILHADA entre os agentes.
//
// Vivia dentro de qualifier.server.ts. Saiu de lá quando o modo unificado
// (agent_mode="unified") passou a precisar dela dentro do scheduler: manter a
// implementação no qualifier criaria import circular (qualifier já importa
// execListarHorarios do scheduler) e, pior, duas cópias divergentes da mesma
// trava de etiquetagem.

import { tagGateMissingField } from "@/lib/booking-template";
import { loadHelenaAccount } from "@/lib/helena.server";
import { applyTagByApproxName } from "@/lib/helena-tags.server";
import type { AgentContext } from "./context";
import type { LlmTool } from "./llm.server";

export interface TagToolOutcome {
  result: string;
}

/** Definição da tool exposta ao LLM. Mantida IDÊNTICA à que vivia no qualifier
 *  (os nomes candidatos vão pelo prompt dinâmico, não por enum) para que a
 *  extração não mude o comportamento de nenhum agente já em produção. */
export const APLICAR_TAG_TOOL: LlmTool = {
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
};

/**
 * Aplica a tag de interesse no CRM (Helena).
 *
 * Respeita, nesta ordem: a trava de etiquetagem (`tag_gate_field` — ex.: escola
 * só etiqueta turma depois da data de nascimento), `dryRun` (modo treinador) e
 * `disableTags` (test_mode: conversa e agenda seguem vivas, só o CRM não é
 * tocado). Nunca cria tag nova — resolve o nome aproximado para um nome que já
 * existe na conta; se não achar, devolve erro para o LLM tentar outro.
 */
export async function execAplicarTagInteresse(
  ctx: AgentContext,
  tag: string,
  logPrefix = "agent",
): Promise<TagToolOutcome> {
  const missingField = tagGateMissingField(ctx.agentSettings, ctx.leadData);
  if (missingField) {
    console.log(
      `[${logPrefix}] aplicar_tag bloqueada — falta '${missingField}' (tag_gate_field) tag pedida='${tag}'`,
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
