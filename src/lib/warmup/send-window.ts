// Horário em que o warm-up pode sair.
//
// O lembrete é template oficial do WhatsApp para o paciente — não pode chegar
// de madrugada. O workflow n8n que fazia o warm-up da Implanto só rodava das 6h
// às 19h30 (cron "0 0,30 6-19 * * *"); o nosso roda 24h a cada 5 min e mandava
// o lembrete na hora exata, fosse 2h da manhã.
//
// Diferente do n8n, que simplesmente perdia o lembrete fora do horário, aqui
// ele é ADIADO para a abertura seguinte (06:00), desde que ainda seja antes da
// consulta: o "24h antes" de uma consulta às 22:00 sai às 06:00 do dia
// seguinte em vez de não sair.

/** Brasília não tem horário de verão desde 2019: UTC−3 fixo. */
const SP_OFFSET_MS = 3 * 3_600_000;

export const WARMUP_SEND_START_HOUR = 6;
/** Exclusivo: às 20:00 já não envia. */
export const WARMUP_SEND_END_HOUR = 20;

/**
 * Quando o lembrete pode de fato sair: o próprio `sendAt` se cair no horário
 * permitido; senão, a próxima abertura (06:00 de Brasília). `null` quando a
 * abertura seguinte já é na hora da consulta ou depois — não faz sentido
 * lembrar de algo que já começou.
 */
export function effectiveWarmupSendAt(
  sendAt: Date,
  appointmentStart: Date,
  startHour = WARMUP_SEND_START_HOUR,
  endHour = WARMUP_SEND_END_HOUR,
): Date | null {
  const local = new Date(sendAt.getTime() - SP_OFFSET_MS);
  const h = local.getUTCHours();
  let effective = sendAt;
  if (h < startHour || h >= endHour) {
    const abertura = new Date(local);
    if (h >= endHour) abertura.setUTCDate(abertura.getUTCDate() + 1);
    abertura.setUTCHours(startHour, 0, 0, 0);
    effective = new Date(abertura.getTime() + SP_OFFSET_MS);
  }
  return effective.getTime() >= appointmentStart.getTime() ? null : effective;
}
