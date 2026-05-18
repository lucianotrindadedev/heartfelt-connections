// Cliente HTTP do CRM Helena, autenticado por conta.
// Server-only — não importar do client.
import { getSelfhost } from "@/integrations/selfhost/client.server";
import { decryptValue } from "@/lib/crypto.server";

export interface HelenaAccount {
  id: string;
  baseUrl: string;
  token: string;
}

export async function loadHelenaAccount(accountId: string): Promise<HelenaAccount> {
  const sb = getSelfhost();
  const { data, error } = await sb
    .from("accounts")
    .select("id, helena_base_url, helena_token_enc")
    .eq("id", accountId)
    .single();
  if (error) throw new Error(`Conta ${accountId} não encontrada: ${error.message}`);
  const token = await decryptValue(data.helena_token_enc as unknown as string);
  if (!token) throw new Error(`Token Helena não configurado para ${accountId}`);
  return {
    id: data.id as string,
    baseUrl: (data.helena_base_url as string) ?? "https://api.crmmentoriae7.com.br",
    token,
  };
}

// Envia mensagem de texto via API do CRM Helena.
// Endpoint exato pode variar; usamos POST /v1/messages como padrão.
export async function sendHelenaText(
  account: HelenaAccount,
  params: { phone: string; text: string; sessionId?: string },
): Promise<{ ok: boolean; status: number; body: string }> {
  const url = `${account.baseUrl.replace(/\/$/, "")}/v1/messages`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${account.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      id_conta: account.id,
      telefone: params.phone,
      tipo: "texto",
      conteudo: params.text,
      session_id: params.sessionId,
      origem: "agente",
    }),
  });
  const body = await res.text();
  return { ok: res.ok, status: res.status, body };
}

export async function sendHelenaAudio(
  account: HelenaAccount,
  params: { phone: string; audioUrl: string; sessionId?: string },
): Promise<{ ok: boolean; status: number; body: string }> {
  const url = `${account.baseUrl.replace(/\/$/, "")}/v1/messages`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${account.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      id_conta: account.id,
      telefone: params.phone,
      tipo: "audio",
      audio_url: params.audioUrl,
      session_id: params.sessionId,
      origem: "agente",
    }),
  });
  const body = await res.text();
  return { ok: res.ok, status: res.status, body };
}
