import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { getSelfhost } from "@/integrations/selfhost/client.server";

const accountIdInput = z.object({ accountId: z.string().min(1) });

/**
 * Verifica se a conta existe (sem auto-provisionar).
 * Se existir mas faltar agent / linhas filhas, cria-as.
 * Retorna `null` se a conta NÃO está cadastrada (em vez de lançar erro,
 * para que o cliente possa exibir a tela "Agente não disponível" sem
 * disparar o error boundary do TanStack Router).
 */
async function ensureAccount(accountId: string): Promise<string | null> {
  const sb = getSelfhost();

  // 1. Verifica se a conta existe — NÃO cria automaticamente
  const { data: accountRow } = await sb
    .from("accounts")
    .select("id")
    .eq("id", accountId)
    .maybeSingle();
  if (!accountRow) return null;

  // 2. Conta existe — garante o agent e as linhas filhas (retrocompat)
  const { data: existing } = await sb
    .from("agents")
    .select("id")
    .eq("account_id", accountId)
    .maybeSingle();
  let agentId = existing?.id as string | undefined;
  if (!agentId) {
    const { data: created, error } = await sb
      .from("agents")
      .insert({ account_id: accountId })
      .select("id")
      .single();
    if (error) throw new Error(error.message);
    agentId = created!.id as string;
    await Promise.all([
      sb.from("agent_followup").insert({ agent_id: agentId }),
      sb.from("agent_warmup").insert({ agent_id: agentId }),
      sb.from("agent_audio").insert({ agent_id: agentId }),
      sb.from("agent_escalation").insert({ agent_id: agentId }),
      sb.from("channels_whatsapp").insert({ agent_id: agentId }),
      sb.from("webchat_config").insert({ agent_id: agentId }),
      sb.from("account_secrets").insert({ account_id: accountId }),
      sb.from("account_llm_config").insert({ account_id: accountId }),
      sb.from("account_voice_config").insert({ account_id: accountId }),
    ]);
  }
  return agentId;
}

/**
 * Variante que lança quando a conta não existe.
 * Usada por mutations (update*, reset*) — nesse caso o cliente envia uma
 * mutação, que naturalmente esperaria um erro, e o `mutate` consegue tratar.
 */
async function ensureAccountOrThrow(accountId: string): Promise<string> {
  const id = await ensureAccount(accountId);
  if (!id) throw new Error("Conta não cadastrada na plataforma");
  return id;
}

export const getAgent = createServerFn({ method: "GET" })
  .inputValidator((d) => accountIdInput.parse(d))
  .handler(async ({ data }) => {
    const sb = getSelfhost();
    const agentId = await ensureAccount(data.accountId);

    // Conta não cadastrada: retorna flag dedicada — não lança para evitar
    // disparar o error boundary do TanStack Router.
    if (!agentId) {
      return { registered: false as const };
    }

    const [agent, llm, voice, audio, wa, fu, wu, secrets, clinicorp, clinup, gcal] = await Promise.all([
      sb.from("agents").select("*").eq("id", agentId).single(),
      sb.from("account_llm_config").select("*").eq("account_id", data.accountId).single(),
      sb.from("account_voice_config").select("*").eq("account_id", data.accountId).single(),
      sb.from("agent_audio").select("*").eq("agent_id", agentId).single(),
      sb.from("channels_whatsapp").select("*").eq("agent_id", agentId).single(),
      sb.from("agent_followup").select("*").eq("agent_id", agentId).single(),
      sb.from("agent_warmup").select("*").eq("agent_id", agentId).single(),
      sb
        .from("account_secrets")
        .select("openrouter_last4,elevenlabs_last4,groq_last4,evolution_last4,atualizado_em")
        .eq("account_id", data.accountId)
        .single(),
      sb.from("clinicorp_config").select("ativo").eq("account_id", data.accountId).maybeSingle(),
      sb.from("clinup_config").select("ativo").eq("account_id", data.accountId).maybeSingle(),
      sb.from("google_calendar_tokens").select("ativo").eq("account_id", data.accountId).maybeSingle(),
    ]);
    return {
      registered: true as const,
      agent: agent.data,
      llm: llm.data,
      voice: voice.data,
      audio: audio.data,
      whatsapp: wa.data,
      followup: fu.data,
      warmup: wu.data,
      secrets: secrets.data,
      /** Quais integrações estão configuradas (independente de ativo=true/false). */
      configured_integrations: {
        clinicorp: !!clinicorp.data,
        clinup: !!clinup.data,
        google_calendar: !!gcal.data,
      },
    };
  });

export const updateAgent = createServerFn({ method: "POST" })
  .inputValidator((d) =>
    accountIdInput
      .extend({
        nome: z.string().min(1).max(120).optional(),
        ativo: z.boolean().optional(),
        system_prompt: z.string().max(100000).optional(),
        llm_model_override: z.string().max(120).nullable().optional(),
        debounce_segundos: z.number().int().min(0).max(120).optional(),
        settings: z.record(z.string(), z.string()).optional(),
      })
      .parse(d)
  )
  .handler(async ({ data }) => {
    const sb = getSelfhost();
    const agentId = await ensureAccountOrThrow(data.accountId);
    const patch: Record<string, unknown> = {};
    if (data.nome !== undefined) patch.nome = data.nome;
    if (data.ativo !== undefined) patch.ativo = data.ativo;
    if (data.system_prompt !== undefined) patch.system_prompt = data.system_prompt;
    if (data.llm_model_override !== undefined) patch.llm_model_override = data.llm_model_override;
    if (data.debounce_segundos !== undefined) patch.debounce_segundos = data.debounce_segundos;
    if (data.settings !== undefined) patch.settings = data.settings;
    if (Object.keys(patch).length === 0) return { ok: true };
    const { error } = await sb.from("agents").update(patch).eq("id", agentId);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

// Merge-update only specific settings keys (safe partial update)
export const mergeAgentSettings = createServerFn({ method: "POST" })
  .inputValidator((d) =>
    accountIdInput
      .extend({ settings: z.record(z.string(), z.string()) })
      .parse(d)
  )
  .handler(async ({ data }) => {
    const sb = getSelfhost();
    const agentId = await ensureAccountOrThrow(data.accountId);
    // Use jsonb || operator to merge without overwriting unrelated keys
    const { error } = await sb.rpc("merge_agent_settings", {
      p_agent_id: agentId,
      p_patch: data.settings,
    });
    if (error) {
      // Fallback: read current settings, merge, write back
      const { data: cur } = await sb.from("agents").select("settings").eq("id", agentId).single();
      const merged = { ...(cur?.settings as Record<string, string> ?? {}), ...data.settings };
      const { error: e2 } = await sb.from("agents").update({ settings: merged }).eq("id", agentId);
      if (e2) throw new Error(e2.message);
    }
    return { ok: true };
  });

export const updateLlmConfig = createServerFn({ method: "POST" })
  .inputValidator((d) =>
    accountIdInput
      .extend({
        default_model: z.string().min(1).max(120).optional(),
        max_tokens: z.number().int().min(64).max(8192).optional(),
        temperature: z.number().min(0).max(2).optional(),
      })
      .parse(d)
  )
  .handler(async ({ data }) => {
    const sb = getSelfhost();
    await ensureAccountOrThrow(data.accountId);
    const { accountId, ...patch } = data;
    if (Object.keys(patch).length === 0) return { ok: true };
    const { error } = await sb
      .from("account_llm_config")
      .update(patch)
      .eq("account_id", accountId);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const updateVoiceConfig = createServerFn({ method: "POST" })
  .inputValidator((d) =>
    accountIdInput
      .extend({
        elevenlabs_voice_id: z.string().max(120).nullable().optional(),
        model_id: z.string().max(120).optional(),
        stability: z.number().min(0).max(1).optional(),
        similarity: z.number().min(0).max(1).optional(),
      })
      .parse(d)
  )
  .handler(async ({ data }) => {
    const sb = getSelfhost();
    await ensureAccountOrThrow(data.accountId);
    const { accountId, ...patch } = data;
    if (Object.keys(patch).length === 0) return { ok: true };
    const { error } = await sb
      .from("account_voice_config")
      .update(patch)
      .eq("account_id", accountId);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const updateAudio = createServerFn({ method: "POST" })
  .inputValidator((d) =>
    accountIdInput
      .extend({
        habilitado: z.boolean().optional(),
        transcrever_in: z.boolean().optional(),
        responder_out: z.boolean().optional(),
      })
      .parse(d)
  )
  .handler(async ({ data }) => {
    const sb = getSelfhost();
    const agentId = await ensureAccountOrThrow(data.accountId);
    const { accountId: _a, ...patch } = data;
    if (Object.keys(patch).length === 0) return { ok: true };
    const { error } = await sb.from("agent_audio").update(patch).eq("agent_id", agentId);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const resetWebhookSecret = createServerFn({ method: "POST" })
  .inputValidator((d) => accountIdInput.parse(d))
  .handler(async ({ data }) => {
    const sb = getSelfhost();
    const agentId = await ensureAccountOrThrow(data.accountId);
    const newSecret =
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? (crypto as Crypto).randomUUID().replace(/-/g, "") +
          (crypto as Crypto).randomUUID().replace(/-/g, "")
        : Math.random().toString(36).slice(2);
    const { error } = await sb
      .from("agents")
      .update({ webhook_secret: newSecret })
      .eq("id", agentId);
    if (error) throw new Error(error.message);
    return { webhook_secret: newSecret };
  });
