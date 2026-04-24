import { Hono } from "hono";
import { z } from "zod";
import { SignJWT } from "jose";
import { eq } from "drizzle-orm";
import { env, db, accounts } from "@sarai/shared";

export const authRoute = new Hono();

const ExchangeBody = z.object({
  accountId: z.string().min(1),
  accountName: z.string().nullish(),
  userId: z.string().nullish(),
  sig: z.string().nullish(),
  ts: z.string().nullish(),
});

async function verifyHmac(accountId: string, ts: string, sig: string) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(env.HELENA_HMAC_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, enc.encode(`${accountId}.${ts}`));
  const hex = Array.from(new Uint8Array(mac))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return hex === sig.toLowerCase();
}

authRoute.post("/exchange", async (c) => {
  const body = ExchangeBody.parse(await c.req.json());
  const { accountId, accountName, ts, sig } = body;
  const adminToken = c.req.header("X-Admin-Token");

  if (env.NODE_ENV === "production") {
    const isAdmin = adminToken === env.ADMIN_API_KEY;

    if (!isAdmin) {
      if (!sig || !ts) return c.json({ error: "missing signature" }, 401);
      const skew = Math.abs(Date.now() / 1000 - Number(ts));
      if (skew > 300) return c.json({ error: "expired" }, 401);
      const ok = await verifyHmac(accountId, ts, sig);
      if (!ok) return c.json({ error: "bad signature" }, 401);
    }
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
