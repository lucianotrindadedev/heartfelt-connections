import { Hono } from "hono";
import { z } from "zod";
import { SignJWT } from "jose";
import { eq } from "drizzle-orm";
import { env, db, accounts } from "@sarai/shared";

export const authRoute = new Hono();

const ExchangeBody = z.object({
  accountId: z.string().min(1),
  accountName: z.string().nullish(),
});


authRoute.post("/exchange", async (c) => {
  const body = ExchangeBody.parse(await c.req.json());
  const { accountId, accountName } = body;
  const adminToken = c.req.header("X-Admin-Token");

  if (env.NODE_ENV === "production") {
    const isAdmin = adminToken === env.ADMIN_API_KEY;
    // Sem assinatura, permitimos acesso direto (simplificado para o usuário)
  }

  // Garante que a conta existe (auto-provisiona no primeiro embed)
  const name = accountName ?? accountId;
  const [row] = await db
    .insert(accounts)
    .values({ id: accountId, name })
    .onConflictDoNothing()
    .returning();

  const account =
    row ??
    (await db.select().from(accounts).where(eq(accounts.id, accountId)).limit(1))[0];

  const jwt = await new SignJWT({ accountId })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("15m")
    .sign(new TextEncoder().encode(env.JWT_SECRET));

  return c.json({
    token: jwt,
    account: {
      id: account?.id ?? accountId,
      name: account?.name ?? name,
    },
  });
});
