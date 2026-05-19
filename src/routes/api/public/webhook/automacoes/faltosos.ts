// POST /api/public/webhook/automacoes/faltosos
// Webhook recebendo notificação do Clinicorp quando um paciente falta.
// Remove tags "IA Agendou"/"CRC Agendou" e adiciona tag "FALTOSOS".
import { createFileRoute } from "@tanstack/react-router";
import { getSelfhost } from "@/integrations/selfhost/client.server";
import { loadHelenaAccount } from "@/lib/helena.server";

interface FaltososPayload {
  account_id?: string;
  subscriber_id?: string;
  phone?: string;
  telefone?: string;
  appointment_id?: string | number;
  status?: string;
  patient_name?: string;
}

export const Route = createFileRoute("/api/public/webhook/automacoes/faltosos")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const secret = process.env.CRON_SECRET;
        if (secret && request.headers.get("x-webhook-secret") !== secret) {
          return new Response("Unauthorized", { status: 401 });
        }

        let body: FaltososPayload;
        try {
          body = (await request.json()) as FaltososPayload;
        } catch {
          return new Response("Invalid JSON", { status: 400 });
        }

        const accountId = body.account_id;
        const phone = (body.phone ?? body.telefone ?? "").toString().trim();
        const status = (body.status ?? "").toLowerCase();

        if (!accountId || !phone) {
          return new Response("Missing account_id or phone", { status: 400 });
        }

        // Só processa se status for "faltou" ou equivalente
        if (!status.includes("falto") && !status.includes("missed") && !status.includes("no_show")) {
          return Response.json({ ok: true, skipped: true, reason: "status_not_faltou" });
        }

        const sb = getSelfhost();

        try {
          const helena = await loadHelenaAccount(accountId);
          const baseUrl = helena.baseUrl.replace(/\/$/, "");

          // Remove tags "IA Agendou" e "CRC Agendou"
          const removeRes = await fetch(`${baseUrl}/v1/contacts/tags`, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${helena.token}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              id_conta: helena.id,
              telefone: phone,
              tags: ["IA Agendou", "CRC Agendou"],
              action: "remove",
            }),
          });

          // Adiciona tag "FALTOSOS"
          const addRes = await fetch(`${baseUrl}/v1/contacts/tags`, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${helena.token}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              id_conta: helena.id,
              telefone: phone,
              tags: ["FALTOSOS"],
              action: "add",
            }),
          });

          return Response.json({
            ok: true,
            phone,
            remove_ok: removeRes.ok,
            add_ok: addRes.ok,
          });
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          console.error("[faltosos] erro:", e);
          return new Response(`Erro: ${msg}`, { status: 500 });
        }
      },
    },
  },
});
