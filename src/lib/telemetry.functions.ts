import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { getSelfhost } from "@/integrations/selfhost/client.server";

const FLAG_KEYS = [
  "duplicate_reply_blocked",
  "false_booking_claim_blocked",
  "forced_scheduling_advance",
  "preflight_blocked",
  "double_booking_blocked",
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

export interface TelemetryAccountBucket {
  account_id: string;
  account_name: string;
  total: number;
  flags: Record<FlagKey, number>;
  intervention_count: number;
  intervention_rate: number;
}

export interface TelemetryStats {
  from: string;
  to: string;
  days: number;
  byModelDay: TelemetryBucket[];
  totalsByDay: TelemetryDailyTotals[];
  totals: { total: number; flags: Record<FlagKey, number> };
  byAccount: TelemetryAccountBucket[];
}

export const getTelemetryStats = createServerFn({ method: "GET" })
  .inputValidator((d) =>
    z
      .object({ days: z.number().int().min(1).max(60).default(7) })
      .parse(d ?? {}),
  )
  .handler(async ({ data }): Promise<TelemetryStats> => {
    const sb = getSelfhost();
    const since = new Date(Date.now() - data.days * 24 * 60 * 60 * 1000);

    const [{ data: rows, error }, { data: accountsData }] = await Promise.all([
      sb
        .from("messages")
        .select("criado_em, meta, conversations(agents(account_id))")
        .eq("role", "assistant")
        .gte("criado_em", since.toISOString())
        .order("criado_em", { ascending: false })
        .limit(20000),
      sb.from("accounts").select("id, nome"),
    ]);

    if (error) throw new Error(error.message);

    const accountNames = new Map<string, string>();
    for (const a of accountsData ?? []) {
      accountNames.set(a.id as string, a.nome as string);
    }

    const byKey = new Map<string, TelemetryBucket>();
    const totalsByDay = new Map<string, TelemetryDailyTotals>();
    const byAccount = new Map<string, TelemetryAccountBucket>();
    const grandTotals: TelemetryDailyTotals = {
      day: "all",
      total: 0,
      flags: emptyFlags(),
    };

    for (const r of rows ?? []) {
      const meta = (r.meta ?? {}) as Record<string, unknown>;
      const model = (meta.model as string | undefined) ?? "unknown";
      const day = new Date(r.criado_em as string).toISOString().slice(0, 10);
      const conv = r.conversations as { agents?: { account_id?: string } | null } | null;
      const accountId = conv?.agents?.account_id ?? "unknown";

      // by model × day
      const bucketKey = `${day}::${model}`;
      let bucket = byKey.get(bucketKey);
      if (!bucket) {
        bucket = { day, model, total: 0, flags: emptyFlags() };
        byKey.set(bucketKey, bucket);
      }
      bucket.total += 1;

      // by day
      let daily = totalsByDay.get(day);
      if (!daily) {
        daily = { day, total: 0, flags: emptyFlags() };
        totalsByDay.set(day, daily);
      }
      daily.total += 1;

      // by account
      let accBucket = byAccount.get(accountId);
      if (!accBucket) {
        accBucket = {
          account_id: accountId,
          account_name: accountNames.get(accountId) ?? accountId.slice(0, 8),
          total: 0,
          flags: emptyFlags(),
          intervention_count: 0,
          intervention_rate: 0,
        };
        byAccount.set(accountId, accBucket);
      }
      accBucket.total += 1;

      grandTotals.total += 1;

      for (const k of FLAG_KEYS) {
        if (meta[k] === true) {
          bucket.flags[k] += 1;
          daily.flags[k] += 1;
          accBucket.flags[k] += 1;
          grandTotals.flags[k] += 1;
        }
      }
    }

    // calculate per-account intervention rate
    for (const acc of byAccount.values()) {
      acc.intervention_count = FLAG_KEYS.reduce((s, k) => s + acc.flags[k], 0);
      acc.intervention_rate = acc.total > 0 ? acc.intervention_count / acc.total : 0;
    }

    const byModelDay = [...byKey.values()].sort(
      (a, b) =>
        b.day.localeCompare(a.day) ||
        b.total - a.total ||
        a.model.localeCompare(b.model),
    );
    const totalsByDayArr = [...totalsByDay.values()].sort((a, b) =>
      b.day.localeCompare(a.day),
    );
    const byAccountArr = [...byAccount.values()].sort(
      (a, b) => b.intervention_count - a.intervention_count || b.total - a.total,
    );

    return {
      from: since.toISOString(),
      to: new Date().toISOString(),
      days: data.days,
      byModelDay,
      totalsByDay: totalsByDayArr,
      totals: { total: grandTotals.total, flags: grandTotals.flags },
      byAccount: byAccountArr,
    };
  });

function emptyFlags(): Record<FlagKey, number> {
  return {
    duplicate_reply_blocked: 0,
    false_booking_claim_blocked: 0,
    forced_scheduling_advance: 0,
    preflight_blocked: 0,
    double_booking_blocked: 0,
  };
}
