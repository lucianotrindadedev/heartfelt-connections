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
import { extractTagEventIds, payloadShape } from "@/lib/tag-automation-payload";

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

        // Busca PROFUNDA e agnóstica ao envelope. A versão anterior olhava só o
        // primeiro nível e, no ramo `content`, nem aceitava `id` — então o
        // evento "Contato etiqueta alterada" (que manda o contato aninhado)
        // caía em `no-identifier`, respondia 200 e a automação morria calada.
        const { contactId, sessionId, phone } = extractTagEventIds(body);

        if (!contactId && !sessionId && !phone) {
          // Sem identificador não há o que processar — responde 200 para a Helena
          // não reentregar indefinidamente. MAS agora registra o ESQUELETO do
          // payload (só chaves e tipos, sem dado pessoal) para descobrir o
          // formato real do evento em vez de falhar em silêncio.
          console.warn(
            `[webhook-automation:telemetry] ${JSON.stringify({
              event: "tag_event_sem_identificador",
              account: accountId,
              shape: payloadShape(body),
            })}`,
          );
          return Response.json({ ok: true, skipped: "no-identifier" });
        }

        try {
          const result = await runTagAutomationsForContact(accountId, {
            contactId,
            sessionId,
            phone,
          });
          // Telemetria do resultado: sem isso, "avaliou 1 regra e não casou
          // nenhuma" era indistinguível de "executou" — ambos 200 silenciosos.
          console.warn(
            `[webhook-automation:telemetry] ${JSON.stringify({
              event: "tag_event_processado",
              account: accountId,
              via: contactId ? "contactId" : sessionId ? "sessionId" : "phone",
              contato_resolvido: !!result.resolvedContactId,
              avaliadas: result.evaluated,
              casaram: result.matched,
              executadas: result.executed,
              ignoradas: result.skipped,
              detalhes: result.details,
            })}`,
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
