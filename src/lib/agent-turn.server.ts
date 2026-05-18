// Executa um turno do agente: lê histórico, chama OpenRouter, persiste resposta
// e envia via Helena. Server-only.
import { getSelfhost } from "@/integrations/selfhost/client.server";
import { decryptValue } from "@/lib/crypto.server";
import { loadHelenaAccount, sendHelenaText } from "@/lib/helena.server";

const MAX_TURNS = 50;
const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

interface MsgRow {
  role: string;
  content: string;
  meta: Record<string, unknown> | null;
}

export async function runAgentTurn(conversationId: string): Promise<void> {
  const sb = getSelfhost();

  // 1. Carrega contexto (conversa, agente, conta, config)
  const conv = await sb
    .from("conversations")
    .select("id, phone, helena_session_id, agent_id")
    .eq("id", conversationId)
    .single();
  if (conv.error || !conv.data) throw new Error("Conversa não encontrada");

  const agent = await sb
    .from("agents")
    .select("id, account_id, ativo, system_prompt, llm_model_override")
    .eq("id", conv.data.agent_id)
    .single();
  if (agent.error || !agent.data) throw new Error("Agente não encontrado");
  if (!agent.data.ativo) return; // pausado

  const accountId = agent.data.account_id as string;

  const llm = await sb
    .from("account_llm_config")
    .select("default_model, max_tokens, temperature")
    .eq("account_id", accountId)
    .single();

  const secrets = await sb
    .from("account_secrets")
    .select("openrouter_api_key_enc")
    .eq("account_id", accountId)
    .single();
  if (!secrets.data?.openrouter_api_key_enc) {
    console.warn(`[agent] Sem chave OpenRouter para ${accountId}`);
    return;
  }
  const orKey = await decryptValue(secrets.data.openrouter_api_key_enc as unknown as string);
  if (!orKey) throw new Error("Falha ao descriptografar OpenRouter key");

  // 2. Lock + estado
  await sb
    .from("conversation_state")
    .upsert(
      { conversation_id: conversationId, lock_conversa: true },
      { onConflict: "conversation_id" },
    );

  try {
    // 3. Últimas N mensagens em ordem cronológica (mais antigas primeiro)
    const msgs = await sb
      .from("messages")
      .select("role, content, meta")
      .eq("conversation_id", conversationId)
      .order("criado_em", { ascending: false })
      .limit(MAX_TURNS);
    if (msgs.error) throw new Error(msgs.error.message);
    const ordered = (msgs.data ?? []).slice().reverse() as MsgRow[];

    const messages: { role: "system" | "user" | "assistant"; content: string }[] = [];
    const systemPrompt = (agent.data.system_prompt as string) || "Você é um assistente prestativo.";
    messages.push({ role: "system", content: systemPrompt });
    for (const m of ordered) {
      if (m.role === "user") messages.push({ role: "user", content: m.content });
      else if (m.role === "assistant") messages.push({ role: "assistant", content: m.content });
    }

    const model =
      (agent.data.llm_model_override as string | null) ||
      (llm.data?.default_model as string | undefined) ||
      "x-ai/grok-4-fast";

    // 4. Chama OpenRouter
    const t0 = Date.now();
    const orRes = await fetch(OPENROUTER_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${orKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        messages,
        max_tokens: llm.data?.max_tokens ?? 1024,
        temperature: llm.data?.temperature ?? 0.7,
      }),
    });
    const latency = Date.now() - t0;

    if (!orRes.ok) {
      const errBody = await orRes.text();
      await sb.from("agent_runs").insert({
        account_id: accountId,
        agent_id: agent.data.id,
        conversation_id: conversationId,
        provider: "openrouter",
        model,
        latency_ms: latency,
        error: `${orRes.status}: ${errBody.slice(0, 500)}`,
      });
      throw new Error(`OpenRouter ${orRes.status}: ${errBody.slice(0, 200)}`);
    }

    const orJson = (await orRes.json()) as {
      choices?: { message?: { content?: string } }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const reply = orJson.choices?.[0]?.message?.content?.trim() ?? "";
    if (!reply) throw new Error("OpenRouter retornou resposta vazia");

    await sb.from("agent_runs").insert({
      account_id: accountId,
      agent_id: agent.data.id,
      conversation_id: conversationId,
      provider: "openrouter",
      model,
      latency_ms: latency,
      tokens_in: orJson.usage?.prompt_tokens ?? 0,
      tokens_out: orJson.usage?.completion_tokens ?? 0,
    });

    // 5. Persiste resposta
    await sb.from("messages").insert({
      conversation_id: conversationId,
      role: "assistant",
      content: reply,
      meta: { origem: "agente", model },
    });

    // 6. Envia via Helena
    try {
      const helena = await loadHelenaAccount(accountId);
      const send = await sendHelenaText(helena, {
        phone: conv.data.phone as string,
        text: reply,
        sessionId: (conv.data.helena_session_id as string | null) ?? undefined,
      });
      if (!send.ok) {
        console.error(`[helena] envio falhou ${send.status}: ${send.body.slice(0, 200)}`);
      }
    } catch (e) {
      console.error("[helena] erro ao enviar:", e);
    }
  } finally {
    await sb
      .from("conversation_state")
      .upsert(
        { conversation_id: conversationId, lock_conversa: false },
        { onConflict: "conversation_id" },
      );
  }
}
