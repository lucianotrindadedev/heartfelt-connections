// Server fn pública que devolve a config browser-safe do self-hosted Supabase.
// Fica em .functions para o splitter remover o handler do bundle do client.
import { createServerFn } from "@tanstack/react-start";

export const getSelfhostPublicConfig = createServerFn({ method: "GET" }).handler(
  async () => {
    const url = process.env.SELFHOST_SUPABASE_URL;
    const anonKey = process.env.SELFHOST_SUPABASE_ANON_KEY;
    if (!url || !anonKey) {
      throw new Error("Self-hosted Supabase não configurado nos secrets");
    }
    return { url, anonKey };
  }
);
