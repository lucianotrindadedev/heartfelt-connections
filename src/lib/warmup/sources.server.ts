// Adapter unificado: lista agendamentos próximos de TODOS os providers
// de agenda ativos na conta. Hoje implementado: Clinicorp. Google Calendar
// e Clinup ficam como stubs prontos para serem ligados quando os adapters
// individuais expõem listUpcomingEvents.

import { getSelfhost } from "@/integrations/selfhost/client.server";
import { listClinicorpUpcomingAppointments } from "@/lib/tools/clinicorp.server";

export interface UpcomingAppointment {
  source: "clinicorp" | "google_calendar" | "clinup";
  externalId: string;
  start: Date;         // horário da consulta (ISO em UTC ou com offset)
  patientPhone: string;
  patientName: string;
  status?: string;
}

/**
 * Lista todos os agendamentos da conta dentro da janela [fromDate, toDate)
 * agregando todos os sources ativos. Falhas em um source não impedem outros.
 */
export async function listAllUpcomingAppointments(
  accountId: string,
  fromDate: Date,
  toDate: Date,
): Promise<UpcomingAppointment[]> {
  const out: UpcomingAppointment[] = [];
  const sb = getSelfhost();

  // ─── Clinicorp ──────────────────────────────────────────────
  const { data: clinicorp } = await sb
    .from("clinicorp_config")
    .select("account_id, ativo")
    .eq("account_id", accountId)
    .eq("ativo", true)
    .maybeSingle();
  if (clinicorp) {
    try {
      const items = await listClinicorpUpcomingAppointments(
        accountId,
        fromDate.toISOString().slice(0, 10),
        toDate.toISOString().slice(0, 10),
      );
      for (const a of items) {
        if (!a.phone || !a.start) continue;
        const startDate = new Date(a.start);
        if (Number.isNaN(startDate.getTime())) continue;
        out.push({
          source: "clinicorp",
          externalId: String(a.id),
          start: startDate,
          patientPhone: a.phone,
          patientName: a.patientName,
          status: a.status,
        });
      }
    } catch (e) {
      console.error("[warmup-sources] clinicorp falhou:", e);
    }
  }

  // ─── Google Calendar (TODO: implementar listUpcomingGoogleEvents) ──
  // const { data: gcal } = await sb.from("google_calendar_tokens")...
  // if (gcal?.ativo) {
  //   const events = await listUpcomingGoogleEvents(accountId, fromDate, toDate);
  //   for (const e of events) out.push({ source: 'google_calendar', ... })
  // }

  // ─── Clinup (TODO: implementar quando o adapter expor listUpcoming) ──
  // const { data: clinup } = await sb.from("clinup_config")...
  // if (clinup?.ativo) {
  //   const items = await listClinupUpcomingAppointments(accountId, fromDate, toDate);
  //   for (const a of items) out.push({ source: 'clinup', ... })
  // }

  return out;
}
