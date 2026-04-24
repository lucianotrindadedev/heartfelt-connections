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
console.log(`[migrate] Iniciando conexão com ${url.split("@")[1] || "unknown host"}`);

const client = postgres(url, { 
  max: 1, 
  prepare: false,
  connect_timeout: 10, // 10 seconds timeout
});

const db = drizzle(client);

try {
  console.log("[migrate] Aplicando migrations...");
  await migrate(db, { migrationsFolder: new URL("./migrations", import.meta.url).pathname });
  console.log("[migrate] OK - Migrations aplicadas com sucesso");
} catch (error) {
  console.error("[migrate] ERRO CRÍTICO ao aplicar migrations:", error);
  process.exit(1);
} finally {
  await client.end();
}
process.exit(0);
