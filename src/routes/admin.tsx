import { createFileRoute, Link, Outlet, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Bot, LogOut } from "lucide-react";
import { getAdminToken, setAdminToken, clearAdminToken } from "@/lib/api";

export const Route = createFileRoute("/admin")({
  component: AdminLayout,
});

function AdminLayout() {
  const [token, setToken] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const navigate = useNavigate();

  useEffect(() => {
    setToken(getAdminToken());
  }, []);

  if (!token) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background p-6">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!draft) return;
            setAdminToken(draft);
            setToken(draft);
          }}
          className="w-full max-w-sm space-y-4 rounded-lg border border-border bg-card p-6"
        >
          <h1 className="text-base font-semibold">Painel Admin</h1>
          <p className="text-xs text-muted-foreground">
            Cole a chave de admin (env <code>ADMIN_API_KEY</code> do backend).
          </p>
          <input
            type="password"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            className="input"
            placeholder="admin-key"
          />
          <button className="w-full rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground">
            Entrar
          </button>
        </form>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="border-b border-border bg-card">
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-4 px-4 py-3">
          <div className="flex items-center gap-2">
            <div className="flex h-8 w-8 items-center justify-center rounded-md bg-primary text-primary-foreground">
              <Bot className="h-5 w-5" />
            </div>
            <span className="text-sm font-semibold">Admin · Sarai Platform</span>
          </div>
          <div className="flex items-center gap-2 text-sm">
            <Link
              to="/admin"
              className="rounded-md px-2.5 py-1 hover:bg-accent"
              activeOptions={{ exact: true }}
              activeProps={{ className: "bg-secondary" }}
            >
              Contas
            </Link>
            <Link
              to="/admin/templates"
              className="rounded-md px-2.5 py-1 hover:bg-accent"
              activeProps={{ className: "bg-secondary" }}
            >
              Templates
            </Link>
            <button
              onClick={() => {
                clearAdminToken();
                setToken(null);
                navigate({ to: "/admin" });
              }}
              className="inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-xs hover:bg-accent"
            >
              <LogOut className="h-3.5 w-3.5" /> Sair
            </button>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-7xl px-4 py-6">
        <Outlet />
      </main>
    </div>
  );
}
