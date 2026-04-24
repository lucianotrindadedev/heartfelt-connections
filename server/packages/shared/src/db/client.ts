import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { env } from "../env";
import * as schema from "./schema";

console.log(`[db] Inicializando cliente para ${env.DATABASE_URL.split("@")[1]?.split("/")[0] || "unknown host"}`);

const queryClient = postgres(env.DATABASE_URL, {
  max: 20,
  prepare: false,
  onnotice: (notice) => console.log("[db] Notice:", notice.message),
});

export const db = drizzle(queryClient, { schema });

/**
 * Executa fn dentro de uma transação com `SET LOCAL app.account_id = $1`,
 * ativando as RLS policies por tenant.
 */
export async function withTenant<T>(
  accountId: string,
  fn: (tx: typeof db) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (`SET LOCAL app.account_id = '${accountId.replace(/'/g, "''")}'`) as any,
    );
    return fn(tx as unknown as typeof db);
  });
}
