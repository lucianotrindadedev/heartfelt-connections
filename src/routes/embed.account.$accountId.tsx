import { createFileRoute, Link, Outlet, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { Bot, LogOut } from "lucide-react";
import { useSession } from "@/lib/session";

export const Route = createFileRoute("/embed/account/$accountId")({
  component: AccountLayout,
});

const TABS: Array<{ to: string; label: string }> = [
  { to: "overview", label: "Visão geral" },
  { to: "main-agent", label: "Agente Principal" },
  { to: "followup", label: "Follow-up" },
  { to: "warmup", label: "Warm-up" },
  { to: "integrations", label: "Integrações" },
  { to: "media", label: "Mídias" },
  { to: "automations", label: "Automações" },
  { to: "conversations", label: "Conversas" },
  { to: "logs", label: "Logs" },
];

function AccountLayout() {
  const { accountId: paramAccountId } = Route.useParams();
  const { accountId, accountName, status, signOut } = useSession();
  const navigate = useNavigate();

  useEffect(() => {
    if (status === "idle" || (status !== "loading" && accountId !== paramAccountId)) {
      // Sessão não corresponde — volta para o entrypoint /embed.
      navigate({ to: "/embed", search: { accountId: paramAccountId } });
    }
  }, [status, accountId, paramAccountId, navigate]);

  return (
    <div className="min-h-screen bg-background text-foreground">
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
              from={Route.fullPath}
              className="whitespace-nowrap rounded-md px-3 py-1.5 text-sm text-muted-foreground hover:bg-accent hover:text-foreground data-[status=active]:bg-secondary data-[status=active]:text-secondary-foreground"
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
