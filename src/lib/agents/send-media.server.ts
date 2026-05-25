// Helper para o agente enviar mídia durante o atendimento via Helena CRM.
// O LLM chama a tool `enviar_midia` com `slug` — o servidor resolve o file_url
// e envia para a Helena com text opcional.

import { getSelfhost } from "@/integrations/selfhost/client.server";
import { loadHelenaAccount, sendHelenaMediaUrl } from "@/lib/helena.server";
import type { AgentContext } from "./context";

export interface SendMediaResult {
  ok: boolean;
  media_title?: string;
  error?: string;
}

export async function sendMediaBySlug(
  ctx: AgentContext,
  slug: string,
  caption?: string,
): Promise<SendMediaResult> {
  if (ctx.dryRun) {
    return { ok: true, media_title: `(dry-run: mídia ${slug})` };
  }
  const sb = getSelfhost();

  // 1. Carrega mídia pelo slug
  const row = await sb
    .from("agent_media")
    .select("id, slug, title, file_url, mime_type, media_type")
    .eq("agent_id", ctx.agentId)
    .eq("slug", slug)
    .maybeSingle();

  if (!row.data) {
    return { ok: false, error: `Mídia "${slug}" não encontrada na base do agente.` };
  }
  const media = row.data as { id: string; title: string; file_url: string; media_type: string };

  if (!ctx.sessionId) {
    return { ok: false, error: "sessionId ausente — não dá para enviar mídia." };
  }

  // 2. Envia via Helena
  try {
    const helena = await loadHelenaAccount(ctx.accountId);
    const sendRes = await sendHelenaMediaUrl(helena, {
      sessionId: ctx.sessionId,
      fileUrl: media.file_url,
      text: caption,
    });
    if (!sendRes.ok) {
      await sb.from("agent_media_sends").insert({
        media_id: media.id,
        conversation_id: ctx.conversationId,
        agent_id: ctx.agentId,
        status: "failed",
        error: `Helena ${sendRes.status}: ${sendRes.body.slice(0, 200)}`,
        caption: caption ?? null,
      });
      return { ok: false, error: `Helena rejeitou: ${sendRes.status}` };
    }

    await sb.from("agent_media_sends").insert({
      media_id: media.id,
      conversation_id: ctx.conversationId,
      agent_id: ctx.agentId,
      status: "sent",
      caption: caption ?? null,
    });

    return { ok: true, media_title: media.title };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: msg.slice(0, 200) };
  }
}

/**
 * Lista mídias disponíveis para injetar no system prompt do LLM.
 * Cada item vira uma linha no contexto: `- slug: title (descricao)`.
 */
export async function getAvailableMediaForPrompt(
  agentId: string,
): Promise<string> {
  const sb = getSelfhost();
  const res = await sb
    .from("agent_media")
    .select("slug, title, description, media_type")
    .eq("agent_id", agentId)
    .order("criado_em", { ascending: false });
  const items = res.data ?? [];
  if (items.length === 0) return "";

  const lines = ["# 📎 MÍDIAS DISPONÍVEIS\n"];
  lines.push(
    "Você pode chamar a tool `enviar_midia(slug, caption?)` para enviar uma das mídias abaixo durante a conversa. Use apenas quando fizer sentido no contexto (ex: enviar antes/depois ao falar de um caso, vídeo de localização ao confirmar agendamento). `caption` é uma legenda opcional que acompanha o arquivo.\n",
  );
  for (const m of items) {
    const desc = m.description ? ` — ${m.description}` : "";
    lines.push(`- \`${m.slug}\` (${m.media_type}): ${m.title}${desc}`);
  }
  return lines.join("\n");
}
