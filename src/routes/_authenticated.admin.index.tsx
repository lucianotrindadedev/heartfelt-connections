import { createFileRoute, Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery } from "@tanstack/react-query";
import { listAccounts } from "@/lib/admin.functions";
import { Card } from "@/components/ui/card";
import { ChevronRight, Loader2 } from "lucide-react";

export const Route = createFileRoute("/_authenticated/admin/")({
  component: AdminIndex,
});

function AdminIndex() {
  const fetchAccounts = useServerFn(listAccounts);
  const q = useQuery({
    queryKey: ["admin", "accounts"],
    queryFn: () => fetchAccounts(),
  });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Contas</h1>
        <p className="text-sm text-muted-foreground">
          Todas as contas Helena conectadas — clique para ver performance e custos.
        </p>
      </div>

      {q.isLoading && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Carregando…
        </div>
      )}
      {q.error && (
        <p className="text-sm text-destructive">
          {q.error instanceof Error ? q.error.message : "Erro ao carregar"}
        </p>
      )}

      <div className="grid gap-3">
        {q.data?.accounts.map((a) => (
          <Link
            key={a.id}
            to="/admin/account/$accountId"
            params={{ accountId: a.id }}
            className="block"
          >
            <Card className="flex items-center justify-between p-4 hover:bg-accent/40 transition">
              <div>
                <div className="font-medium">{a.nome}</div>
                <div className="text-xs text-muted-foreground font-mono">{a.id}</div>
              </div>
              <ChevronRight className="h-4 w-4 text-muted-foreground" />
            </Card>
          </Link>
        ))}
        {q.data && q.data.accounts.length === 0 && (
          <Card className="p-6 text-center text-sm text-muted-foreground">
            Nenhuma conta ainda. Acesse <code>/embed?accountId=ID</code> para bootstrap.
          </Card>
        )}
      </div>
    </div>
  );
}
