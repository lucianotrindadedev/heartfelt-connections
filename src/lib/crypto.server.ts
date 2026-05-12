import { getSelfhost, pgcryptoKey } from "@/integrations/selfhost/client.server";

export async function encryptValue(plain: string): Promise<string> {
  const sb = getSelfhost();
  const { data, error } = await sb.rpc("pgp_sym_encrypt_b64", {
    plain,
    key: pgcryptoKey(),
  });
  if (error) throw new Error(`Falha ao criptografar: ${error.message}`);
  return data as unknown as string;
}

export async function decryptValue(cipherB64: string | null): Promise<string | null> {
  if (!cipherB64) return null;
  const sb = getSelfhost();
  const { data, error } = await sb.rpc("pgp_sym_decrypt_b64", {
    cipher_b64: cipherB64,
    key: pgcryptoKey(),
  });
  if (error) throw new Error(`Falha ao descriptografar: ${error.message}`);
  return data as unknown as string | null;
}

export function last4(s: string): string {
  return s.length <= 4 ? s : s.slice(-4);
}
