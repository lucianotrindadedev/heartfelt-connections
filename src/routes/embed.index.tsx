import { createFileRoute, Navigate } from "@tanstack/react-router";

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
  return <Navigate to="/embed/account/$accountId" params={{ accountId }} />;
}
