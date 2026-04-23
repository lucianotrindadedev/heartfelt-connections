import { sql } from "drizzle-orm";
import { env } from "./env";

/**
 * Encripta um JSON com pgp_sym_encrypt usando PGCRYPTO_KEY.
 * Use com Drizzle: `config_enc: encrypt(JSON.stringify(cfg))`.
 */
export const encrypt = (plaintext: string) =>
  sql`pgp_sym_encrypt(${plaintext}::text, ${env.PGCRYPTO_KEY})`;

export const decrypt = (column: unknown) =>
  sql`pgp_sym_decrypt(${column}::bytea, ${env.PGCRYPTO_KEY})`;
