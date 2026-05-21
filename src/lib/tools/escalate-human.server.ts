// Escalada para atendimento humano:
// 1. Tag "IA Desligada" no contato Helena
// 2. Alerta no grupo Evolution API configurado
import { getSelfhost } from "@/integrations/selfhost/client.server";
import { decryptValue } from "@/lib/crypto.server";
import { loadHelenaAccount } from "@/lib/helena.server";

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
    .select("grupo_alerta, evolution_url, evolution_instance, evolution_key_enc, ativo")
    .eq("agent_id", params.agentId)
    .single();

  let tagged = false;
  let alerted = false;

  // 1. Tag "IA Desligada" no contato Helena
  try {
    const helena = await loadHelenaAccount(params.accountId);
    const tagUrl = `${helena.baseUrl.replace(/\/$/, "")}/v1/contacts/tags`;
    const tagRes = await fetch(tagUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${helena.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        id_conta: helena.id,
        telefone: params.phone,
        tags: ["IA Desligada"],
        action: "add",
        session_id: params.sessionId ?? null,
      }),
    });
    tagged = tagRes.ok;
  } catch (e) {
    console.error("[escalate] falha ao taguear no Helena:", e);
  }

  // 2. Alerta no grupo Evolution API
  if (cfg?.ativo && cfg.grupo_alerta && cfg.evolution_url && cfg.evolution_instance) {
    try {
      const evKey = await decryptValue(cfg.evolution_key_enc as unknown as string);
      if (evKey) {
        const alertText =
          `🚨 *Escalada Humana*\n\n` +
          `📱 Telefone: ${params.phone}\n` +
          (params.reason ? `📝 Motivo: ${params.reason}\n` : "") +
          `\n_O atendimento foi transferido para humano._`;

        const evUrl = `${(cfg.evolution_url as string).replace(/\/$/, "")}/message/sendText/${cfg.evolution_instance}`;
        const evRes = await fetch(evUrl, {
          method: "POST",
          headers: {
            apikey: evKey,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            number: cfg.grupo_alerta,
            text: alertText,
          }),
        });
        alerted = evRes.ok;
      }
    } catch (e) {
      console.error("[escalate] falha ao enviar alerta Evolution:", e);
    }
  }

  return { tagged, alerted };
}
