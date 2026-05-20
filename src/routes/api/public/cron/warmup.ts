// POST /api/public/cron/warmup — envia warm-up templates para pacientes com consultas próximas
// Chamado pelo pg_cron a cada 10 minutos (7h-21h).
import { createFileRoute } from "@tanstack/react-router";
import { getSelfhost } from "@/integrations/selfhost/client.server";
import { listClinicorpUpcomingAppointments } from "@/lib/tools/clinicorp.server";
import { loadHelenaAccount, sendHelenaText } from "@/lib/helena.server";

function validateCronSecret(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  return request.headers.get("x-cron-secret") === secret;
}

const WINDOW_MIN = 25; // ±25 min em torno do horário alvo para disparar

interface WarmupConfig {
  ativo: boolean;
  tempo_wu1_h: number;
  tempo_wu2_h: number;
  tempo_wu3_h: number;
  tempo_wu4_h: number;
  tempo_wu5_h: number;
  prompt_wu1: string | null;
  prompt_wu2: string | null;
  prompt_wu3: string | null;
  prompt_wu4: string | null;
  prompt_wu5: string | null;
}

function isInWindow(appointmentTime: Date, horasAntes: number, now: Date): boolean {
  const target = new Date(appointmentTime.getTime() - horasAntes * 60 * 60 * 1000);
  const diff = Math.abs(now.getTime() - target.getTime());
  return diff <= WINDOW_MIN * 60 * 1000;
}

export const Route = createFileRoute("/api/public/cron/warmup")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        if (!validateCronSecret(request)) {
          return new Response("Unauthorized", { status: 401 });
        }

        const sb = getSelfhost();
        const now = new Date();
        // Busca agendamentos nos próximos 5 dias
        const from = now.toISOString().slice(0, 10);
        const to = new Date(now.getTime() + 5 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

        // Busca contas com Clinicorp ativo
        const { data: clinicorpConfigs } = await sb
          .from("clinicorp_config")
          .select("account_id")
          .eq("ativo", true);

        if (!clinicorpConfigs?.length) {
          return Response.json({ ok: true, processed: 0 });
        }

        let processed = 0;

        for (const cfg of clinicorpConfigs) {
          const accountId = cfg.account_id as string;

          // Busca agente para esta conta
          const { data: agentData } = await sb
            .from("agents")
            .select("id, ativo")
            .eq("account_id", accountId)
            .single();
          if (!agentData?.ativo) continue;

          const agentId = agentData.id as string;

          // Busca configuração de warm-up
          const { data: wuRaw } = await sb
            .from("agent_warmup")
            .select(
              "ativo, tempo_wu1_h, tempo_wu2_h, tempo_wu3_h, tempo_wu4_h, tempo_wu5_h, " +
              "prompt_wu1, prompt_wu2, prompt_wu3, prompt_wu4, prompt_wu5",
            )
            .eq("agent_id", agentId)
            .single();
          const wu = wuRaw as Record<string, unknown> | null;

          if (!(wu?.ativo as boolean | undefined)) continue;
          const wuCfg = wu as unknown as WarmupConfig;

          // Busca agendamentos próximos no Clinicorp
          let appointments: Awaited<ReturnType<typeof listClinicorpUpcomingAppointments>>;
          try {
            appointments = await listClinicorpUpcomingAppointments(accountId, from, to);
          } catch {
            continue;
          }

          const helena = await loadHelenaAccount(accountId).catch(() => null);
          if (!helena) continue;

          const wuLevels = [
            { horas: wuCfg.tempo_wu1_h, prompt: wuCfg.prompt_wu1, key: "wu1" },
            { horas: wuCfg.tempo_wu2_h, prompt: wuCfg.prompt_wu2, key: "wu2" },
            { horas: wuCfg.tempo_wu3_h, prompt: wuCfg.prompt_wu3, key: "wu3" },
            { horas: wuCfg.tempo_wu4_h, prompt: wuCfg.prompt_wu4, key: "wu4" },
            { horas: wuCfg.tempo_wu5_h, prompt: wuCfg.prompt_wu5, key: "wu5" },
          ];

          for (const appt of appointments) {
            if (!appt.phone || !appt.start) continue;
            const apptTime = new Date(appt.start);

            for (const level of wuLevels) {
              if (!level.prompt || !isInWindow(apptTime, level.horas, now)) continue;

              // Verifica se já foi enviado (para evitar duplicata)
              const dedupeKey = `warmup:${accountId}:${appt.id}:${level.key}`;
              const { data: existing } = await sb
                .from("messages")
                .select("id")
                .eq("conversation_id", "00000000-0000-0000-0000-000000000000") // placeholder
                .contains("meta", { warmup_dedupe: dedupeKey })
                .limit(1);

              // Busca ou cria conversa para o paciente
              const { data: convData } = await sb
                .from("conversations")
                .select("id, helena_session_id")
                .eq("agent_id", agentId)
                .eq("phone", appt.phone)
                .maybeSingle();

              let convId: string;
              let sessionId: string | undefined;

              if (convData) {
                convId = convData.id as string;
                sessionId = (convData.helena_session_id as string | null) ?? undefined;

                // Verifica se warm-up já foi enviado para este agendamento/nível
                const { data: sent } = await sb
                  .from("messages")
                  .select("id")
                  .eq("conversation_id", convId)
                  .contains("meta", { warmup_dedupe: dedupeKey })
                  .limit(1);
                if (sent?.length) continue;
              } else {
                const { data: newConv } = await sb
                  .from("conversations")
                  .insert({ agent_id: agentId, phone: appt.phone })
                  .select("id")
                  .single();
                if (!newConv) continue;
                convId = newConv.id as string;
              }

              void existing; // silence unused var

              // Substitui variáveis no template
              const text = level.prompt
                .replace(/\{\{nome\}\}/gi, appt.patientName || "")
                .replace(/\{\{data_consulta\}\}/gi, apptTime.toLocaleDateString("pt-BR"))
                .replace(/\{\{hora_consulta\}\}/gi, apptTime.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" }));

              const sendRes = await sendHelenaText(helena, {
                phone: appt.phone,
                text,
                sessionId,
              });

              if (sendRes.ok) {
                await sb.from("messages").insert({
                  conversation_id: convId,
                  role: "assistant",
                  content: text,
                  meta: {
                    origem: "agente",
                    tipo: "warmup",
                    warmup_dedupe: dedupeKey,
                    warmup_nivel: level.key,
                    appointment_id: appt.id,
                  },
                });
                processed++;
              }
            }
          }
        }

        return Response.json({ ok: true, processed });
      },
    },
  },
});
