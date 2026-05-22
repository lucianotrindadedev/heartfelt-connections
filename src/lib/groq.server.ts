// Helper centralizado para a API key do Groq (transcrição de áudio).
//
// Ordem de resolução:
//   1. `GROQ_API_KEY` na env do servidor (recomendado em produção / Coolify).
//   2. Chave salva por conta em `account_secrets.groq_api_key_enc` (legado —
//      mantida por retrocompat, mas a UI não pede mais).
//
// Decisão de produto: a transcrição de áudio é um custo central da plataforma,
// então a chave fica no servidor e atende todas as contas. O usuário não
// precisa mais cadastrar Groq individualmente.

import { getSelfhost } from "@/integrations/selfhost/client.server";
import { decryptValue } from "@/lib/crypto.server";

export async function getGroqApiKey(accountId?: string): Promise<string | null> {
  // 1. Env var do servidor — caminho preferido.
  const envKey = process.env.GROQ_API_KEY;
  if (envKey && envKey.length > 10) return envKey;

  // 2. Fallback: chave por conta (suporte ao modelo antigo).
  if (!accountId) return null;
  const sb = getSelfhost();
  const { data } = await sb
    .from("account_secrets")
    .select("groq_api_key_enc")
    .eq("account_id", accountId)
    .maybeSingle();
  const enc = data?.groq_api_key_enc as unknown as string | null;
  if (!enc) return null;

  try {
    return await decryptValue(enc);
  } catch {
    return null;
  }
}
