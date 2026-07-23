// POST /api/public/cron/retomar-slot-offer — retoma conversas paradas em
// SLOT_OFFER onde o AGENTE falou por último, não fez pergunta de verdade e o
// lead não escolheu nada. Nesses casos a bola é do agente e ele parou: sem este
// gatilho, nada o re-aciona e a conversa morre esperando horários que nunca
// chegam (caso Odonto Carioca Campo Grande, 21 98817-7687).
//
// Chamado pelo pg_cron a cada 10 min (ver migrations/0048_retomar_slot_offer_cron.sql).
// Aceita { dry_run: true } para inspecionar sem re-acionar nada.
import { createFileRoute } from "@tanstack/react-router";
import { getSelfhost } from "@/integrations/selfhost/client.server";
import { runAgentTurn, ConversationLockedError } from "@/lib/agent-turn.server";
import {
  shouldResumeSlotOffer,
  RETOMADA_DEFAULTS,
  type RetomadaMotivo,
} from "@/lib/agents/retomada-slot-offer";

function validateCronSecret(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  return request.headers.get("x-cron-secret") === secret;
}

export const Route = createFileRoute("/api/public/cron/retomar-slot-offer")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        if (!validateCronSecret(request)) {
          return new Response("Unauthorized", { status: 401 });
        }

        let dryRun = false;
        const cfg = { ...RETOMADA_DEFAULTS };
        try {
          const body = (await request.json()) as {
            dry_run?: boolean;
            min_minutes?: number;
            max_age_minutes?: number;
            max_retomadas?: number;
          };
          if (body?.dry_run === true) dryRun = true;
          if (typeof body?.min_minutes === "number") cfg.minMinutes = body.min_minutes;
          if (typeof body?.max_age_minutes === "number") cfg.maxAgeMinutes = body.max_age_minutes;
          if (typeof body?.max_retomadas === "number") cfg.maxRetomadas = body.max_retomadas;
        } catch {
          // body vazio → defaults
        }

        const sb = getSelfhost();

        // Só conversas em SLOT_OFFER e atualizadas dentro da janela máxima —
        // filtra no banco para não varrer a base inteira.
        const desde = new Date(Date.now() - cfg.maxAgeMinutes * 60_000).toISOString();
        const { data: convs, error } = await sb
          .from("conversations")
          .select("id, agent_id, meta, atualizado_em")
          .eq("meta->>stage", "SLOT_OFFER")
          .gte("atualizado_em", desde)
          .order("atualizado_em", { ascending: false })
          .limit(500);

        if (error) {
          console.error("[retomada] falha ao listar conversas:", error.message);
          return Response.json({ ok: false, error: error.message }, { status: 500 });
        }

        const motivos: Record<string, number> = {};
        const retomadas: { conv: string; minutos: number }[] = [];
        let processed = 0;

        for (const c of convs ?? []) {
          const convId = c.id as string;
          const ld = (c.meta as { lead_data?: Record<string, unknown> } | null)?.lead_data ?? {};

          // Agente precisa estar ativo — não ressuscita conversa de agente pausado.
          const { data: agent } = await sb
            .from("agents")
            .select("ativo")
            .eq("id", c.agent_id as string)
            .single();
          if (!agent?.ativo) {
            motivos["agente_inativo"] = (motivos["agente_inativo"] ?? 0) + 1;
            continue;
          }

          const { data: st } = await sb
            .from("conversation_state")
            .select("lock_conversa, retomadas_slot_offer")
            .eq("conversation_id", convId)
            .single();

          const { data: lastMsgs } = await sb
            .from("messages")
            .select("role, content, criado_em")
            .eq("conversation_id", convId)
            .order("criado_em", { ascending: false })
            .limit(1);
          const last = lastMsgs?.[0];
          if (!last) {
            motivos["sem_mensagens"] = (motivos["sem_mensagens"] ?? 0) + 1;
            continue;
          }

          const minutos = Math.floor(
            (Date.now() - new Date(last.criado_em as string).getTime()) / 60_000,
          );
          const decisao = shouldResumeSlotOffer(
            {
              stage: "SLOT_OFFER",
              appointmentId: ld.appointment_id as string | number | null | undefined,
              selectedSlotIso: ld.selected_slot_iso as string | null | undefined,
              lastMessageRole: (last.role as string) === "user" ? "user" : "assistant",
              lastAssistantText: (last.content as string | null) ?? "",
              minutesSinceLastMessage: minutos,
              retomadas: (st?.retomadas_slot_offer as number | null) ?? 0,
              locked: !!st?.lock_conversa,
            },
            cfg,
          );

          const motivo: RetomadaMotivo = decisao.motivo;
          motivos[motivo] = (motivos[motivo] ?? 0) + 1;
          if (!decisao.retomar) continue;

          retomadas.push({ conv: convId, minutos });
          if (dryRun) continue;

          // Incrementa ANTES de rodar: se o turno estourar, não entra em loop.
          await sb
            .from("conversation_state")
            .update({ retomadas_slot_offer: ((st?.retomadas_slot_offer as number | null) ?? 0) + 1 })
            .eq("conversation_id", convId);

          console.warn(
            `[retomada:telemetry] ${JSON.stringify({
              event: "retomada_slot_offer",
              conv: convId,
              minutos_parada: minutos,
              trecho: ((last.content as string | null) ?? "").slice(0, 120),
            })}`,
          );

          try {
            await runAgentTurn(convId);
            processed++;
          } catch (e) {
            if (e instanceof ConversationLockedError) {
              console.log(`[retomada] conv=${convId} travada — tenta no próximo tick`);
            } else {
              console.error(`[retomada] falha ao retomar conv=${convId}:`, e);
            }
          }
        }

        console.warn(
          `[retomada:telemetry] ${JSON.stringify({
            event: "retomada_slot_offer_scan",
            dry_run: dryRun,
            candidatas: (convs ?? []).length,
            elegiveis: retomadas.length,
            retomadas: processed,
            motivos,
          })}`,
        );

        return Response.json({
          ok: true,
          dry_run: dryRun,
          config: cfg,
          candidatas: (convs ?? []).length,
          elegiveis: retomadas.length,
          retomadas: processed,
          motivos,
          conversas: retomadas,
        });
      },
    },
  },
});
