import { Hono } from "hono";
import { eq, asc } from "drizzle-orm";
import { requireSession } from "../middleware/auth";
import { db, messages, conversations, agents } from "@sarai/shared";

export const conversationsRoute = new Hono<{ Variables: { accountId: string } }>();
conversationsRoute.use("*", requireSession);

/* ── GET /:id/messages ──────────────────────────────────────── */
conversationsRoute.get("/:id/messages", async (c) => {
  const id = c.req.param("id");
  const accountId = c.get("accountId");

  // Validate conversation exists and belongs to the account via agent
  const [conversation] = await db
    .select({
      id: conversations.id,
      accountId: agents.accountId,
    })
    .from(conversations)
    .innerJoin(agents, eq(conversations.agentId, agents.id))
    .where(eq(conversations.id, id))
    .limit(1);

  if (!conversation) return c.json({ error: "not_found" }, 404);
  if (conversation.accountId !== accountId)
    return c.json({ error: "forbidden" }, 403);

  const rows = await db
    .select()
    .from(messages)
    .where(eq(messages.conversationId, id))
    .orderBy(asc(messages.createdAt));

  return c.json(rows);
});
