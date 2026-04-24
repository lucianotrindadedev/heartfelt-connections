import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
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

export function SessionProvider({ children }: { children: ReactNode }) {
  const [accountId, setAccountId] = useState<string | null>(null);
  const [accountName, setAccountName] = useState<string | null>(null);
  const [status, setStatus] = useState<SessionContextValue["status"]>("idle");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (getJwt()) {
      const cachedId = window.sessionStorage.getItem("helena_account_id");
      const cachedName = window.sessionStorage.getItem("helena_account_name");
      if (cachedId) {
        setAccountId(cachedId);
        setAccountName(cachedName);
        setStatus("authenticated");
      }
    }
  }, []);

  const signIn: SessionContextValue["signIn"] = async (params) => {
    setStatus("loading");
    setError(null);
    try {
      const result = await exchangeAccountToken(params);
      setJwt(result.token);
      setAccountId(result.account.id);
      setAccountName(result.account.name);
      window.sessionStorage.setItem("helena_account_id", result.account.id);
      window.sessionStorage.setItem("helena_account_name", result.account.name);
      setStatus("authenticated");
    } catch (e) {
      setStatus("error");
      setError(e instanceof Error ? e.message : "Falha ao autenticar");
    }
  };

  const signOut = () => {
    clearJwt();
    if (typeof window !== "undefined") {
      window.sessionStorage.removeItem("helena_account_id");
      window.sessionStorage.removeItem("helena_account_name");
    }
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
