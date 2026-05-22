import { createFileRoute, Navigate, useNavigate } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery } from "@tanstack/react-query";
import { listAccountsByHelena } from "@/lib/admin.functions";
import { Loader2, Bot, ChevronRight } from "lucide-react";

interface EmbedSearch {
  accountId?: string;
}

export const Route = createFileRoute("/embed/")({
  validateSearch: (search: Record<string, unknown>): EmbedSearch => ({
    accountId:
      (search.accountId as string | undefined) ??
      (search.accountid as string | undefined) ??
      (search.account_id as string | undefined) ??
      (search.account as string | undefined) ??
      undefined,
  }),
  component: EmbedEntry,
});

function EmbedEntry() {
  const { accountId } = Route.useSearch();
  const fetchByHelena = useServerFn(listAccountsByHelena);

  const q = useQuery({
    queryKey: ["embed-accounts-by-helena", accountId],
    queryFn: () => fetchByHelena({ data: { helenaAccountId: accountId! } }),
    enabled: !!accountId,
    retry: false,
  });

  if (!accountId) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background p-6">
        <div className="w-full max-w-sm rounded-lg border bg-card p-6 text-center">
          <h1 className="text-base font-semibold">Parâmetro accountId ausente</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Este painel só pode ser aberto pelo CRM Helena com <code>?accountId=...</code>.
          </p>
        </div>
      </div>
    );
  }

  if (q.isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const accounts = q.data?.accounts ?? [];

  // Nenhuma conta com esse helena_account_id → tenta como ID interno direto
  if (accounts.length === 0) {
    return <Navigate to="/embed/account/$accountId" params={{ accountId }} />;
  }

  // Uma única conta → redireciona direto (sem mostrar seletor)
  if (accounts.length === 1) {
    return <Navigate to="/embed/account/$accountId" params={{ accountId: accounts[0].id }} />;
  }

  // Múltiplas contas para o mesmo Helena CRM → seletor
  return <AccountSelector accounts={accounts} />;
}

function AccountSelector({
  accounts,
}: {
  accounts: { id: string; nome: string }[];
}) {
  const navigate = useNavigate();

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-6">
      <div className="w-full max-w-sm">
        {/* Header */}
        <div className="mb-6 text-center">
          <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-primary/10">
            <Bot className="h-6 w-6 text-primary" />
          </div>
          <h1 className="text-lg font-semibold">Selecionar agente</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Esta conta do Helena tem {accounts.length} agentes configurados.
            Selecione qual deseja gerenciar.
          </p>
        </div>

        {/* Lista de contas */}
        <div className="space-y-2">
          {accounts.map((a, i) => (
            <button
              key={a.id}
              onClick={() =>
                navigate({
                  to: "/embed/account/$accountId",
                  params: { accountId: a.id },
                })
              }
              className="flex w-full items-center justify-between rounded-xl border bg-card p-4 text-left transition hover:bg-accent/50 hover:border-primary/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
            >
              <div className="flex items-center gap-3">
                <div className="flex h-8 w-8 items-center justify-center rounded-full bg-primary/10 text-xs font-bold text-primary">
                  {i + 1}
                </div>
                <div>
                  <p className="font-medium text-sm">{a.nome}</p>
                  <p className="text-[11px] font-mono text-muted-foreground">{a.id}</p>
                </div>
              </div>
              <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
