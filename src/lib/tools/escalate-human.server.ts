// Escalada para atendimento humano:
// 1. Tag "IA Desligada" no contato Helena
// 2. Alerta no grupo Evolution API configurado
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

const AI_DISABLED_TAG = "IA Desligada";

export async function escalateToHuman(params: {
  agentId: string;
  accountId: string;
  phone: string;
  sessionId?: string;
  helenaContactId?: string;
  reason?: string;
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
      const alertText =
        `🚨 *Escalada Humana*\n\n` +
        `📱 Telefone: ${params.phone}\n` +
        (params.reason ? `📝 Motivo: ${params.reason}\n` : "") +
        `\n_O atendimento foi transferido para humano._`;

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
