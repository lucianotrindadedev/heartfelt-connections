// Middleware server-fn: valida bearer do self-hosted Supabase e exige role superadmin.
import { createMiddleware } from "@tanstack/react-start";
import { getRequestHeader } from "@tanstack/react-start/server";
import { createClient } from "@supabase/supabase-js";
import { getSelfhost } from "./client.server";

export const requireSuperAdmin = createMiddleware({ type: "function" }).server(
  async ({ next }) => {
    const authHeader = getRequestHeader("authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      throw new Error("Não autenticado");
    }
    const token = authHeader.slice("Bearer ".length);

    // valida o JWT contra o self-hosted via /auth/v1/user usando o anon key
    const url = process.env.SELFHOST_SUPABASE_URL;
    const anon = process.env.SELFHOST_SUPABASE_ANON_KEY;
    if (!url || !anon) throw new Error("Self-hosted Supabase não configurado");

    const userClient = createClient(url, anon, {
      global: { headers: { Authorization: `Bearer ${token}` } },
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: userRes, error: userErr } = await userClient.auth.getUser();
    if (userErr || !userRes.user) throw new Error("Token inválido");
    const userId = userRes.user.id;

    // checa role via service-role
    const admin = getSelfhost();
    const { data: roleRes, error: roleErr } = await admin.rpc("has_role", {
      _user_id: userId,
      _role: "superadmin",
    });
    if (roleErr) throw new Error("Falha ao validar papel: " + roleErr.message);
    if (!roleRes) throw new Error("Acesso negado: requer superadmin");

    return next({ context: { userId, email: userRes.user.email ?? null } });
  }
);
