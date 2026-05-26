// GET /api/public/diag/gcal-slots?secret=...&account_id=...&days=7
//
// Diagnóstico de janelas do Google Calendar para uma conta:
//   - mostra a config (calendar_id, business_hours_json, duracao)
//   - chama listGoogleCalendarSlots com os mesmos parâmetros do scheduler
//   - retorna contagem de candidates / dentro_expediente / sem_conflito
//   - inclui amostra dos primeiros 10 slots
//
// Útil pra debugar "0 slots disponíveis" sem precisar SSH no servidor.

import { createFileRoute } from "@tanstack/react-router";
import { getSelfhost } from "@/integrations/selfhost/client.server";
import { listGoogleCalendarSlots } from "@/lib/tools/google-calendar.server";

function validateSecret(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const url = new URL(request.url);
  return (
    request.headers.get("x-cron-secret") === secret ||
    url.searchParams.get("secret") === secret
  );
}

export const Route = createFileRoute("/api/public/diag/gcal-slots")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        if (!validateSecret(request)) {
          return new Response("Unauthorized", { status: 401 });
        }
        const url = new URL(request.url);
        const accountId = url.searchParams.get("account_id");
        const days = Number(url.searchParams.get("days") ?? "7");
        if (!accountId) {
          return Response.json({ ok: false, error: "account_id obrigatorio" }, { status: 400 });
        }

        const sb = getSelfhost();
        const [agent, gcal] = await Promise.all([
          sb
            .from("agents")
            .select("id, settings")
            .eq("account_id", accountId)
            .maybeSingle(),
          sb
            .from("google_calendar_tokens")
            .select("calendar_id, calendar_name, email, ativo, expires_at")
            .eq("account_id", accountId)
            .maybeSingle(),
        ]);

        if (!gcal.data) {
          return Response.json({
            ok: false,
            error: "Google Calendar não conectado para essa conta.",
            calendar_token_exists: false,
          });
        }

        const settings = (agent.data?.settings as Record<string, string> | null) ?? {};
        const duracao = Number(settings.duracao_consulta_minutos ?? "40") || 40;
        const businessHoursJson = settings.business_hours_json ?? "";

        const today = new Date();
        const end = new Date(today.getTime() + days * 24 * 60 * 60 * 1000);

        let slots;
        let err: string | null = null;
        try {
          slots = await listGoogleCalendarSlots(accountId, {
            periodoInicio: today.toISOString(),
            periodoFim: end.toISOString(),
            tamanhoJanelaMinutos: duracao,
            granularidade: duracao,
            businessHoursJson,
          });
        } catch (e) {
          err = e instanceof Error ? e.message : String(e);
          slots = [];
        }

        return Response.json({
          ok: !err,
          now: today.toISOString(),
          period_end: end.toISOString(),
          calendar: {
            id: gcal.data.calendar_id,
            name: gcal.data.calendar_name,
            email: gcal.data.email,
            ativo: gcal.data.ativo,
            expires_at: gcal.data.expires_at,
          },
          config: {
            duracao_consulta_minutos: duracao,
            business_hours_json: businessHoursJson || "(vazio — sem restrição de expediente)",
            business_hours_parsed: businessHoursJson ? safeParse(businessHoursJson) : null,
          },
          error: err,
          slots_count: slots.length,
          slots_sample: slots.slice(0, 10),
          hint:
            slots.length === 0 && !err
              ? "0 slots — provavelmente: (a) business_hours_json vazio ou sem dia ativo, (b) Google Calendar está com eventos cobrindo todo o período, (c) duração maior que os blocos de expediente. Verifique config acima."
              : null,
        });
      },
    },
  },
});

function safeParse(s: string): unknown {
  try { return JSON.parse(s); } catch { return s; }
}
