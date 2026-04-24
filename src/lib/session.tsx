import { createContext, useContext, useEffect, useState, useRef, type ReactNode } from "react";
import {
  clearJwt,
  exchangeAccountToken,
  getJwt,
  setJwt,
} from "./api";

interface SessionContextValue {
  accountId: string | null;
  accountName: string | null;
  status: "idle" | "loading" | "authenticated" | "error";
  error: string | null;
  signIn: (params: {
    accountId: string;
  }) => Promise<void>;
  signOut: () => void;
}

const SessionContext = createContext<SessionContextValue | null>(null);

function safeSessionGet(key: string): string | null {
  try { return window.sessionStorage.getItem(key); } catch { return null; }
}
function safeSessionSet(key: string, value: string) {
  try { window.sessionStorage.setItem(key, value); } catch { /* ignore */ }
}
function safeSessionRemove(key: string) {
  try { window.sessionStorage.removeItem(key); } catch { /* ignore */ }
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const [accountId, setAccountId] = useState<string | null>(null);
  const [accountName, setAccountName] = useState<string | null>(null);
  const [status, setStatus] = useState<SessionContextValue["status"]>("idle");
  const [error, setError] = useState<string | null>(null);
  const signingIn = useRef(false);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (getJwt()) {
      const cachedId = safeSessionGet("helena_account_id");
      const cachedName = safeSessionGet("helena_account_name");
      if (cachedId) {
        setAccountId(cachedId);
        setAccountName(cachedName);
        setStatus("authenticated");
      }
    }
  }, []);

  const signIn: SessionContextValue["signIn"] = async (params) => {
    if (signingIn.current) return;
    signingIn.current = true;
    setStatus("loading");
    setError(null);
    try {
      const result = await exchangeAccountToken(params);
      setJwt(result.token);
      setAccountId(result.account.id);
      setAccountName(result.account.name);
      safeSessionSet("helena_account_id", result.account.id);
      safeSessionSet("helena_account_name", result.account.name);
      setStatus("authenticated");
    } catch (e) {
      setStatus("error");
      setError(e instanceof Error ? e.message : "Falha ao autenticar");
    } finally {
      signingIn.current = false;
    }
  };

  const signOut = () => {
    clearJwt();
    safeSessionRemove("helena_account_id");
    safeSessionRemove("helena_account_name");
    setAccountId(null);
    setAccountName(null);
    setStatus("idle");
  };

  return (
    <SessionContext.Provider
      value={{ accountId, accountName, status, error, signIn, signOut }}
    >
      {children}
    </SessionContext.Provider>
  );
}

export function useSession() {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error("useSession must be used inside SessionProvider");
  return ctx;
}
