import { createMiddleware } from "hono/factory";
import { jwtVerify } from "jose";
import { env } from "@sarai/shared";

type Vars = { accountId: string };

export const requireSession = createMiddleware<{ Variables: Vars }>(async (c, next) => {
  const auth = c.req.header("Authorization");
  if (!auth?.startsWith("Bearer ")) return c.json({ error: "unauthorized" }, 401);
  try {
    const { payload } = await jwtVerify(
      auth.slice(7),
      new TextEncoder().encode(env.JWT_SECRET),
    );
    if (typeof payload.accountId !== "string") throw new Error("no accountId");
    c.set("accountId", payload.accountId);
    await next();
  } catch {
    return c.json({ error: "invalid token" }, 401);
  }
});

export const requireAdmin = createMiddleware(async (c, next) => {
  const token = c.req.header("X-Admin-Token");
  if (token !== env.ADMIN_API_KEY) return c.json({ error: "forbidden" }, 403);
  await next();
});
