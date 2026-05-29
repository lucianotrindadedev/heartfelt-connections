import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery } from "@tanstack/react-query";
import {
  RefreshCw, Cpu, MemoryStick, HardDrive, Database, Users,
  MessageSquare, Activity, DollarSign, Clock,
} from "lucide-react";
import {
  getSystemDiagnostics,
  getAccountUsage,
  type AccountUsageRow,
  type TableSize,
} from "@/lib/diagnostics.functions";

export const Route = createFileRoute("/_authenticated/admin/diagnostics")({
  component: AdminDiagnostics,
});

// ── Formatadores ──────────────────────────────────────────────────────────

function fmtBytes(b: number): string {
  if (!b || b < 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let v = b;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}

function fmtUptime(s: number): string {
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}min`;
  return `${m}min`;
}

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("pt-BR", {
    timeZone: "America/Sao_Paulo",
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

// ── Page ────────────────────────────────────────────────────────────────────

function AdminDiagnostics() {
  const fetchSys = useServerFn(getSystemDiagnostics);
  const fetchUsage = useServerFn(getAccountUsage);

  const sysQ = useQuery({
    queryKey: ["admin", "diagnostics", "system"],
    queryFn: () => fetchSys(),
    refetchInterval: 15_000, // atualiza RAM/CPU a cada 15s
  });
  const usageQ = useQuery({
    queryKey: ["admin", "diagnostics", "usage"],
    queryFn: () => fetchUsage(),
  });

  const sys = sysQ.data;
  const memPct = sys ? (sys.vps.mem_used_bytes / sys.vps.mem_total_bytes) * 100 : 0;
  const loadPct = sys ? (sys.vps.load_1m / Math.max(1, sys.vps.cpu_cores)) * 100 : 0;

  const memColor = memPct >= 90 ? "text-rose-600" : memPct >= 75 ? "text-amber-600" : "text-emerald-600";
  const loadColor = loadPct >= 90 ? "text-rose-600" : loadPct >= 70 ? "text-amber-600" : "text-emerald-600";

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900">Diagnóstico</h1>
          <p className="mt-0.5 text-sm text-slate-500">
            Uso do servidor e consumo por conta — atualiza a cada 15s.
          </p>
        </div>
        <button
          onClick={() => {
            sysQ.refetch();
            usageQ.refetch();
          }}
          disabled={sysQ.isFetching}
          className="flex h-9 w-9 items-center justify-center rounded-lg border border-slate-200 bg-white text-slate-500 shadow-sm transition-colors hover:bg-slate-50 disabled:opacity-50"
        >
          <RefreshCw className={`h-4 w-4 ${sysQ.isFetching ? "animate-spin" : ""}`} />
        </button>
      </div>

      {sysQ.isError && (
        <div className="rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-700">
          {(sysQ.error as Error).message}
        </div>
      )}

      {/* ── VPS ── */}
      {sys && (
        <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-4">
          <DiagCard
            icon={<MemoryStick className="h-4 w-4" />}
            iconBg="bg-blue-50 text-blue-600"
            label="Memória"
            value={`${memPct.toFixed(0)}%`}
            valueColor={memColor}
            sub={`${fmtBytes(sys.vps.mem_used_bytes)} / ${fmtBytes(sys.vps.mem_total_bytes)}`}
            bar={memPct}
          />
          <DiagCard
            icon={<Cpu className="h-4 w-4" />}
            iconBg="bg-amber-50 text-amber-600"
            label="CPU (load 1m)"
            value={`${loadPct.toFixed(0)}%`}
            valueColor={loadColor}
            sub={`load ${sys.vps.load_1m.toFixed(2)} · ${sys.vps.cpu_cores} núcleos`}
            bar={loadPct}
          />
          <DiagCard
            icon={<Database className="h-4 w-4" />}
            iconBg="bg-violet-50 text-violet-600"
            label="Banco de dados"
            value={fmtBytes(sys.db.total_bytes)}
            sub={`${sys.db.tables.length} tabelas`}
          />
          <DiagCard
            icon={<Clock className="h-4 w-4" />}
            iconBg="bg-slate-100 text-slate-600"
            label="App online há"
            value={fmtUptime(sys.vps.uptime_seconds)}
            sub={`Node ${sys.vps.node_version} · RSS ${fmtBytes(sys.vps.process_rss_bytes)}`}
          />
        </div>
      )}

      {/* ── Tabelas do banco ── */}
      {sys && sys.db.tables.length > 0 && (
        <div className="rounded-xl border border-slate-200 bg-white shadow-sm">
          <div className="flex items-center gap-2 border-b border-slate-100 px-5 py-4">
            <HardDrive className="h-4 w-4 text-slate-400" />
            <p className="text-sm font-semibold text-slate-900">Maiores tabelas</p>
          </div>
          <TablesTable rows={sys.db.tables} />
        </div>
      )}

      {/* ── Por conta ── */}
      <div className="rounded-xl border border-slate-200 bg-white shadow-sm">
        <div className="flex items-center gap-2 border-b border-slate-100 px-5 py-4">
          <Users className="h-4 w-4 text-slate-400" />
          <p className="text-sm font-semibold text-slate-900">Consumo por conta</p>
          {usageQ.data && (
            <span className="ml-auto rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-semibold text-slate-500">
              {usageQ.data.accounts.length} conta(s)
            </span>
          )}
        </div>
        {usageQ.isLoading ? (
          <p className="flex items-center gap-2 p-5 text-sm text-slate-500">
            <RefreshCw className="h-4 w-4 animate-spin" /> Carregando…
          </p>
        ) : usageQ.data && usageQ.data.accounts.length > 0 ? (
          <UsageTable rows={usageQ.data.accounts} />
        ) : (
          <p className="p-5 text-sm text-slate-400">Sem dados.</p>
        )}
      </div>
    </div>
  );
}

// ── Componentes ───────────────────────────────────────────────────────────

function DiagCard({
  icon, iconBg, label, value, valueColor, sub, bar,
}: {
  icon: React.ReactNode;
  iconBg: string;
  label: string;
  value: string;
  valueColor?: string;
  sub?: string;
  bar?: number;
}) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="flex items-center gap-2.5">
        <span className={`flex h-8 w-8 items-center justify-center rounded-lg ${iconBg}`}>
          {icon}
        </span>
        <span className="text-[11px] font-medium uppercase tracking-wide text-slate-400">
          {label}
        </span>
      </div>
      <div className={`mt-2.5 text-2xl font-bold tabular-nums ${valueColor ?? "text-slate-900"}`}>
        {value}
      </div>
      {bar !== undefined && (
        <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-slate-100">
          <div
            className={`h-full rounded-full ${
              bar >= 90 ? "bg-rose-500" : bar >= 75 ? "bg-amber-500" : "bg-emerald-500"
            }`}
            style={{ width: `${Math.min(100, bar)}%` }}
          />
        </div>
      )}
      {sub && <p className="mt-1.5 text-[11px] text-slate-400">{sub}</p>}
    </div>
  );
}

function TablesTable({ rows }: { rows: TableSize[] }) {
  const max = Math.max(...rows.map((r) => r.total_bytes), 1);
  return (
    <div className="overflow-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-slate-100 text-left">
            <th className="px-5 py-2.5 text-xs font-semibold uppercase tracking-wide text-slate-400">Tabela</th>
            <th className="px-3 py-2.5 text-right text-xs font-semibold uppercase tracking-wide text-slate-400">Tamanho</th>
            <th className="px-3 py-2.5 text-right text-xs font-semibold uppercase tracking-wide text-slate-400">Linhas (est.)</th>
            <th className="w-32 px-5 py-2.5" />
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.table_name} className="border-b border-slate-100 last:border-b-0 hover:bg-slate-50">
              <td className="px-5 py-2.5 font-mono text-xs text-slate-700">{r.table_name}</td>
              <td className="px-3 py-2.5 text-right tabular-nums text-slate-700">{r.total_pretty}</td>
              <td className="px-3 py-2.5 text-right tabular-nums text-slate-500">
                {r.row_estimate >= 0 ? r.row_estimate.toLocaleString("pt-BR") : "—"}
              </td>
              <td className="px-5 py-2.5">
                <div className="h-1.5 w-full overflow-hidden rounded-full bg-slate-100">
                  <div
                    className="h-full rounded-full bg-violet-400"
                    style={{ width: `${(r.total_bytes / max) * 100}%` }}
                  />
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function UsageTable({ rows }: { rows: AccountUsageRow[] }) {
  return (
    <div className="overflow-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-slate-100 text-left">
            <th className="px-5 py-2.5 text-xs font-semibold uppercase tracking-wide text-slate-400">Conta</th>
            <th className="px-3 py-2.5 text-right text-xs font-semibold uppercase tracking-wide text-slate-400">
              <span className="inline-flex items-center gap-1"><MessageSquare className="h-3 w-3" />Conversas</span>
            </th>
            <th className="px-3 py-2.5 text-right text-xs font-semibold uppercase tracking-wide text-slate-400">Mensagens</th>
            <th className="px-3 py-2.5 text-right text-xs font-semibold uppercase tracking-wide text-slate-400">
              <span className="inline-flex items-center gap-1"><Activity className="h-3 w-3" />Turns</span>
            </th>
            <th className="px-3 py-2.5 text-right text-xs font-semibold uppercase tracking-wide text-slate-400">
              <span className="inline-flex items-center gap-1"><DollarSign className="h-3 w-3" />Custo</span>
            </th>
            <th className="px-3 py-2.5 text-right text-xs font-semibold uppercase tracking-wide text-slate-400">Última atividade</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.account_id} className="border-b border-slate-100 last:border-b-0 hover:bg-slate-50">
              <td className="px-5 py-3">
                <div className="font-medium text-slate-900">{r.nome}</div>
                <div className="font-mono text-[10px] text-slate-400">{r.account_id}</div>
              </td>
              <td className="px-3 py-3 text-right tabular-nums text-slate-700">{r.conversations.toLocaleString("pt-BR")}</td>
              <td className="px-3 py-3 text-right tabular-nums text-slate-700">{r.messages.toLocaleString("pt-BR")}</td>
              <td className="px-3 py-3 text-right tabular-nums text-slate-700">{r.agent_runs.toLocaleString("pt-BR")}</td>
              <td className="px-3 py-3 text-right tabular-nums text-slate-700">${Number(r.cost_usd ?? 0).toFixed(4)}</td>
              <td className="px-3 py-3 text-right text-xs tabular-nums text-slate-500">{fmtDate(r.last_activity)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
