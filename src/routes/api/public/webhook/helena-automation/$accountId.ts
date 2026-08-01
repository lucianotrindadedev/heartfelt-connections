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

        // No CONTACT_TAG_UPDATE real, `content` É o próprio contato: o id do
        // contato vem em content.id e o telefone em content.phonenumber
        // (minúsculo, formato "+55|32991607088"). Payload real validado em
        // 30/07/2026 — sem estas chaves o webhook respondia "no-identifier" e
        // nenhuma automação rodava. Só usamos content.id quando o content
        // aparenta ser um contato (tem telefone/tags), para não confundir com
        // id de mensagem em outros formatos de envelope.
        const contentLooksLikeContact =
          content.phonenumber !== undefined ||
          content.phonenumberFormatted !== undefined ||
          Array.isArray(content.tagsId) ||
          Array.isArray(content.tags);

        // content.id vem ANTES de changeMetadata.id: quando o content é o
        // próprio contato, ele é a fonte certa. O `id` do changeMetadata é
        // genérico (pode ser o id da etiqueta ou do evento de alteração) e, se
        // ganhasse a precedência, buscaríamos um contato inexistente, o load
        // devolveria null e a automação morreria em silêncio com HTTP 200.
        const contactId =
          pick(body, ["contactId", "contact_id"]) ??
          pick(content, ["contactId", "contact_id"]) ??
          (contentLooksLikeContact ? pick(content, ["id"]) : null) ??
          pick(meta, ["contactId", "contact_id", "entityId", "id"]);

        const sessionId =
          pick(body, ["sessionId", "session_id"]) ??
          pick(content, ["sessionId", "session_id"]);

        const phone =
          pick(body, ["phoneNumber", "phone", "telefone"]) ??
          pick(content, ["phoneNumber", "phone", "phonenumber", "phonenumberFormatted"]) ??
          pick(details, ["to", "from"]);

        // Toda entrega é logada. Sem isto o webhook é uma caixa-preta: responde
        // 200 em qualquer cenário e não dá para distinguir "a Helena não
        // entregou o evento" de "entregou e o runner não resolveu o contato" —
        // foi exatamente o que travou o diagnóstico de 01/08/2026.
        const eventType = String(body.eventType ?? body.evento ?? "?");
        console.log(
          `[webhook-automation] recebido acct=${accountId} event=${eventType} ` +
            `keys=[${Object.keys(body).join(",")}] contactId=${contactId ?? "-"} ` +
            `sessionId=${sessionId ?? "-"} phone=${phone ?? "-"}`,
        );

        if (!contactId && !sessionId && !phone) {
          // Sem identificador não há o que processar — responde 200 para a Helena
          // não reentregar indefinidamente.
          console.warn(
            `[webhook-automation] sem identificador — payload=${JSON.stringify(body).slice(0, 600)}`,
          );
          return Response.json({ ok: true, skipped: "no-identifier" });
        }

        try {
          const result = await runTagAutomationsForContact(accountId, {
            contactId,
            sessionId,
            phone,
          });
          console.log(
            `[webhook-automation] resultado acct=${accountId} contato=${result.resolvedContactId ?? "NAO-RESOLVIDO"} ` +
              `avaliadas=${result.evaluated} casaram=${result.matched} executadas=${result.executed} puladas=${result.skipped}`,
          );
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
