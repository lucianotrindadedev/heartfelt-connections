import { createFileRoute, Outlet, useNavigate, useMatches } from "@tanstack/react-router";
import { useEffect } from "react";
import { useSession } from "@/lib/session";
import { IS_MOCK } from "@/lib/api";

interface EmbedSearch {
  accountId?: string;
}

export const Route = createFileRoute("/embed")({
  validateSearch: (search: Record<string, unknown>): EmbedSearch => ({
    accountId: 
      (search.accountId as string | undefined) ?? 
      (search.accountid as string | undefined) ?? 
      (search.account_id as string | undefined) ?? 
      (search.account as string | undefined) ?? 
      undefined,
  }),
  component: EmbedLayout,
});

/**
 * Layout route para /embed.
 * - Se a URL for /embed/account/$accountId (child route), renderiza <Outlet />
 * - Se a URL for /embed?accountId=UUID, autentica e redireciona
 * - Se a URL for /embed sem params, mostra erro
 */
function EmbedLayout() {
  const matches = useMatches();
  // Se há uma child route ativa (ex: /embed/account/$accountId), renderiza ela
  const hasChildRoute = matches.some(m => m.id !== "/embed" && m.id.startsWith("/embed/"));

  if (hasChildRoute) {
    return <Outlet />;
  }

  return <EmbedEntrypoint />;
}

function EmbedEntrypoint() {
  const search = Route.useSearch();
  const navigate = useNavigate();
  const { accountId, status, error, signIn } = useSession();

  const effectiveAccountId = search.accountId ?? (IS_MOCK ? "demo-account" : undefined);

  useEffect(() => {
    if (!effectiveAccountId) return;
    if (status === "authenticated" && accountId === effectiveAccountId) {
      navigate({
        to: "/embed/account/$accountId",
        params: { accountId: effectiveAccountId },
        search: {},
      });
      return;
    }
    if (status === "idle" || (status === "authenticated" && accountId !== effectiveAccountId)) {
      signIn({
        accountId: effectiveAccountId,
      });
    }
  }, [search, accountId, status, signIn, navigate, effectiveAccountId]);

  useEffect(() => {
    if (status === "authenticated" && accountId && accountId === effectiveAccountId) {
      navigate({
        to: "/embed/account/$accountId",
        params: { accountId },
        search: {},
      });
    }
  }, [status, accountId, effectiveAccountId, navigate]);

  if (!effectiveAccountId) {
    return (
      <CenteredCard
        title="Parâmetro accountId ausente"
        body="Este painel só pode ser aberto a partir do CRM Helena. Verifique a configuração do menu personalizado."
      />
    );
  }

  if (status === "error") {
    return (
      <CenteredCard
        title="Falha ao autenticar"
        body={error ?? "Não foi possível validar a sessão."}
      />
    );
  }

  return (
    <CenteredCard
      title="Carregando painel…"
      body="Validando sessão com o backend."
    />
  );
}

function CenteredCard({ title, body }: { title: string; body: string }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-6">
      <div className="w-full max-w-sm rounded-lg border border-border bg-card p-6 text-center">
        <h1 className="text-base font-semibold">{title}</h1>
        <p className="mt-2 text-sm text-muted-foreground">{body}</p>
      </div>
    </div>
  );
}
