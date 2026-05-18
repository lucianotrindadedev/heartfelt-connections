// Cliente Supabase self-hosted para o BROWSER (publishable/anon key).
// URL e anon key vêm via VITE_ env (públicas — seguras para bundle).
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

let _client: SupabaseClient | null = null;

export function getSelfhostBrowser(): SupabaseClient {
  if (_client) return _client;
  const url = import.meta.env.VITE_SELFHOST_SUPABASE_URL as string | undefined;
  const key = import.meta.env.VITE_SELFHOST_SUPABASE_ANON_KEY as string | undefined;
  if (!url || !key) {
    throw new Error(
      "VITE_SELFHOST_SUPABASE_URL e VITE_SELFHOST_SUPABASE_ANON_KEY precisam estar no .env"
    );
  }
  _client = createClient(url, key, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      storageKey: "selfhost-auth",
    },
  });
  return _client;
}
