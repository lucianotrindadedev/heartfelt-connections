// POST /api/public/cron/monitor-saldo — lê o saldo da OpenRouter de cada conta
// e avisa o grupo de notificações quando está abaixo do limite (padrão US$ 2).
// Chamado pelo pg_cron (ver migrations/0051_monitor_saldo_cron.sql).
//
// Preventivo: o corte por saldo zerado (credits.server.ts) só age depois que
// algum lead já ficou sem resposta automática. Aqui o aviso chega antes disso.
import { createFileRoute } from "@tanstack/react-router";
import { getSelfhost } from "@/integrations/selfhost/client.server";
import { scanSaldoOpenRouter } from "@/lib/monitoring/openrouter-saldo.server";

function validateCronSecret(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  return request.headers.get("x-cron-secret") === secret;
}

export const Route = createFileRoute("/api/public/cron/monitor-saldo")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        if (!validateCronSecret(request)) {
          return new Response("Unauthorized", { status: 401 });
        }

        const sb = getSelfhost();
        const resumo = await scanSaldoOpenRouter(sb);

        console.warn(
          `[monitor:telemetry] ${JSON.stringify({
            event: "openrouter_saldo_scan",
            total: resumo.total,
            baixos: resumo.baixos,
            ilegiveis: resumo.ilegiveis,
            limite_usd: resumo.limiteUsd,
          })}`,
        );
        for (const s of resumo.status.filter((x) => x.baixo)) {
          console.error(
            `[monitor:telemetry] ${JSON.stringify({
              event: "openrouter_saldo_baixo",
              conta: s.conta,
              saldo_usd: s.saldoUsd,
              limite_usd: resumo.limiteUsd,
              alertado: s.alertado,
            })}`,
          );
        }

        return Response.json({
          ok: true,
          resumo: {
            total: resumo.total,
            baixos: resumo.baixos,
            ilegiveis: resumo.ilegiveis,
            limite_usd: resumo.limiteUsd,
          },
          baixos: resumo.status.filter((s) => s.baixo),
        });
      },
    },
  },
});
