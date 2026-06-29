// Webhook DEDICADO às automações de etiqueta do CRM Helena.
// POST /api/public/webhook/helena-automation/$accountId
//
// Separado do webhook principal (mensagens) de propósito: o usuário registra
// ESTA url no CRM Helena para o evento de alteração de contato/etiqueta. A cada
// disparo, recarregamos as tags atuais do contato e executamos as regras
// configuradas (ver runTagAutomationsForContact).
import { createFileRoute } from "@tanstack/react-router";
import { getSelfhost } from "@/integrations/selfhost/client.server";
import { runTagAutomationsForContact } from "@/lib/tag-automations.server";

/** Procura recursivamente (raso) por um campo de identificação no payload. */
function pick(obj: Record<string, unknown>, keys: string[]): string | null {
  for (const k of keys) {
    const v = obj[k];
    if (v !== undefined && v !== null && String(v).trim() !== "") return String(v);
  }
  return null;
}

export const Route = createFileRoute("/api/public/webhook/helena-automation/$accountId")({
  server: {
    handlers: {
      POST: async ({ request, params }) => {
        const accountId = params.accountId;
        const sb = getSelfhost();

        const accountRow = await sb
          .from("accounts")
          .select("id")
          .eq("id", accountId)
          .maybeSingle();
        if (!accountRow.data) {
          return new Response("Account not found", { status: 404 });
        }

        let body: Record<string, unknown>;
        try {
          body = (await request.json()) as Record<string, unknown>;
        } catch {
          return new Response("Invalid JSON", { status: 400 });
        }

        // A Helena varia o envelope: { content: {...} }, { changeMetadata: {...} }
        // ou os campos na raiz. Procuramos identificadores em todos eles.
        const content = (body.content as Record<string, unknown> | undefined) ?? {};
        const meta = (body.changeMetadata as Record<string, unknown> | undefined) ?? {};
        const details = (content.details as Record<string, unknown> | undefined) ?? {};

        const contactId =
          pick(body, ["contactId", "contact_id"]) ??
          pick(content, ["contactId", "contact_id"]) ??
          pick(meta, ["contactId", "contact_id", "entityId", "id"]);

        const sessionId =
          pick(body, ["sessionId", "session_id"]) ??
          pick(content, ["sessionId", "session_id"]);

        const phone =
          pick(body, ["phoneNumber", "phone", "telefone"]) ??
          pick(content, ["phoneNumber", "phone"]) ??
          pick(details, ["to", "from"]);

        if (!contactId && !sessionId && !phone) {
          // Sem identificador não há o que processar — responde 200 para a Helena
          // não reentregar indefinidamente.
          return Response.json({ ok: true, skipped: "no-identifier" });
        }

        try {
          const result = await runTagAutomationsForContact(accountId, {
            contactId,
            sessionId,
            phone,
          });
          return Response.json({ ok: true, ...result });
        } catch (e) {
          console.error("[webhook-automation] erro:", e instanceof Error ? e.message : e);
          // 200 mesmo em erro: dedupe/idempotência fica a cargo do runner.
          return Response.json({ ok: false, error: "internal" });
        }
      },
    },
  },
});
