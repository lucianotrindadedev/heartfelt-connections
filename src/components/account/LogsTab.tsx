import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import type { AgentRun } from "@/lib/types";

export function LogsTab({ accountId }: { accountId: string }) {
  const runs = useQuery({
    queryKey: ["runs", accountId],
    queryFn: () => api<AgentRun[]>(`/api/accounts/${accountId}/runs`),
  });

  return (
    <div className="rounded-lg border border-border bg-card">
      <table className="w-full text-sm">
        <thead className="border-b border-border text-left text-xs uppercase text-muted-foreground">
          <tr>
            <th className="px-3 py-2">Quando</th>
            <th className="px-3 py-2">Telefone</th>
            <th className="px-3 py-2">Status</th>
            <th className="px-3 py-2">Latência</th>
            <th className="px-3 py-2">Tokens</th>
            <th className="px-3 py-2">Custo</th>
            <th className="px-3 py-2">Tools</th>
          </tr>
        </thead>
        <tbody>
          {runs.data?.length === 0 && (
            <tr>
              <td colSpan={7} className="p-4 text-center text-muted-foreground">
                Sem execuções.
              </td>
            </tr>
          )}
          {runs.data?.map((r) => (
            <tr key={r.id} className="border-b border-border last:border-0">
              <td className="px-3 py-2 text-xs text-muted-foreground">
                {new Date(r.created_at).toLocaleString()}
              </td>
              <td className="px-3 py-2">{r.phone ?? "—"}</td>
              <td className="px-3 py-2">
                <span
                  className={
                    r.status === "ok"
                      ? "rounded-full bg-secondary px-2 py-0.5 text-xs"
                      : r.status === "error"
                        ? "rounded-full bg-destructive/10 px-2 py-0.5 text-xs text-destructive"
                        : "rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground"
                  }
                >
                  {r.status}
                </span>
              </td>
              <td className="px-3 py-2 text-xs">{r.latency_ms} ms</td>
              <td className="px-3 py-2 text-xs">
                {r.tokens_in} → {r.tokens_out}
              </td>
              <td className="px-3 py-2 text-xs">
                US$ {r.cost_usd.toFixed(4)}
              </td>
              <td className="px-3 py-2 text-xs text-muted-foreground">
                {r.tools_called.join(", ") || "—"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
