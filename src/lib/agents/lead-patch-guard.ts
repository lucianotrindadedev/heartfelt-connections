// Guard do patch estruturado que o LLM devolve (lead_data_patch).
//
// Alguns campos do lead_data são de CONTROLE DO SISTEMA — só podem ser setados
// por resultado de TOOL (criar/cancelar/remarcar agendamento) ou pelo
// orquestrador, NUNCA pelo texto do modelo. Sem esta barreira o LLM consegue
// FORJAR um agendamento/remarcação escrevendo um appointment_id inventado.
//
// Caso real (21 97558-2703): o agente cancelou o horário antigo, não conseguiu
// criar o novo (ficou chamando remarcar_agendamento, que só cancela) e
// "confirmou" com appointment_id="remarcado_09_07" — um ID falso. Com o ID
// falso os guards de confirmação falsa (que exigem !appointment_id) não disparam
// e o lead fica sem agendamento real na agenda.
//
// selected_slot_iso/dentist_person_id entraram nessa lista pelo mesmo motivo:
// esses campos disparam o booking DETERMINÍSTICO (tryDeterministicBooking) —
// inclusive no MESMO turn em que o LLM os declarou (ver "late booking" em
// scheduler.server.ts). Se o LLM escreve selected_slot_iso sozinho (ex.:
// confunde um horário OFERECIDO com um horário ESCOLHIDO pelo lead), o sistema
// cria um agendamento REAL sem o lead ter confirmado nada. Caso real (Clínica
// Bomfim, 09/07): o agente ofereceu "hoje 11:30 ou 15:00", o lead recusou os
// dois, e mesmo assim o Clinicorp criou o agendamento de hoje 15:00. A partir
// de agora só a heurística determinística (tryAutoSelectOfferedSlot, que lê o
// texto real do lead contra offered_slots) ou o resultado de uma tool podem
// setar esses campos.

/** Campos que o LLM NUNCA pode setar via lead_data_patch. */
export const LLM_FORBIDDEN_LEAD_FIELDS = [
  "appointment_id",
  "booked_slot_iso",
  "booked_tag_applied",
  "appointment_cancelled",
  "reoffer_after_cancel",
  "initial_tag_applied",
  "leads360_lead_sent",
  "selected_slot_iso",
  "dentist_person_id",
  "professional_uuid",
] as const;

/** Remove do patch do LLM os campos controlados pelo sistema. */
export function stripLlmForbiddenFields(
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const out = { ...patch };
  for (const k of LLM_FORBIDDEN_LEAD_FIELDS) {
    if (k in out) delete out[k];
  }
  return out;
}
