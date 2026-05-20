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
// Prioriza o endpoint de sessão (mais simples, não precisa do número "from").
// Fallback: POST /v1/message/send-sync com "to" e "from" null.
export async function sendHelenaText(
  account: HelenaAccount,
  params: { phone: string; text: string; sessionId?: string },
): Promise<{ ok: boolean; status: number; body: string }> {
  const base = account.baseUrl.replace(/\/$/, "");

  // Caminho preferencial: envia dentro da sessão existente
  if (params.sessionId) {
    const url = `${base}/chat/v1/session/${params.sessionId}/message/sync`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${account.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ text: params.text }),
    });
    const body = await res.text();
    if (res.ok) return { ok: true, status: res.status, body };
    // Se falhar, tenta o endpoint direto
    console.warn(`[helena] sessão ${params.sessionId} falhou (${res.status}), tentando send-sync`);
  }

  // Fallback: envia diretamente pelo telefone
  const url = `${base}/v1/message/send-sync`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${account.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      to: params.phone,
      from: null,
      body: { text: params.text },
      options: params.sessionId ? { sessionId: params.sessionId } : undefined,
    }),
  });
  const body = await res.text();
  return { ok: res.ok, status: res.status, body };
}

export async function sendHelenaAudio(
  account: HelenaAccount,
  params: { phone: string; audioUrl: string; sessionId?: string },
): Promise<{ ok: boolean; status: number; body: string }> {
  const base = account.baseUrl.replace(/\/$/, "");

  if (params.sessionId) {
    const url = `${base}/chat/v1/session/${params.sessionId}/message/sync`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${account.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ fileUrl: params.audioUrl }),
    });
    const body = await res.text();
    if (res.ok) return { ok: true, status: res.status, body };
  }

  // Fallback: envia diretamente pelo telefone
  const url = `${base}/v1/message/send-sync`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${account.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      to: params.phone,
      from: null,
      body: { fileUrl: params.audioUrl },
    }),
  });
  const body = await res.text();
  return { ok: res.ok, status: res.status, body };
}
