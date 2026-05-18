// Middleware client-side: anexa o bearer do self-hosted Supabase em toda serverFn.
import { createMiddleware } from "@tanstack/react-start";
import { getSelfhostBrowser } from "./client";

export const attachSelfhostAuth = createMiddleware({ type: "function" }).client(
  async ({ next }) => {
    try {
      const supabase = getSelfhostBrowser();
      const { data } = await supabase.auth.getSession();
      const token = data.session?.access_token;
      if (token) {
        return next({ headers: { Authorization: `Bearer ${token}` } });
      }
    } catch {
      // sem sessão — segue sem header
    }
    return next();
  }
);
