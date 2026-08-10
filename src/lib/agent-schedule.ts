// Atendimento programado: janelas de horário em que o agente NÃO responde.
//
// SEMÂNTICA (decidida com o usuário, 06/08/2026): as janelas marcadas são o
// horário em que a EQUIPE HUMANA atende — nelas a IA fica CALADA. Fora delas
// (noite, fim de semana, dias desativados e TAMBÉM o intervalo de almoço) a IA
// responde normalmente. É o oposto de "horário de funcionamento": aqui a janela
// é de silêncio, não de atividade.
//
// Exemplo (Seg 08:00–18:00, almoço 12:00–13:00, sábado desativado):
//   seg 09:00 → CALADA (equipe atende)
//   seg 12:30 → responde (equipe no almoço)
//   seg 20:00 → responde
//   sábado    → responde (dia sem janela de silêncio)
//
// IMPORTANTE: silenciar NUNCA descarta mensagem. O webhook grava a mensagem
// (lead e atendente humano) ANTES de decidir disparar o turn — o histórico
// segue completo e o agente retoma o contexto quando voltar a responder.
//
// Reaproveita parseDisponibilidadeFromSettings (o mesmo parser do
// BusinessHoursEditor) para não divergir no entendimento do JSON: ele já
// devolve blocos [{inicio,fim}] por dia e já trata o almoço como buraco entre
// dois blocos — que é exatamente a janela de silêncio partida.
import {
  diaSemanaChave,
  parseDisponibilidadeFromSettings,
} from "@/lib/tools/google-calendar.server";

/** Valor de `agents.settings.schedule_mode`. Ausente/desconhecido = "24h". */
export type AgentScheduleMode = "24h" | "scheduled";

const TZ = "America/Sao_Paulo";

export function parseScheduleMode(raw: string | undefined | null): AgentScheduleMode {
  return (raw ?? "").trim().toLowerCase() === "scheduled" ? "scheduled" : "24h";
}

/** "HH:MM" → minutos do dia. -1 quando inválido. */
function toMinutes(hhmm: string): number {
  const m = /^(\d{1,2}):(\d{2})/.exec((hhmm ?? "").trim());
  if (!m) return -1;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (!Number.isFinite(h) || !Number.isFinite(min)) return -1;
  if (h < 0 || h > 23 || min < 0 || min > 59) return -1;
  return h * 60 + min;
}

/** Minutos do dia no fuso de Brasília (independe do fuso do servidor). */
function minutesOfDayBrt(now: Date): number {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: TZ,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(now);
  const h = Number(parts.find((p) => p.type === "hour")?.value ?? "-1");
  const m = Number(parts.find((p) => p.type === "minute")?.value ?? "-1");
  if (!Number.isFinite(h) || !Number.isFinite(m) || h < 0 || m < 0) return -1;
  return h * 60 + m;
}

export interface AgentScheduleSettings {
  /** agents.settings.schedule_mode */
  schedule_mode?: string;
  /** agents.settings.schedule_silence_json (formato do BusinessHoursEditor) */
  schedule_silence_json?: string;
}

/**
 * O agente deve ficar CALADO agora?
 *
 * `true` só quando o modo é "scheduled" E o instante cai dentro de um bloco de
 * silêncio do dia. Qualquer configuração ausente/inválida devolve `false`
 * (fail-open): na dúvida o agente RESPONDE — ficar mudo por bug de config é
 * pior do que responder fora da janela.
 */
export function isAgentMutedNow(
  settings: AgentScheduleSettings | Record<string, string> | null | undefined,
  now: Date = new Date(),
): boolean {
  const s = (settings ?? {}) as AgentScheduleSettings;
  if (parseScheduleMode(s.schedule_mode) !== "scheduled") return false;

  const raw = (s.schedule_silence_json ?? "").trim();
  if (!raw) return false;

  const disponibilidade = parseDisponibilidadeFromSettings(raw);
  const dayKey = diaSemanaChave(now);
  const blocos = disponibilidade[dayKey];
  if (!blocos?.length) return false; // dia sem janela de silêncio → responde

  const nowMin = minutesOfDayBrt(now);
  if (nowMin < 0) return false;

  return blocos.some((b) => {
    const ini = toMinutes(b.inicio);
    const fim = toMinutes(b.fim);
    if (ini < 0 || fim < 0 || fim <= ini) return false;
    // [início, fim) — às 18:00 em ponto o silêncio já acabou.
    return nowMin >= ini && nowMin < fim;
  });
}

/** Texto curto do motivo, para log/telemetria. */
export function scheduleMuteReason(now: Date = new Date()): string {
  const hhmm = new Intl.DateTimeFormat("pt-BR", {
    timeZone: TZ,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(now);
  return `atendimento programado — janela de silêncio (${diaSemanaChave(now)} ${hhmm} BRT)`;
}
