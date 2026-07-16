// POST /api/public/cron/monitor-integracoes — verifica se as integrações de
// agenda ATIVAS (Google Calendar, Clinicorp, Clinic Experts) ainda respondem.
// Chamado pelo pg_cron (ver migrations/0045_monitor_integracoes_cron.sql).
//
// Não altera nada — só lê e emite telemetria. Cada integração quebrada vira um
// evento [monitor:telemetry] event="integracao_agenda_quebrada" (mesmo padrão do
// monitor-divergencia), para casar com os dashboards/alertas existentes.
//
// Motivo: um refresh_token do Google morre em silêncio e o agente só descobre
// quando um lead pede horário — sem aviso a ninguém (2 contas assim em 16/07).
import { createFileRoute } from "@tanstack/react-router";
import { getSelfhost } from "@/integrations/selfhost/client.server";
import { scanIntegracoesAgenda } from "@/lib/monitoring/integracoes-agenda.server";

function validateCronSecret(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  return request.headers.get("x-cron-secret") === secret;
}

export const Route = createFileRoute("/api/public/cron/monitor-integracoes")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        if (!validateCronSecret(request)) {
          return new Response("Unauthorized", { status: 401 });
        }

        const sb = getSelfhost();
        const resumo = await scanIntegracoesAgenda(sb);

        console.warn(
          `[monitor:telemetry] ${JSON.stringify({
            event: "integracoes_agenda_scan",
            total: resumo.total,
            ok: resumo.ok,
            quebradas: resumo.quebradas,
          })}`,
        );
        for (const s of resumo.status.filter((x) => !x.ok)) {
          console.error(
            `[monitor:telemetry] ${JSON.stringify({
              event: "integracao_agenda_quebrada",
              conta: s.conta,
              provedor: s.provedor,
              erro: s.erro,
            })}`,
          );
        }

        return Response.json({
          ok: true,
          resumo: { total: resumo.total, ok: resumo.ok, quebradas: resumo.quebradas },
          quebradas: resumo.status.filter((s) => !s.ok),
        });
      },
    },
  },
});
