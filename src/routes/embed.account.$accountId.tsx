import { createFileRoute, Link, Outlet } from "@tanstack/react-router";
import { useEffect } from "react";
import { Bot, LogOut } from "lucide-react";
import { useSession } from "@/lib/session";

export const Route = createFileRoute("/embed/account/$accountId")({
  component: AccountLayout,
});

const TABS = [
  { to: "/embed/account/$accountId/overview", label: "Visão geral" },
  { to: "/embed/account/$accountId/main-agent", label: "Agente Principal" },
  { to: "/embed/account/$accountId/training", label: "Treinamento" },
  { to: "/embed/account/$accountId/followup", label: "Follow-up" },
  { to: "/embed/account/$accountId/warmup", label: "Warm-up" },
  { to: "/embed/account/$accountId/integrations", label: "Integrações" },
  { to: "/embed/account/$accountId/media", label: "Mídias" },
  { to: "/embed/account/$accountId/automations", label: "Automações" },
  { to: "/embed/account/$accountId/conversations", label: "Conversas" },
  { to: "/embed/account/$accountId/logs", label: "Logs" },
] as const;

function AccountLayout() {
  const { accountId: paramAccountId } = Route.useParams();
  const { accountId, accountName, status, error, signIn, signOut } = useSession();

  // Autentica diretamente com o accountId da URL
  useEffect(() => {
    if (status === "idle" || (status === "authenticated" && accountId !== paramAccountId)) {
      signIn({ accountId: paramAccountId });
    }
  }, [status, accountId, paramAccountId, signIn]);

  if (status === "loading") {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background p-6">
        <div className="w-full max-w-sm rounded-lg border border-border bg-card p-6 text-center">
          <h1 className="text-base font-semibold">Carregando painel...</h1>
          <p className="mt-2 text-sm text-muted-foreground">Validando sessão com o backend.</p>
        </div>
      </div>
    );
  }

  if (status === "error") {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background p-6">
        <div className="w-full max-w-sm rounded-lg border border-border bg-card p-6 text-center">
          <h1 className="text-base font-semibold">Falha ao autenticar</h1>
          <p className="mt-2 text-sm text-muted-foreground">{error ?? "Não foi possível validar a sessão."}</p>
        </div>
      </div>
    );
  }

  if (status !== "authenticated" || accountId !== paramAccountId) {
    return null;
  }

  return (
    <div className="min-h-screen bg-background text-foreground">
      {import.meta.env.DEV && (
        <div className="border-b border-border bg-muted px-4 py-1.5 text-center text-[11px] text-muted-foreground">
          Modo preview — dados mockados, backend não está conectado.
        </div>
      )}
      <header className="border-b border-border bg-card">
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-4 px-4 py-3">
          <div className="flex items-center gap-2">
            <div className="flex h-8 w-8 items-center justify-center rounded-md bg-primary text-primary-foreground">
              <Bot className="h-5 w-5" />
            </div>
            <div className="leading-tight">
              <p className="text-sm font-semibold">{accountName ?? "Conta"}</p>
              <p className="text-[11px] text-muted-foreground">
                ID: {paramAccountId}
              </p>
            </div>
          </div>
          <button
            onClick={signOut}
            className="inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-xs hover:bg-accent"
          >
            <LogOut className="h-3.5 w-3.5" /> Sair
          </button>
        </div>
        <nav className="mx-auto flex max-w-7xl gap-1 overflow-x-auto px-2 pb-2">
          {TABS.map((tab) => (
            <Link
              key={tab.to}
              to={tab.to}
              params={{ accountId: paramAccountId }}
              search={{}}
              className="whitespace-nowrap rounded-md px-3 py-1.5 text-sm text-muted-foreground hover:bg-accent hover:text-foreground"
              activeProps={{ className: "bg-secondary text-secondary-foreground" }}
            >
              {tab.label}
            </Link>
          ))}
        </nav>
      </header>
      <main className="mx-auto max-w-7xl px-4 py-6">
        <Outlet />
      </main>
    </div>
  );
}
