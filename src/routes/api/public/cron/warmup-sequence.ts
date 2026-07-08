// POST /api/public/cron/warmup-sequence
//
// Nova sequência de warm-up modelada como STEPS (igual ao follow-up).
// Cada step: tempo antes da consulta + nome do template Helena.
//
// Lógica:
// 1. Carrega todos os warmup_steps habilitados, agrupa por agente.
// 2. Para cada agente:
//    a. Lista agendamentos próximos via adapter (Clinicorp, GCal, Clinup).
//    b. Para cada agendamento × step:
//       - Calcula sendAt = appt.start - delay do step.
//       - Verifica se now ∈ [sendAt, sendAt + window_minutes].
//       - Verifica dedupe em warmup_sends.
//       - Resolve sessionId Helena (via tabela conversations[phone, agent_id]).
//       - Resolve templateId via findHelenaTemplateByName.
//       - Envia template + registra warmup_sends.

import { createFileRoute } from "@tanstack/react-router";
import { getSelfhost } from "@/integrations/selfhost/client.server";
import {
  loadHelenaAccount,
  loadHelenaSession,
  findHelenaTemplateByName,
  sendHelenaTemplate,
} from "@/lib/helena.server";
import { listAllUpcomingAppointments } from "@/lib/warmup/sources.server";

function validateCronSecret(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  return request.headers.get("x-cron-secret") === secret;
}

function delayToMs(value: number, unit: string): number {
  switch (unit) {
    case "minutes": return value * 60_000;
    case "hours": return value * 3_600_000;
    case "days": return value * 86_400_000;
    default: return value * 3_600_000;
  }
}

// Celular BR pode estar salvo com ou sem o "9" extra depois do DDD (o
// Clinicorp às vezes guarda sem; o WhatsApp sempre manda com). Gera as
// variantes pra não perder o match por causa disso.
function phoneVariants(phone: string): string[] {
  const out = new Set([phone]);
  if (phone.length === 11 && phone[2] === "9") out.add(phone.slice(0, 2) + phone.slice(3));
  else if (phone.length === 10) out.add(phone.slice(0, 2) + "9" + phone.slice(2));
  return [...out];
}

interface ConvMatch {
  helena_session_id: string | null;
  meta: unknown;
}

/**
 * Resolve a conversa/sessão Helena de um agendamento. Dois caminhos, nessa
 * ordem:
 *   1. Por appointment_id em lead_data — funciona mesmo quando o agendamento
 *      no provider (ex.: Clinicorp) não tem telefone preenchido (é o caso de
 *      todo agendamento CRIADO PELA PRÓPRIA IA: o create não devolve/grava o
 *      telefone no registro do agendamento, só no cadastro do paciente — a
 *      listagem então vinha sem MobilePhone e o warm-up nunca encontrava
 *      sessão nem tentava de novo).
 *   2. Por telefone (com variantes do "9"), pra agendamentos feitos fora do
 *      bot (ex.: direto na recepção/Clinicorp), que não têm lead_data.
 */
async function resolveWarmupConversation(
  sb: ReturnType<typeof getSelfhost>,
  agentId: string,
  appt: { externalId: string; patientPhone: string },
): Promise<ConvMatch | null> {
  const byAppt = await sb
    .from("conversations")
    .select("helena_session_id, meta")
    .eq("agent_id", agentId)
    .eq("meta->lead_data->>appointment_id", appt.externalId)
    .not("helena_session_id", "is", null)
    .limit(1)
    .maybeSingle();
  if (byAppt.data?.helena_session_id) return byAppt.data as ConvMatch;

  if (appt.patientPhone) {
    const { data } = await sb
      .from("conversations")
      .select("helena_session_id, meta")
      .eq("agent_id", agentId)
      .in("phone", phoneVariants(appt.patientPhone))
      .not("helena_session_id", "is", null)
      .limit(1)
      .maybeSingle();
    if (data?.helena_session_id) return data as ConvMatch;
  }

  return null;
}

interface WarmupStep {
  id: string;
  agent_id: string;
  ordem: number;
  enabled: boolean;
  time_before_value: number;
  time_before_unit: string;
  helena_template_name: string;
  window_minutes: number;
  appointment_status_filter: string[] | null;
}

export const Route = createFileRoute("/api/public/cron/warmup-sequence")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        if (!validateCronSecret(request)) {
          return new Response("Unauthorized", { status: 401 });
        }

        const sb = getSelfhost();
        const now = new Date();
        const horizon = new Date(now.getTime() + 7 * 86_400_000); // próximos 7 dias

        // 1. Steps habilitados → agrupa por agent
        const { data: steps, error: stepsErr } = await sb
          .from("warmup_steps")
          .select("*")
          .eq("enabled", true)
          .order("agent_id")
          .order("ordem", { ascending: true });
        if (stepsErr) {
          return Response.json({ ok: false, error: stepsErr.message }, { status: 500 });
        }
        if (!steps || steps.length === 0) {
          return Response.json({ ok: true, attempted: 0, processed: 0, reason: "no steps" });
        }

        const stepsByAgent = new Map<string, WarmupStep[]>();
        for (const s of steps as WarmupStep[]) {
          const arr = stepsByAgent.get(s.agent_id) ?? [];
          arr.push(s);
          stepsByAgent.set(s.agent_id, arr);
        }

        let attempted = 0;
        let processed = 0;
        const skips: Array<{ reason: string; details?: unknown }> = [];

        for (const [agentId, agentSteps] of stepsByAgent) {
          // Agente ativo?
          const agentRow = await sb
            .from("agents")
            .select("id, account_id, ativo, settings")
            .eq("id", agentId)
            .single();
          if (!agentRow.data?.ativo) {
            skips.push({ reason: "agent_inactive", details: agentId });
            continue;
          }
          const agentSettings = agentRow.data.settings as Record<string, string> | null;
          // Modo teste: NÃO dispara warm-up (mesma razão do follow-up — não
          // alcançar clientes reais enquanto o dono ainda está testando).
          if (agentSettings?.test_mode === "true") {
            skips.push({ reason: "test_mode", details: agentId });
            continue;
          }
          const accountId = agentRow.data.account_id as string;

          // Helena account
          const helena = await loadHelenaAccount(accountId).catch(() => null);
          if (!helena) {
            skips.push({ reason: "no_helena_account", details: accountId });
            continue;
          }

          // Lista agendamentos próximos de TODOS os sources
          let appointments;
          try {
            appointments = await listAllUpcomingAppointments(accountId, now, horizon);
          } catch (e) {
            skips.push({ reason: "list_appointments_failed", details: String(e) });
            continue;
          }
          if (appointments.length === 0) continue;

          // Filtro de PROFISSIONAL (Clinicorp): se o dono selecionou profissionais
          // específicos para o warm-up (settings.warmup_prof_ids = "111,222"), só
          // envia para agendamentos DESSES profissionais. Vazio/ausente = todos.
          const warmupProfRaw = (agentSettings?.warmup_prof_ids ?? "").trim();
          const warmupProfIds = warmupProfRaw
            ? new Set(
                warmupProfRaw
                  .split(",")
                  .map((s) => Number(s.trim()))
                  .filter((n) => Number.isFinite(n) && n > 0),
              )
            : null;
          if (warmupProfIds && warmupProfIds.size > 0) {
            const before = appointments.length;
            appointments = appointments.filter(
              (a) =>
                a.source !== "clinicorp" ||
                (a.professionalId != null && warmupProfIds.has(a.professionalId)),
            );
            if (appointments.length !== before) {
              console.log(
                `[warmup-seq] filtro de profissional agent=${agentId}: ${before} → ${appointments.length} (profs=${[...warmupProfIds].join(",")})`,
              );
            }
            if (appointments.length === 0) continue;
          }

          // Cache de channelId por sessionId (evita refetch entre múltiplos steps)
          const channelCache = new Map<string, string>();

          for (const appt of appointments) {
            for (const step of agentSteps) {
              // Step ainda sem template configurado? pula silenciosamente.
              if (!step.helena_template_name || !step.helena_template_name.trim()) {
                continue;
              }
              // Filtro de status?
              if (
                step.appointment_status_filter &&
                step.appointment_status_filter.length > 0 &&
                appt.status &&
                !step.appointment_status_filter.includes(appt.status)
              ) {
                continue;
              }

              // sendAt = appointment.start - delay
              const delayMs = delayToMs(step.time_before_value, step.time_before_unit);
              const sendAt = new Date(appt.start.getTime() - delayMs);
              const windowEnd = new Date(sendAt.getTime() + step.window_minutes * 60_000);

              if (now < sendAt) continue;  // ainda não é hora
              if (now > windowEnd) continue; // perdeu a janela

              attempted++;

              // Dedupe: já enviado esse step pra esse appointment?
              const dedupe = await sb
                .from("warmup_sends")
                .select("id")
                .eq("step_id", step.id)
                .eq("source", appt.source)
                .eq("external_id", appt.externalId)
                .eq("status", "sent")
                .limit(1);
              if (dedupe.data && dedupe.data.length > 0) continue;

              // Resolve sessionId: por appointment_id (lead_data) primeiro,
              // com fallback por telefone (ver resolveWarmupConversation).
              const conv = await resolveWarmupConversation(sb, agentId, {
                externalId: appt.externalId,
                patientPhone: appt.patientPhone,
              });

              const sessionId = conv?.helena_session_id ?? undefined;

              // Nome para o lembrete = RESPONSÁVEL que agendou (não a criança).
              // Vem do lead_data da conversa (name = quem falou com o bot; ou
              // guardians). Cai para o nome do evento só se não houver lead_data.
              const convMeta = (conv?.meta ?? null) as {
                lead_data?: { name?: string; custom_fields?: Record<string, string> };
              } | null;
              const ldWarm = convMeta?.lead_data ?? {};
              const responsavelNome =
                ldWarm.name?.trim() ||
                ldWarm.custom_fields?.guardians?.trim() ||
                appt.patientName;
              if (!sessionId) {
                await sb.from("warmup_sends").insert({
                  step_id: step.id, agent_id: agentId, account_id: accountId,
                  source: appt.source, external_id: appt.externalId,
                  appointment_start: appt.start.toISOString(),
                  patient_phone: appt.patientPhone, patient_name: appt.patientName,
                  status: "failed", error: "no_helena_session_for_phone",
                });
                continue;
              }

              // Warm-up IGNORA etiquetas de bloqueio (inclusive "IA Desligada"):
              // é um LEMBRETE de consulta (template oficial) e deve sair mesmo
              // com a IA pausada — o compromisso continua valendo. (Diferente do
              // follow-up/webhook, que respeitam a etiqueta.)

              // Resolve channelId via sessão (com cache)
              let channelId = channelCache.get(sessionId) ?? null;
              if (!channelId) {
                const session = await loadHelenaSession(helena, sessionId).catch(() => null);
                channelId = session?.channelId ?? null;
                if (channelId) channelCache.set(sessionId, channelId);
              }
              if (!channelId) {
                await sb.from("warmup_sends").insert({
                  step_id: step.id, agent_id: agentId, account_id: accountId,
                  source: appt.source, external_id: appt.externalId,
                  appointment_start: appt.start.toISOString(),
                  patient_phone: appt.patientPhone, patient_name: appt.patientName,
                  helena_session_id: sessionId,
                  status: "failed", error: "no_channel_id_on_session",
                });
                continue;
              }

              // Resolve template pelo nome
              const template = await findHelenaTemplateByName(
                helena, channelId, step.helena_template_name,
              );
              if (!template) {
                await sb.from("warmup_sends").insert({
                  step_id: step.id, agent_id: agentId, account_id: accountId,
                  source: appt.source, external_id: appt.externalId,
                  appointment_start: appt.start.toISOString(),
                  patient_phone: appt.patientPhone, patient_name: appt.patientName,
                  helena_session_id: sessionId,
                  status: "failed",
                  error: `template_not_found:${step.helena_template_name}`,
                });
                continue;
              }

              // Variáveis comuns. O Helena substitui {{horario}} no template.
              const horario = appt.start.toLocaleString("pt-BR", {
                timeZone: "America/Sao_Paulo",
                day: "2-digit", month: "2-digit",
                hour: "2-digit", minute: "2-digit",
              }).replace(",", " às");
              const parameters: Record<string, string> = {
                horario,
                nome: responsavelNome,
                data: appt.start.toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo" }),
                hora: appt.start.toLocaleTimeString("pt-BR", {
                  timeZone: "America/Sao_Paulo",
                  hour: "2-digit", minute: "2-digit",
                }),
              };

              const sendRes = await sendHelenaTemplate(helena, {
                sessionId, templateId: template.id, parameters,
              });

              if (!sendRes.ok) {
                await sb.from("warmup_sends").insert({
                  step_id: step.id, agent_id: agentId, account_id: accountId,
                  source: appt.source, external_id: appt.externalId,
                  appointment_start: appt.start.toISOString(),
                  patient_phone: appt.patientPhone, patient_name: appt.patientName,
                  helena_session_id: sessionId, helena_template_id: template.id,
                  status: "failed",
                  error: `Helena ${sendRes.status}: ${sendRes.body.slice(0, 200)}`,
                });
                continue;
              }

              await sb.from("warmup_sends").insert({
                step_id: step.id, agent_id: agentId, account_id: accountId,
                source: appt.source, external_id: appt.externalId,
                appointment_start: appt.start.toISOString(),
                patient_phone: appt.patientPhone, patient_name: appt.patientName,
                helena_session_id: sessionId, helena_template_id: template.id,
                status: "sent",
              });
              processed++;
            }
          }
        }

        return Response.json({ ok: true, attempted, processed, skips });
      },
    },
  },
});
