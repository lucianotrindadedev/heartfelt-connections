import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid,
} from "recharts";
import {
  RefreshCw, ShieldCheck, ShieldAlert, Repeat2,
  CalendarX2, CalendarCheck, Ban, Activity, Users,
} from "lucide-react";
import { getTelemetryStats, type TelemetryAccountBucket } from "@/lib/telemetry.functions";

export const Route = createFileRoute("/_authenticated/admin/telemetry")({
  component: AdminTelemetry,
});

// ─── Config visual por flag ──────────────────────────────────────────────────

const FLAG_CONFIG = {
  duplicate_reply_blocked: {
    label: "Reply duplicada",
    shortLabel: "Duplicada",
    desc: "LLM repetiu a própria resposta",
    icon: Repeat2,
    color: "#f59e0b",
    bg: "bg-amber-50",
    border: "border-amber-200",
    text: "text-amber-700",
    badge: "bg-amber-100 text-amber-700",
  },
  false_booking_claim_blocked: {
    label: "Confirmação falsa",
    shortLabel: "Conf. falsa",
    desc: 'LLM disse "agendei" sem appointment_id',
    icon: CalendarX2,
    color: "#ef4444",
    bg: "bg-rose-50",
    border: "border-rose-200",
    text: "text-rose-700",
    badge: "bg-rose-100 text-rose-700",
  },
  forced_scheduling_advance: {
    label: "Avanço forçado",
    shortLabel: "Avanço",
    desc: "Cliente aceitou proposta — orquestrador avançou",
    icon: CalendarCheck,
    color: "#3b82f6",
    bg: "bg-blue-50",
    border: "border-blue-200",
    text: "text-blue-700",
    badge: "bg-blue-100 text-blue-700",
  },
  preflight_blocked: {
    label: "Preflight bloqueado",
    shortLabel: "Preflight",
    desc: "Mensagem barrada antes do LLM",
    icon: Ban,
    color: "#8b5cf6",
    bg: "bg-violet-50",
    border: "border-violet-200",
    text: "text-violet-700",
    badge: "bg-violet-100 text-violet-700",
  },
  double_booking_blocked: {
    label: "Agend. duplo",
    shortLabel: "Duplo",
    desc: "Cliente já tinha agendamento",
    icon: CalendarX2,
    color: "#f97316",
    bg: "bg-orange-50",
    border: "border-orange-200",
    text: "text-orange-700",
    badge: "bg-orange-100 text-orange-700",
  },
} as const;

const FLAG_KEYS = Object.keys(FLAG_CONFIG) as (keyof typeof FLAG_CONFIG)[];

const PERIOD_OPTIONS = [
  { value: 1, label: "Hoje" },
  { value: 3, label: "3 dias" },
  { value: 7, label: "7 dias" },
  { value: 14, label: "14 dias" },
  { value: 30, label: "30 dias" },
];

// ─── Main component ──────────────────────────────────────────────────────────

function AdminTelemetry() {
  const fetchStats = useServerFn(getTelemetryStats);
  const [days, setDays] = useState(7);

  const q = useQuery({
    queryKey: ["admin", "telemetry", days],
    queryFn: () => fetchStats({ data: { days } }),
  });

  const stats = q.data;

  const totalInterventions = stats
    ? FLAG_KEYS.reduce((s, k) => s + (stats.totals.flags[k] ?? 0), 0)
    : 0;

  const healthPct = stats && stats.totals.total > 0
    ? ((1 - totalInterventions / stats.totals.total) * 100)
    : 100;

  const healthColor =
    healthPct >= 99 ? "text-emerald-600" :
    healthPct >= 95 ? "text-amber-600" : "text-rose-600";
  const healthBg =
    healthPct >= 99 ? "bg-emerald-50 border-emerald-200" :
    healthPct >= 95 ? "bg-amber-50 border-amber-200" : "bg-rose-50 border-rose-200";
  const HealthIcon = healthPct >= 95 ? ShieldCheck : ShieldAlert;

  // Chart data: reverse to show oldest first on left
  const chartData = [...(stats?.totalsByDay ?? [])].reverse().map((d) => ({
    day: d.day.slice(5), // MM-DD
    ...FLAG_KEYS.reduce((acc, k) => ({ ...acc, [k]: d.flags[k] ?? 0 }), {}),
    total: d.total,
  }));

  // Only show flags that have at least 1 occurrence in the period
  const activeFlags = FLAG_KEYS.filter(
    (k) => (stats?.totals.flags[k] ?? 0) > 0,
  );

  return (
    <div className="space-y-6">
      {/* ── Header ── */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900">Telemetria</h1>
          <p className="mt-0.5 text-sm text-slate-500">
            Intervenções determinísticas do orquestrador — quanto menor, melhor.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
            {PERIOD_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                onClick={() => setDays(opt.value)}
                className={`px-3 py-1.5 text-sm font-medium transition-colors ${
                  days === opt.value
                    ? "bg-slate-900 text-white"
                    : "text-slate-600 hover:bg-slate-50"
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
          <button
            onClick={() => q.refetch()}
            disabled={q.isFetching}
            className="flex h-9 w-9 items-center justify-center rounded-lg border border-slate-200 bg-white text-slate-500 shadow-sm transition-colors hover:bg-slate-50 disabled:opacity-50"
          >
            <RefreshCw className={`h-4 w-4 ${q.isFetching ? "animate-spin" : ""}`} />
          </button>
        </div>
      </div>

      {q.isLoading && (
        <div className="flex items-center gap-2 text-sm text-slate-500">
          <RefreshCw className="h-4 w-4 animate-spin" /> Carregando…
        </div>
      )}
      {q.isError && (
        <div className="rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-700">
          {(q.error as Error).message}
        </div>
      )}

      {stats && (
        <>
          {/* ── KPI strip ── */}
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6">
            {/* Health card — spans 2 cols on lg */}
            <div
              className={`col-span-2 flex items-center gap-4 rounded-xl border p-4 shadow-sm lg:col-span-1 ${healthBg}`}
            >
              <HealthIcon className={`h-8 w-8 shrink-0 ${healthColor}`} />
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">
                  Saúde
                </p>
                <p className={`text-2xl font-bold tabular-nums ${healthColor}`}>
                  {healthPct.toFixed(1)}%
                </p>
                <p className="text-[10px] text-slate-500">
                  {stats.totals.total.toLocaleString("pt-BR")} replies
                </p>
              </div>
            </div>

            {/* Flag cards */}
            {FLAG_KEYS.map((k) => {
              const cfg = FLAG_CONFIG[k];
              const Icon = cfg.icon;
              const v = stats.totals.flags[k] ?? 0;
              const pct = stats.totals.total
                ? ((v / stats.totals.total) * 100).toFixed(1)
                : "0.0";
              const active = v > 0;
              return (
                <div
                  key={k}
                  className={`rounded-xl border p-4 shadow-sm transition-colors ${
                    active ? `${cfg.bg} ${cfg.border}` : "border-slate-200 bg-white"
                  }`}
                >
                  <div className="flex items-start justify-between gap-1">
                    <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-500 leading-tight">
                      {cfg.label}
                    </p>
                    <Icon
                      className={`h-4 w-4 shrink-0 mt-0.5 ${active ? cfg.text : "text-slate-300"}`}
                    />
                  </div>
                  <p
                    className={`mt-1.5 text-2xl font-bold tabular-nums ${
                      active ? cfg.text : "text-slate-900"
                    }`}
                  >
                    {v}
                  </p>
                  <p className="text-[10px] text-slate-400">{pct}% das replies</p>
                </div>
              );
            })}
          </div>

          {/* ── Chart ── */}
          {chartData.length > 1 && (
            <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
              <div className="mb-4 flex items-center justify-between">
                <div>
                  <p className="text-sm font-semibold text-slate-900">
                    Intervenções por dia
                  </p>
                  <p className="text-xs text-slate-400">
                    {activeFlags.length === 0
                      ? "Nenhuma intervenção no período — sistema saudável"
                      : `${activeFlags.length} tipo(s) ativo(s)`}
                  </p>
                </div>
                {activeFlags.length > 0 && (
                  <div className="flex flex-wrap gap-1.5">
                    {activeFlags.map((k) => (
                      <span
                        key={k}
                        className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold ${FLAG_CONFIG[k].badge}`}
                      >
                        <span
                          className="h-1.5 w-1.5 rounded-full"
                          style={{ background: FLAG_CONFIG[k].color }}
                        />
                        {FLAG_CONFIG[k].shortLabel}
                      </span>
                    ))}
                  </div>
                )}
              </div>
              <ResponsiveContainer width="100%" height={200}>
                <BarChart data={chartData} barCategoryGap="30%">
                  <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                  <XAxis
                    dataKey="day"
                    tick={{ fontSize: 11, fill: "#94a3b8" }}
                    axisLine={false}
                    tickLine={false}
                  />
                  <YAxis
                    tick={{ fontSize: 11, fill: "#94a3b8" }}
                    axisLine={false}
                    tickLine={false}
                    allowDecimals={false}
                  />
                  <Tooltip
                    contentStyle={{
                      borderRadius: 8,
                      border: "1px solid #e2e8f0",
                      fontSize: 12,
                    }}
                    formatter={(value: number, name: string) => [
                      value,
                      FLAG_CONFIG[name as keyof typeof FLAG_CONFIG]?.shortLabel ?? name,
                    ]}
                  />
                  {activeFlags.length > 0 ? (
                    activeFlags.map((k) => (
                      <Bar
                        key={k}
                        dataKey={k}
                        stackId="a"
                        fill={FLAG_CONFIG[k].color}
                        radius={k === activeFlags[activeFlags.length - 1] ? [3, 3, 0, 0] : [0, 0, 0, 0]}
                      />
                    ))
                  ) : (
                    <Bar dataKey="total" fill="#e2e8f0" radius={[3, 3, 0, 0]} />
                  )}
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}

          {/* ── Por conta ── */}
          <div className="rounded-xl border border-slate-200 bg-white shadow-sm">
            <div className="flex items-center gap-2 border-b border-slate-100 px-5 py-4">
              <Users className="h-4 w-4 text-slate-400" />
              <p className="text-sm font-semibold text-slate-900">Por conta</p>
              <span className="ml-auto rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-semibold text-slate-500">
                {stats.byAccount.length} conta(s)
              </span>
            </div>
            {stats.byAccount.length === 0 ? (
              <p className="p-5 text-sm text-slate-400">Sem dados no período.</p>
            ) : (
              <AccountTable rows={stats.byAccount} />
            )}
          </div>

          {/* ── Por modelo × dia ── */}
          <div className="rounded-xl border border-slate-200 bg-white shadow-sm">
            <div className="flex items-center gap-2 border-b border-slate-100 px-5 py-4">
              <Activity className="h-4 w-4 text-slate-400" />
              <p className="text-sm font-semibold text-slate-900">Por modelo</p>
            </div>
            <ModelTable rows={stats.byModelDay} />
          </div>
        </>
      )}
    </div>
  );
}

// ─── Per-account table ────────────────────────────────────────────────────────

function AccountTable({ rows }: { rows: TelemetryAccountBucket[] }) {
  const [expanded, setExpanded] = useState<string | null>(null);

  return (
    <div className="overflow-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-slate-100 text-left">
            <th className="px-5 py-2.5 text-xs font-semibold uppercase tracking-wide text-slate-400">
              Conta
            </th>
            <th className="px-3 py-2.5 text-right text-xs font-semibold uppercase tracking-wide text-slate-400">
              Replies
            </th>
            <th className="px-3 py-2.5 text-right text-xs font-semibold uppercase tracking-wide text-slate-400">
              Intervenções
            </th>
            <th className="px-3 py-2.5 text-right text-xs font-semibold uppercase tracking-wide text-slate-400">
              Taxa
            </th>
            {FLAG_KEYS.map((k) => (
              <th
                key={k}
                className="px-3 py-2.5 text-right text-xs font-semibold uppercase tracking-wide text-slate-400"
                title={FLAG_CONFIG[k].desc}
              >
                {FLAG_CONFIG[k].shortLabel}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const rate = (row.intervention_rate * 100).toFixed(1);
            const rateColor =
              row.intervention_rate === 0
                ? "text-emerald-600 bg-emerald-50"
                : row.intervention_rate < 0.05
                ? "text-amber-600 bg-amber-50"
                : "text-rose-600 bg-rose-50";
            const isExpanded = expanded === row.account_id;

            return (
              <tr
                key={row.account_id}
                className={`cursor-pointer border-b border-slate-100 last:border-b-0 transition-colors hover:bg-slate-50 ${
                  isExpanded ? "bg-slate-50" : ""
                }`}
                onClick={() =>
                  setExpanded(isExpanded ? null : row.account_id)
                }
              >
                <td className="px-5 py-3">
                  <div className="font-medium text-slate-900">{row.account_name}</div>
                  <div className="font-mono text-[10px] text-slate-400">
                    {row.account_id}
                  </div>
                </td>
                <td className="px-3 py-3 text-right tabular-nums text-slate-700">
                  {row.total.toLocaleString("pt-BR")}
                </td>
                <td className="px-3 py-3 text-right tabular-nums">
                  <span
                    className={`font-semibold ${
                      row.intervention_count > 0
                        ? "text-slate-900"
                        : "text-slate-300"
                    }`}
                  >
                    {row.intervention_count}
                  </span>
                </td>
                <td className="px-3 py-3 text-right">
                  <span
                    className={`inline-block rounded-full px-2 py-0.5 text-[11px] font-semibold tabular-nums ${rateColor}`}
                  >
                    {rate}%
                  </span>
                </td>
                {FLAG_KEYS.map((k) => {
                  const v = row.flags[k] ?? 0;
                  return (
                    <td key={k} className="px-3 py-3 text-right tabular-nums">
                      {v > 0 ? (
                        <span
                          className={`inline-block rounded px-1.5 py-0.5 text-xs font-semibold ${FLAG_CONFIG[k].badge}`}
                        >
                          {v}
                        </span>
                      ) : (
                        <span className="text-slate-300">—</span>
                      )}
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ─── Per-model table ──────────────────────────────────────────────────────────

interface ModelDayRow {
  day: string;
  model: string;
  total: number;
  flags: Record<string, number>;
}

function ModelTable({ rows }: { rows: ModelDayRow[] }) {
  if (rows.length === 0)
    return (
      <p className="p-5 text-sm text-slate-400">Sem dados no período.</p>
    );

  return (
    <div className="overflow-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-slate-100 text-left">
            <th className="px-5 py-2.5 text-xs font-semibold uppercase tracking-wide text-slate-400">
              Dia
            </th>
            <th className="px-3 py-2.5 text-xs font-semibold uppercase tracking-wide text-slate-400">
              Modelo
            </th>
            <th className="px-3 py-2.5 text-right text-xs font-semibold uppercase tracking-wide text-slate-400">
              Replies
            </th>
            {FLAG_KEYS.map((k) => (
              <th
                key={k}
                className="px-3 py-2.5 text-right text-xs font-semibold uppercase tracking-wide text-slate-400"
              >
                {FLAG_CONFIG[k].shortLabel}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr
              key={`${r.day}::${r.model}`}
              className="border-b border-slate-100 last:border-b-0 hover:bg-slate-50"
            >
              <td className="px-5 py-2.5 font-mono text-xs text-slate-600">
                {r.day}
              </td>
              <td className="max-w-[180px] truncate px-3 py-2.5 font-mono text-xs text-slate-700">
                {r.model}
              </td>
              <td className="px-3 py-2.5 text-right tabular-nums text-slate-700">
                {r.total}
              </td>
              {FLAG_KEYS.map((k) => {
                const v = r.flags[k] ?? 0;
                return (
                  <td key={k} className="px-3 py-2.5 text-right tabular-nums">
                    {v > 0 ? (
                      <span
                        className={`inline-block rounded px-1.5 py-0.5 text-xs font-semibold ${FLAG_CONFIG[k].badge}`}
                      >
                        {v}
                      </span>
                    ) : (
                      <span className="text-slate-300">—</span>
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
