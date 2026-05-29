import { createFileRoute, Link, Outlet, useNavigate } from "@tanstack/react-router";
import {
  LogOut,
  Users,
  LayoutTemplate,
  Activity,
  History,
  Zap,
  Server,
} from "lucide-react";
import { useAuth } from "@/lib/auth";

export const Route = createFileRoute("/_authenticated/admin")({
  component: AdminLayout,
});

const NAV_ITEMS = [
  { to: "/admin", label: "Contas", icon: Users, exact: true },
  { to: "/admin/templates", label: "Templates", icon: LayoutTemplate, exact: false },
  { to: "/admin/telemetry", label: "Telemetria", icon: Activity, exact: false },
  { to: "/admin/replay", label: "Replay", icon: History, exact: false },
  { to: "/admin/evolution", label: "Evolution", icon: Zap, exact: false },
  { to: "/admin/diagnostics", label: "Diagnóstico", icon: Server, exact: false },
] as const;

function AdminLayout() {
  const { user, signOut } = useAuth();
  const navigate = useNavigate();

  const handleSignOut = async () => {
    await signOut();
    navigate({ to: "/login" });
  };

  const initials = (user?.email ?? "?").slice(0, 2).toUpperCase();

  return (
    <div className="flex min-h-screen bg-slate-50">
      {/* ── Sidebar ── */}
      <aside className="fixed inset-y-0 left-0 z-30 flex w-60 flex-col border-r border-slate-200 bg-white">
        {/* Nav */}
        <nav className="flex-1 space-y-1 px-3 py-4">
          {NAV_ITEMS.map((item) => (
            <Link
              key={item.to}
              to={item.to}
              activeOptions={{ exact: item.exact }}
              activeProps={{
                className:
                  "bg-violet-50 text-violet-700 font-semibold",
              }}
              inactiveProps={{
                className:
                  "text-slate-600 hover:bg-slate-100 hover:text-slate-900",
              }}
              className="flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors"
            >
              <item.icon className="h-4 w-4 shrink-0" />
              {item.label}
            </Link>
          ))}
        </nav>

        {/* User footer */}
        <div className="border-t border-slate-100 p-3">
          <div className="flex items-center gap-3 rounded-lg px-2 py-2">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-slate-200 text-[11px] font-semibold text-slate-600">
              {initials}
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate text-xs font-medium text-slate-700" title={user?.email ?? ""}>
                {user?.email ?? "—"}
              </p>
            </div>
            <button
              onClick={handleSignOut}
              title="Sair"
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-slate-400 transition-colors hover:bg-rose-50 hover:text-rose-600"
            >
              <LogOut className="h-4 w-4" />
            </button>
          </div>
        </div>
      </aside>

      {/* ── Main ── */}
      <main className="ml-60 flex-1">
        <div className="mx-auto max-w-6xl px-8 py-8">
          <Outlet />
        </div>
      </main>
    </div>
  );
}
