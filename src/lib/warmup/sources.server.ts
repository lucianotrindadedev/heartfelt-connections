// Adapter unificado: lista agendamentos próximos de TODOS os providers
// de agenda ativos na conta: Clinicorp, Google Calendar, Clinic Experts e
// Clinup.

import { getSelfhost } from "@/integrations/selfhost/client.server";
import { listClinicorpUpcomingAppointments } from "@/lib/tools/clinicorp.server";
import { listUpcomingGoogleCalendarEvents } from "@/lib/tools/google-calendar.server";
import { listClinicExpertsUpcomingAppointments } from "@/lib/tools/clinic-experts.server";
import {
  getClinupPatientPhone,
  listClinupUpcomingAppointments,
} from "@/lib/tools/clinup.server";

export interface UpcomingAppointment {
  source: "clinicorp" | "google_calendar" | "clinup" | "clinic_experts";
  externalId: string;
  start: Date;         // horário da consulta (ISO em UTC ou com offset)
  patientPhone: string;
  patientName: string;
  status?: string;
  /** Profissional do agendamento (Clinicorp dentist_person_id) — usado para
   *  filtrar o warm-up por profissional selecionado. */
  professionalId?: number;
  /**
   * Telefone sob demanda, para fontes cuja listagem não traz o telefone
   * (Clinup: a pesquisa de consultas só traz o pacienteId). O cron só chama
   * quando um lembrete está para sair e a conversa não foi achada pelo
   * appointment_id — buscar o telefone de toda consulta a cada 5 min seria
   * uma chamada por paciente por tick.
   */
  resolvePhone?: () => Promise<string>;
}

/** YYYY-MM-DD no fuso de Brasília (UTC−3 fixo). */
function spDate(d: Date): string {
  return new Date(d.getTime() - 3 * 3_600_000).toISOString().slice(0, 10);
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
        // Telefone pode vir vazio: agendamentos CRIADOS PELA IA não têm
        // MobilePhone no registro do agendamento no Clinicorp (só no cadastro
        // do paciente). Não descarta — o warm-up casa a sessão por
        // appointment_id (lead_data) quando o telefone estiver ausente.
        if (!a.start) continue;
        const startDate = new Date(a.start);
        if (Number.isNaN(startDate.getTime())) continue;
        out.push({
          source: "clinicorp",
          externalId: String(a.id),
          start: startDate,
          patientPhone: a.phone,
          patientName: a.patientName,
          status: a.status,
          professionalId: a.dentistPersonId,
        });
      }
    } catch (e) {
      console.error("[warmup-sources] clinicorp falhou:", e);
    }
  }

  // ─── Google Calendar ────────────────────────────────────────
  const { data: gcal } = await sb
    .from("google_calendar_tokens")
    .select("account_id")
    .eq("account_id", accountId)
    .maybeSingle();
  if (gcal) {
    try {
      const events = await listUpcomingGoogleCalendarEvents(accountId, fromDate, toDate);
      for (const e of events) {
        if (!e.phone) continue; // sem telefone não dá pra casar a conversa/sessão
        out.push({
          source: "google_calendar",
          externalId: e.id,
          start: e.start,
          patientPhone: e.phone,
          patientName: e.name,
        });
      }
    } catch (e) {
      console.error("[warmup-sources] google calendar falhou:", e);
    }
  }

  // ─── Clinic Experts ─────────────────────────────────────────
  const { data: clinicExperts } = await sb
    .from("clinic_experts_config")
    .select("account_id, ativo")
    .eq("account_id", accountId)
    .eq("ativo", true)
    .maybeSingle();
  if (clinicExperts) {
    try {
      const items = await listClinicExpertsUpcomingAppointments(
        accountId,
        fromDate.toISOString().slice(0, 10),
        toDate.toISOString().slice(0, 10),
      );
      for (const a of items) {
        if (!a.phone) continue; // sem telefone não dá pra casar a conversa/sessão
        const startDate = new Date(a.start);
        if (Number.isNaN(startDate.getTime())) continue;
        out.push({
          source: "clinic_experts",
          externalId: String(a.id),
          start: startDate,
          patientPhone: a.phone,
          patientName: a.patientName,
          status: a.status,
        });
      }
    } catch (e) {
      console.error("[warmup-sources] clinic experts falhou:", e);
    }
  }

  // ─── Clinup ─────────────────────────────────────────────────
  // GET /consultas/pesquisa por profissional habilitado (o mesmo endpoint do
  // workflow n8n da Implanto). Datas em horário de Brasília: em UTC, depois
  // das 21h o "hoje" já virava amanhã e a consulta da noite sumia da janela.
  const { data: clinup } = await sb
    .from("clinup_config")
    .select("account_id, ativo")
    .eq("account_id", accountId)
    .eq("ativo", true)
    .maybeSingle();
  if (clinup) {
    try {
      const items = await listClinupUpcomingAppointments(accountId, spDate(fromDate), spDate(toDate));
      for (const a of items) {
        const startDate = new Date(a.startIso);
        if (Number.isNaN(startDate.getTime())) continue;
        out.push({
          source: "clinup",
          externalId: a.id,
          start: startDate,
          patientPhone: "",
          patientName: a.patientName,
          status: a.situacao != null ? String(a.situacao) : undefined,
          resolvePhone: () => getClinupPatientPhone(accountId, a.patientId),
        });
      }
    } catch (e) {
      console.error("[warmup-sources] clinup falhou:", e);
    }
  }

  return out;
}
