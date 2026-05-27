// Painel de telemetria — contagem por modelo/dia das intervenções
// determinísticas que o orquestrador aplica (duplicate reply, false booking
// claim, preflight blocked etc). Permite identificar quais modelos estão mais
// frágeis e quando uma regressão começou.

import { createFileRoute, Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ArrowLeft, RefreshCw } from "lucide-react";

import { getTelemetryStats } from "@/lib/telemetry.functions";

export const Route = createFileRoute("/_authenticated/admin/telemetry")({
  component: AdminTelemetry,
});

const FLAG_LABELS: Record<string, string> = {
  duplicate_reply_blocked: "Reply duplicada bloqueada",
  false_booking_claim_blocked: "Confirmação falsa bloqueada",
  forced_scheduling_advance: "Avanço forçado p/ agendamento",
  preflight_blocked: "Preflight bloqueado",
};

const FLAG_KEYS = Object.keys(FLAG_LABELS);

function AdminTelemetry() {
  const fetchStats = useServerFn(getTelemetryStats);
  const [days, setDays] = useState(7);

  const q = useQuery({
    queryKey: ["admin", "telemetry", days],
    queryFn: () => fetchStats({ data: { days } }),
  });

  const stats = q.data;

  return (
    <div className="container mx-auto max-w-6xl space-y-6 p-6">
      <div className="flex items-center gap-2">
        <Link to="/admin">
          <Button variant="ghost" size="sm">
            <ArrowLeft className="h-4 w-4" />
            Voltar
          </Button>
        </Link>
        <h1 className="text-2xl font-semibold">Telemetria do orquestrador</h1>
        <div className="ml-auto flex items-center gap-2">
          <select
            value={days}
            onChange={(e) => setDays(Number(e.target.value))}
            className="rounded border bg-background px-2 py-1 text-sm"
          >
            {[1, 3, 7, 14, 30].map((d) => (
              <option key={d} value={d}>
                Últimos {d} dia{d > 1 ? "s" : ""}
              </option>
            ))}
          </select>
          <Button variant="outline" size="sm" onClick={() => q.refetch()}>
            <RefreshCw className="h-4 w-4" /> Atualizar
          </Button>
        </div>
      </div>

      {q.isLoading && <Card className="p-4 text-sm">Carregando...</Card>}
      {q.isError && (
        <Card className="border-destructive p-4 text-sm text-destructive">
          {(q.error as Error).message}
        </Card>
      )}

      {stats && (
        <>
          <Card className="p-4">
            <div className="mb-3 text-sm font-semibold">
              Totais (janela completa — {stats.totals.total} replies do assistente)
            </div>
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              {FLAG_KEYS.map((k) => {
                const v = stats.totals.flags[k as keyof typeof stats.totals.flags] ?? 0;
                const pct = stats.totals.total
                  ? ((v / stats.totals.total) * 100).toFixed(1)
                  : "0";
                return (
                  <div key={k} className="rounded border p-2">
                    <div className="text-xs text-muted-foreground">{FLAG_LABELS[k]}</div>
                    <div className="text-2xl font-semibold">{v}</div>
                    <div className="text-xs text-muted-foreground">{pct}% das replies</div>
                  </div>
                );
              })}
            </div>
          </Card>

          <Card className="p-4">
            <div className="mb-2 text-sm font-semibold">Por dia (total)</div>
            <TelemetryTable rows={stats.totalsByDay} />
          </Card>

          <Card className="p-4">
            <div className="mb-2 text-sm font-semibold">Por modelo × dia</div>
            <TelemetryModelDayTable rows={stats.byModelDay} />
          </Card>
        </>
      )}
    </div>
  );
}

interface DailyRow {
  day: string;
  total: number;
  flags: Record<string, number>;
}

function TelemetryTable({ rows }: { rows: DailyRow[] }) {
  if (rows.length === 0) return <div className="text-sm text-muted-foreground">Sem dados.</div>;
  return (
    <div className="overflow-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b text-left">
            <th className="px-2 py-1">Dia</th>
            <th className="px-2 py-1">Replies</th>
            {FLAG_KEYS.map((k) => (
              <th key={k} className="px-2 py-1 text-right">
                {FLAG_LABELS[k]}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.day} className="border-b last:border-b-0">
              <td className="px-2 py-1 font-mono">{r.day}</td>
              <td className="px-2 py-1">{r.total}</td>
              {FLAG_KEYS.map((k) => (
                <td key={k} className="px-2 py-1 text-right">
                  {r.flags[k] ?? 0}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

interface ModelDayRow {
  day: string;
  model: string;
  total: number;
  flags: Record<string, number>;
}

function TelemetryModelDayTable({ rows }: { rows: ModelDayRow[] }) {
  if (rows.length === 0) return <div className="text-sm text-muted-foreground">Sem dados.</div>;
  return (
    <div className="overflow-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b text-left">
            <th className="px-2 py-1">Dia</th>
            <th className="px-2 py-1">Modelo</th>
            <th className="px-2 py-1">Replies</th>
            {FLAG_KEYS.map((k) => (
              <th key={k} className="px-2 py-1 text-right">
                {FLAG_LABELS[k]}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={`${r.day}::${r.model}`} className="border-b last:border-b-0">
              <td className="px-2 py-1 font-mono">{r.day}</td>
              <td className="px-2 py-1 font-mono text-xs">{r.model}</td>
              <td className="px-2 py-1">{r.total}</td>
              {FLAG_KEYS.map((k) => (
                <td
                  key={k}
                  className={`px-2 py-1 text-right ${(r.flags[k] ?? 0) > 0 ? "font-semibold" : ""}`}
                >
                  {r.flags[k] ?? 0}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
