import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import type { Session, User, SupabaseClient } from "@supabase/supabase-js";
import { initSelfhost } from "@/integrations/selfhost/client";

interface AuthContextValue {
  user: User | null;
  session: Session | null;
  loading: boolean;
  supabase: SupabaseClient | null;
  signIn: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [supabase, setSupabase] = useState<SupabaseClient | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let unsub: (() => void) | undefined;
    let cancelled = false;

    initSelfhost()
      .then(async (client) => {
        if (cancelled) return;
        setSupabase(client);
        const { data } = await client.auth.getSession();
        setSession(data.session);
        setUser(data.session?.user ?? null);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const sub = client.auth.onAuthStateChange((_e: any, sess: any) => {
          setSession(sess);
          setUser(sess?.user ?? null);
        });
        unsub = () => sub.data.subscription.unsubscribe();
      })
      .catch((e) => {
        console.error("[auth] init falhou", e);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
      unsub?.();
    };
  }, []);

  const signIn = async (email: string, password: string) => {
    const client = supabase ?? (await initSelfhost());
    const { error } = await client.auth.signInWithPassword({ email, password });
    if (error) throw error;
  };

  const signOut = async () => {
    const client = supabase ?? (await initSelfhost());
    await client.auth.signOut();
  };

  return (
    <AuthContext.Provider value={{ user, session, loading, supabase, signIn, signOut }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth deve ser usado dentro de <AuthProvider>");
  return ctx;
}
