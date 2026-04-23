/**
 * Aplica migrations Drizzle programaticamente.
 * Uso: bun run db:migrate
 */
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("[migrate] DATABASE_URL não configurada");
  process.exit(1);
}

const client = postgres(url, { max: 1, prepare: false });
const db = drizzle(client);

await migrate(db, { migrationsFolder: new URL("./migrations", import.meta.url).pathname });
console.log("[migrate] OK");
await client.end();
process.exit(0);
