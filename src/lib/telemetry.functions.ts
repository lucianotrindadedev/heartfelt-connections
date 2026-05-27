// Telemetria agregada do orquestrador (admin / superadmin).
//
// Lê `messages.meta` das mensagens do assistente nos últimos N dias e conta
// quantas vezes cada flag determinística disparou — agrupado por modelo + dia.
// Permite responder rápido a perguntas como:
//
//   - "Em quais modelos o preflight_blocked está disparando mais?"
//   - "O duplicate_reply_blocked caiu depois do último deploy?"
//   - "Quantos llm_patch_sanitized aconteceram hoje?"

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { getSelfhost } from "@/integrations/selfhost/client.server";

const FLAG_KEYS = [
  "duplicate_reply_blocked",
  "false_booking_claim_blocked",
  "forced_scheduling_advance",
  "preflight_blocked",
] as const;

type FlagKey = (typeof FLAG_KEYS)[number];

export interface TelemetryBucket {
  day: string;
  model: string;
  total: number;
  flags: Record<FlagKey, number>;
}

export interface TelemetryDailyTotals {
  day: string;
  total: number;
  flags: Record<FlagKey, number>;
}

export interface TelemetryStats {
  from: string;
  to: string;
  days: number;
  byModelDay: TelemetryBucket[];
  totalsByDay: TelemetryDailyTotals[];
  totals: { total: number; flags: Record<FlagKey, number> };
}

export const getTelemetryStats = createServerFn({ method: "GET" })
  .inputValidator((d) =>
    z
      .object({
        days: z.number().int().min(1).max(60).default(7),
      })
      .parse(d ?? {}),
  )
  .handler(async ({ data }): Promise<TelemetryStats> => {
    const sb = getSelfhost();
    const since = new Date(Date.now() - data.days * 24 * 60 * 60 * 1000);

    // Limita a 20k rows para nao estourar memoria em conta grande.
    // Painel e diagnostico — nao precisa precisao perfeita.
    const { data: rows, error } = await sb
      .from("messages")
      .select("criado_em, meta")
      .eq("role", "assistant")
      .gte("criado_em", since.toISOString())
      .order("criado_em", { ascending: false })
      .limit(20000);
    if (error) throw new Error(error.message);

    const byKey = new Map<string, TelemetryBucket>();
    const totalsByDay = new Map<string, TelemetryDailyTotals>();
    const grandTotals: TelemetryDailyTotals = {
      day: "all",
      total: 0,
      flags: emptyFlags(),
    };

    for (const r of rows ?? []) {
      const meta = (r.meta ?? {}) as Record<string, unknown>;
      const model = (meta.model as string | undefined) ?? "unknown";
      const day = new Date(r.criado_em as string).toISOString().slice(0, 10);

      const bucketKey = `${day}::${model}`;
      let bucket = byKey.get(bucketKey);
      if (!bucket) {
        bucket = { day, model, total: 0, flags: emptyFlags() };
        byKey.set(bucketKey, bucket);
      }
      bucket.total += 1;

      let daily = totalsByDay.get(day);
      if (!daily) {
        daily = { day, total: 0, flags: emptyFlags() };
        totalsByDay.set(day, daily);
      }
      daily.total += 1;

      grandTotals.total += 1;

      for (const k of FLAG_KEYS) {
        if (meta[k] === true) {
          bucket.flags[k] += 1;
          daily.flags[k] += 1;
          grandTotals.flags[k] += 1;
        }
      }
    }

    const byModelDay = [...byKey.values()].sort(
      (a, b) =>
        b.day.localeCompare(a.day) ||
        b.total - a.total ||
        a.model.localeCompare(b.model),
    );
    const totalsByDayArr = [...totalsByDay.values()].sort((a, b) => b.day.localeCompare(a.day));

    return {
      from: since.toISOString(),
      to: new Date().toISOString(),
      days: data.days,
      byModelDay,
      totalsByDay: totalsByDayArr,
      totals: { total: grandTotals.total, flags: grandTotals.flags },
    };
  });

function emptyFlags(): Record<FlagKey, number> {
  return {
    duplicate_reply_blocked: 0,
    false_booking_claim_blocked: 0,
    forced_scheduling_advance: 0,
    preflight_blocked: 0,
  };
}
