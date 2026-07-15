// POST /api/public/cron/monitor-divergencia — audita 2 sinais de agendamento:
//  1) divergência entre a data afirmada ao lead e a agendada (booked_slot_iso);
//  2) slot preso: selected_slot_iso ∉ offered_slots e sem appointment_id (Neymar).
// Chamado pelo pg_cron 1x/dia (ver migrations/0044_monitor_divergencia_cron.sql).
//
// Não altera nada — só lê e emite telemetria. Cada achado vira um evento
// [monitor:telemetry] (mesmo padrão dos guards do scheduler), para casar com os
// dashboards/alertas existentes.
import { createFileRoute } from "@tanstack/react-router";
import { getSelfhost } from "@/integrations/selfhost/client.server";
import {
  scanDivergenciasAgenda,
  scanStaleSlots,
  labelBrt,
} from "@/lib/monitoring/divergencia-agenda.server";

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
        const [resumo, stale] = await Promise.all([
          scanDivergenciasAgenda(sb, windowDays),
          scanStaleSlots(sb, windowDays),
        ]);

        // Telemetria sinal 1 (divergência): resumo + um evento por caso.
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

        // Telemetria sinal 2 (slot preso): resumo + um evento por caso.
        console.warn(
          `[monitor:telemetry] ${JSON.stringify({
            event: "slot_preso_scan",
            window_days: windowDays,
            total_sem_agendamento: stale.total_sem_agendamento,
            stale: stale.stale,
          })}`,
        );
        for (const s of stale.itens) {
          console.warn(
            `[monitor:telemetry] ${JSON.stringify({
              event: "slot_preso",
              conta: s.conta,
              fone: s.fone,
              conv: s.conv,
              stage: s.stage,
              escalation_reason: s.escalation_reason,
              selected: labelBrt(s.selected_iso),
              offered: s.offered_isos.map(labelBrt),
            })}`,
          );
        }

        return Response.json({
          ok: true,
          window_days: windowDays,
          divergencia: {
            resumo: {
              total: resumo.total,
              ok: resumo.ok,
              divergente: resumo.divergente,
              sem_data_no_texto: resumo.sem_data_no_texto,
              sem_iso: resumo.sem_iso,
            },
            casos: resumo.divergencias.map((d) => ({
              conta: d.conta,
              fone: d.fone,
              conv: d.conv,
              agendado: labelBrt(d.agendado_iso),
              afirmado: d.afirmado,
              evidencia: d.evidencia,
            })),
          },
          slot_preso: {
            resumo: {
              total_sem_agendamento: stale.total_sem_agendamento,
              stale: stale.stale,
            },
            casos: stale.itens.map((s) => ({
              conta: s.conta,
              fone: s.fone,
              conv: s.conv,
              stage: s.stage,
              escalation_reason: s.escalation_reason,
              selected: labelBrt(s.selected_iso),
              offered: s.offered_isos.map(labelBrt),
            })),
          },
        });
      },
    },
  },
});
