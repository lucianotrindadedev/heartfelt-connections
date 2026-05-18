// Cliente Supabase self-hosted para BROWSER.
// Bootstrap async: busca URL+anon do servidor (server fn) e inicializa.
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { getSelfhostPublicConfig } from "@/lib/selfhost-config.functions";

let _client: SupabaseClient | null = null;
let _bootPromise: Promise<SupabaseClient> | null = null;

export async function initSelfhost(): Promise<SupabaseClient> {
  if (_client) return _client;
  if (_bootPromise) return _bootPromise;
  _bootPromise = (async () => {
    const cfg = await getSelfhostPublicConfig();
    _client = createClient(cfg.url, cfg.anonKey, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        storageKey: "selfhost-auth",
      },
    });
    return _client;
  })();
  return _bootPromise;
}

export function getSelfhostBrowser(): SupabaseClient {
  if (!_client) {
    throw new Error("Self-hosted client não inicializado. Chame initSelfhost() primeiro.");
  }
  return _client;
}
