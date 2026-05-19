// POST /api/public/webhook/automacoes/fuf-financeiro
// Webhook Helena: quando tag "FUF FINANCEIRO" é adicionada ao contato,
// pausa a IA (adiciona tag "IA Desligada") e registra na conversa.
import { createFileRoute } from "@tanstack/react-router";
import { getSelfhost } from "@/integrations/selfhost/client.server";
import { loadHelenaAccount } from "@/lib/helena.server";

interface HelenaTagPayload {
  evento?: string;
  account_id?: string;
  telefone?: string;
  phone?: string;
  tags?: string[];
  tag?: string;
}

export const Route = createFileRoute("/api/public/webhook/automacoes/fuf-financeiro")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const secret = process.env.CRON_SECRET;
        if (secret && request.headers.get("x-webhook-secret") !== secret) {
          return new Response("Unauthorized", { status: 401 });
        }

        let body: HelenaTagPayload;
        try {
          body = (await request.json()) as HelenaTagPayload;
        } catch {
          return new Response("Invalid JSON", { status: 400 });
        }

        const accountId = body.account_id;
        const phone = (body.telefone ?? body.phone ?? "").toString().trim();

        if (!accountId || !phone) {
          return new Response("Missing account_id or phone", { status: 400 });
        }

        // Verifica se a tag "FUF FINANCEIRO" está presente no evento
        const allTags = [
          ...(body.tags ?? []),
          ...(body.tag ? [body.tag] : []),
        ].map((t) => t.toUpperCase());

        if (!allTags.includes("FUF FINANCEIRO")) {
          return Response.json({ ok: true, skipped: true, reason: "tag_not_fuf_financeiro" });
        }

        const sb = getSelfhost();

        try {
          const helena = await loadHelenaAccount(accountId);
          const baseUrl = helena.baseUrl.replace(/\/$/, "");

          // Adiciona tag "IA Desligada" (pausa a IA)
          const tagRes = await fetch(`${baseUrl}/v1/contacts/tags`, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${helena.token}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              id_conta: helena.id,
              telefone: phone,
              tags: ["IA Desligada"],
              action: "add",
            }),
          });

          // Pausa o agente na conversa (atualiza conversation_state)
          const { data: agentData } = await sb
            .from("agents")
            .select("id")
            .eq("account_id", accountId)
            .single();

          if (agentData) {
            const { data: conv } = await sb
              .from("conversations")
              .select("id")
              .eq("agent_id", agentData.id)
              .eq("phone", phone)
              .maybeSingle();

            if (conv) {
              await sb
                .from("conversation_state")
                .upsert(
                  {
                    conversation_id: conv.id,
                    aguardando_followup: false,
                  },
                  { onConflict: "conversation_id" },
                );
            }
          }

          return Response.json({ ok: true, phone, tag_ok: tagRes.ok });
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          console.error("[fuf-financeiro] erro:", e);
          return new Response(`Erro: ${msg}`, { status: 500 });
        }
      },
    },
  },
});
