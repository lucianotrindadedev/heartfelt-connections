import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { getSelfhost } from "@/integrations/selfhost/client.server";
import { encryptValue, last4 } from "@/lib/crypto.server";

const accountIdInput = z.object({ accountId: z.string().min(1) });

async function ensure(accountId: string) {
  const sb = getSelfhost();
  await sb
    .from("accounts")
    .upsert({ id: accountId, nome: accountId }, { onConflict: "id", ignoreDuplicates: true });
  await sb
    .from("account_secrets")
    .upsert({ account_id: accountId }, { onConflict: "account_id", ignoreDuplicates: true });
}

async function setKey(
  accountId: string,
  field: "openrouter" | "elevenlabs" | "groq" | "evolution",
  apiKey: string
) {
  const sb = getSelfhost();
  await ensure(accountId);
  const enc = await encryptValue(apiKey);
  const patch: Record<string, unknown> = {
    [`${field}_api_key_enc`]: enc,
    [`${field}_last4`]: last4(apiKey),
  };
  const { error } = await sb
    .from("account_secrets")
    .update(patch)
    .eq("account_id", accountId);
  if (error) throw new Error(error.message);
  return { ok: true, last4: last4(apiKey) };
}

export const setOpenRouterKey = createServerFn({ method: "POST" })
  .inputValidator((d) =>
    accountIdInput.extend({ apiKey: z.string().min(10).max(400) }).parse(d)
  )
  .handler(({ data }) => setKey(data.accountId, "openrouter", data.apiKey));

export const setElevenLabsKey = createServerFn({ method: "POST" })
  .inputValidator((d) =>
    accountIdInput.extend({ apiKey: z.string().min(10).max(400) }).parse(d)
  )
  .handler(({ data }) => setKey(data.accountId, "elevenlabs", data.apiKey));

export const setGroqKey = createServerFn({ method: "POST" })
  .inputValidator((d) =>
    accountIdInput.extend({ apiKey: z.string().min(10).max(400) }).parse(d)
  )
  .handler(({ data }) => setKey(data.accountId, "groq", data.apiKey));

export const testOpenRouterKey = createServerFn({ method: "POST" })
  .inputValidator((d) => accountIdInput.parse(d))
  .handler(async ({ data }) => {
    const sb = getSelfhost();
    await ensure(data.accountId);
    const { data: row } = await sb
      .from("account_secrets")
      .select("openrouter_api_key_enc")
      .eq("account_id", data.accountId)
      .single();
    if (!row?.openrouter_api_key_enc) {
      return { ok: false, error: "Sem chave OpenRouter cadastrada." };
    }
    const { decryptValue } = await import("@/lib/crypto.server");
    const key = await decryptValue(row.openrouter_api_key_enc as unknown as string);
    if (!key) return { ok: false, error: "Falha ao descriptografar." };
    try {
      const r = await fetch("https://openrouter.ai/api/v1/key", {
        headers: { Authorization: `Bearer ${key}` },
      });
      if (!r.ok) return { ok: false, error: `OpenRouter ${r.status}` };
      const j = (await r.json()) as { data?: { label?: string; usage?: number; limit?: number | null } };
      return {
        ok: true,
        label: j.data?.label ?? null,
        usage: j.data?.usage ?? 0,
        limit: j.data?.limit ?? null,
      };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : "Falha ao testar" };
    }
  });

export const listOpenRouterModels = createServerFn({ method: "POST" })
  .inputValidator((d) => accountIdInput.parse(d))
  .handler(async ({ data }) => {
    const sb = getSelfhost();
    const { data: row } = await sb
      .from("account_secrets")
      .select("openrouter_api_key_enc")
      .eq("account_id", data.accountId)
      .single();
    if (!row?.openrouter_api_key_enc) return { models: [] as { id: string; name: string }[] };
    const { decryptValue } = await import("@/lib/crypto.server");
    const key = await decryptValue(row.openrouter_api_key_enc as unknown as string);
    const r = await fetch("https://openrouter.ai/api/v1/models", {
      headers: { Authorization: `Bearer ${key}` },
    });
    if (!r.ok) return { models: [] };
    const j = (await r.json()) as { data: { id: string; name: string }[] };
    return { models: (j.data ?? []).map((m) => ({ id: m.id, name: m.name })) };
  });

export const listElevenLabsVoices = createServerFn({ method: "POST" })
  .inputValidator((d) => accountIdInput.parse(d))
  .handler(async ({ data }) => {
    const sb = getSelfhost();
    const { data: row } = await sb
      .from("account_secrets")
      .select("elevenlabs_api_key_enc")
      .eq("account_id", data.accountId)
      .single();
    if (!row?.elevenlabs_api_key_enc) return { voices: [] as { voice_id: string; name: string }[] };
    const { decryptValue } = await import("@/lib/crypto.server");
    const key = await decryptValue(row.elevenlabs_api_key_enc as unknown as string);
    const r = await fetch("https://api.elevenlabs.io/v1/voices", {
      headers: { "xi-api-key": key ?? "" },
    });
    if (!r.ok) return { voices: [] };
    const j = (await r.json()) as { voices: { voice_id: string; name: string }[] };
    return { voices: (j.voices ?? []).map((v) => ({ voice_id: v.voice_id, name: v.name })) };
  });

// ============================================================
// HELENA CRM (token + base URL por conta)
// ============================================================

export const getHelenaConfig = createServerFn({ method: "GET" })
  .inputValidator((d) => accountIdInput.parse(d))
  .handler(async ({ data }) => {
    const sb = getSelfhost();
    const { data: row } = await sb
      .from("accounts")
      .select("helena_base_url, helena_token_enc")
      .eq("id", data.accountId)
      .single();
    return {
      base_url: (row?.helena_base_url as string | null) ?? "",
      token_configured: !!(row?.helena_token_enc),
    };
  });

export const setHelenaConfig = createServerFn({ method: "POST" })
  .inputValidator((d) =>
    accountIdInput
      .extend({
        base_url: z.string().url().optional(),
        token: z.string().min(8).max(500).optional(),
      })
      .parse(d)
  )
  .handler(async ({ data }) => {
    const sb = getSelfhost();
    const patch: Record<string, unknown> = {};
    if (data.base_url !== undefined) patch.helena_base_url = data.base_url;
    if (data.token) {
      patch.helena_token_enc = await encryptValue(data.token);
    }
    if (Object.keys(patch).length === 0) return { ok: true };
    const { error } = await sb
      .from("accounts")
      .update(patch)
      .eq("id", data.accountId);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const getUsageSummary = createServerFn({ method: "POST" })
  .inputValidator((d) => accountIdInput.parse(d))
  .handler(async ({ data }) => {
    const sb = getSelfhost();
    const { data: rows } = await sb
      .from("llm_usage_daily")
      .select("dia,provider,requests,tokens_in,tokens_out,cost_usd")
      .eq("account_id", data.accountId)
      .order("dia", { ascending: false })
      .limit(30);
    return { rows: rows ?? [] };
  });
