import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import type { Agent, DashboardStats } from "@/lib/types";

interface OverviewProps {
  accountId: string;
}

export function OverviewTab({ accountId }: OverviewProps) {
  const stats = useQuery({
    queryKey: ["stats", accountId],
    queryFn: () => api<DashboardStats>(`/api/accounts/${accountId}/stats`),
  });
  const agents = useQuery({
    queryKey: ["agents", accountId],
    queryFn: () => api<Agent[]>(`/api/accounts/${accountId}/agents`),
  });

  return (
    <div className="space-y-6">
      <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="Agentes ativos"
          value={stats.data?.agents_active ?? "—"}
          loading={stats.isLoading}
        />
        <StatCard
          label="Mensagens 24h"
          value={stats.data?.messages_24h ?? "—"}
          loading={stats.isLoading}
        />
        <StatCard
          label="Custo estimado 24h"
          value={
            stats.data
              ? `US$ ${stats.data.estimated_cost_24h_usd.toFixed(3)}`
              : "—"
          }
          loading={stats.isLoading}
        />
        <StatCard
          label="Fila atual"
          value={stats.data?.queue_size ?? "—"}
          loading={stats.isLoading}
        />
      </section>

      <section>
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Agentes desta conta
        </h2>
        <div className="rounded-lg border border-border bg-card">
          {agents.isLoading && (
            <p className="p-4 text-sm text-muted-foreground">Carregando…</p>
          )}
          {agents.isError && (
            <p className="p-4 text-sm text-destructive">
              Erro ao carregar agentes. Verifique se o backend está acessível em
              VITE_API_BASE_URL.
            </p>
          )}
          {agents.data && agents.data.length === 0 && (
            <p className="p-4 text-sm text-muted-foreground">
              Nenhum agente criado. Use o painel Admin para criar.
            </p>
          )}
          {agents.data && agents.data.length > 0 && (
            <table className="w-full text-sm">
              <thead className="border-b border-border text-left text-xs uppercase text-muted-foreground">
                <tr>
                  <th className="px-4 py-2">Nome</th>
                  <th className="px-4 py-2">Tipo</th>
                  <th className="px-4 py-2">Modelo</th>
                  <th className="px-4 py-2">Status</th>
                </tr>
              </thead>
              <tbody>
                {agents.data.map((agent) => (
                  <tr key={agent.id} className="border-b border-border last:border-0">
                    <td className="px-4 py-2 font-medium">{agent.name}</td>
                    <td className="px-4 py-2 text-muted-foreground">{agent.kind}</td>
                    <td className="px-4 py-2 text-muted-foreground">
                      {agent.llm_provider}/{agent.llm_model}
                    </td>
                    <td className="px-4 py-2">
                      <span
                        className={
                          agent.enabled
                            ? "rounded-full bg-secondary px-2 py-0.5 text-xs"
                            : "rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground"
                        }
                      >
                        {agent.enabled ? "Ativo" : "Pausado"}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </section>
    </div>
  );
}

function StatCard({
  label,
  value,
  loading,
}: {
  label: string;
  value: string | number;
  loading?: boolean;
}) {
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <p className="text-xs uppercase tracking-wide text-muted-foreground">
        {label}
      </p>
      <p className="mt-2 text-2xl font-semibold">{loading ? "…" : value}</p>
    </div>
  );
}
