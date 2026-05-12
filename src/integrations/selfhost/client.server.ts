// Cliente Supabase self-hosted — service role, server-only.
// NUNCA importar este arquivo em código de browser.
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

let _client: SupabaseClient | null = null;

export function getSelfhost(): SupabaseClient {
  if (_client) return _client;
  const url = process.env.SELFHOST_SUPABASE_URL;
  const key = process.env.SELFHOST_SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error(
      "SELFHOST_SUPABASE_URL e SELFHOST_SUPABASE_SERVICE_ROLE_KEY precisam estar configurados."
    );
  }
  _client = createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  return _client;
}

// Helper: executa um SELECT/UPDATE bruto via RPC com a chave pgcrypto na sessão.
// Como Supabase não expõe SET LOCAL diretamente, usamos a função enc/dec passando a chave.
export function pgcryptoKey(): string {
  const k = process.env.PGCRYPTO_KEY;
  if (!k) throw new Error("PGCRYPTO_KEY não configurado");
  return k;
}
