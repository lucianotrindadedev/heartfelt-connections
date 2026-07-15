// POST /api/public/cron/monitor-divergencia — audita divergências entre a data
// afirmada ao lead no texto e a data efetivamente agendada (booked_slot_iso).
// Chamado pelo pg_cron 1x/dia (ver migrations/0044_monitor_divergencia_cron.sql).
//
// Não altera nada — só lê e emite telemetria. Cada divergência vira um evento
// [monitor:telemetry] event="divergencia_agenda" (mesmo padrão dos guards do
// scheduler), para casar com os dashboards/alertas existentes.
import { createFileRoute } from "@tanstack/react-router";
import { getSelfhost } from "@/integrations/selfhost/client.server";
import { scanDivergenciasAgenda, labelBrt } from "@/lib/monitoring/divergencia-agenda.server";

function validateCronSecret(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  return request.headers.get("x-cron-secret") === secret;
}

export const Route = createFileRoute("/api/public/cron/monitor-divergencia")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        if (!validateCronSecret(request)) {
          return new Response("Unauthorized", { status: 401 });
        }

        // Janela: por padrão 3 dias (cobre atrasos de no-show/remarcação sem
        // varrer a base toda todo dia). Sobrescreve com body { window_days }.
        let windowDays = 3;
        try {
          const body = (await request.json()) as { window_days?: number };
          if (typeof body?.window_days === "number" && body.window_days > 0) {
            windowDays = body.window_days;
          }
        } catch {
          // body vazio → mantém o default
        }

        const sb = getSelfhost();
        const resumo = await scanDivergenciasAgenda(sb, windowDays);

        // Telemetria: um evento-resumo + um por divergência (para alerta/triagem).
        console.warn(
          `[monitor:telemetry] ${JSON.stringify({
            event: "divergencia_agenda_scan",
            window_days: windowDays,
            total: resumo.total,
            ok: resumo.ok,
            divergente: resumo.divergente,
            sem_data_no_texto: resumo.sem_data_no_texto,
          })}`,
        );
        for (const d of resumo.divergencias) {
          console.warn(
            `[monitor:telemetry] ${JSON.stringify({
              event: "divergencia_agenda",
              conta: d.conta,
              fone: d.fone,
              conv: d.conv,
              agendado: labelBrt(d.agendado_iso),
              afirmado: d.afirmado,
              evidencia: d.evidencia,
            })}`,
          );
        }

        return Response.json({
          ok: true,
          window_days: windowDays,
          resumo: {
            total: resumo.total,
            ok: resumo.ok,
            divergente: resumo.divergente,
            sem_data_no_texto: resumo.sem_data_no_texto,
            sem_iso: resumo.sem_iso,
          },
          divergencias: resumo.divergencias.map((d) => ({
            conta: d.conta,
            fone: d.fone,
            conv: d.conv,
            agendado: labelBrt(d.agendado_iso),
            afirmado: d.afirmado,
            evidencia: d.evidencia,
          })),
        });
      },
    },
  },
});
