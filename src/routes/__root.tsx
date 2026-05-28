import { Outlet, Link, createRootRouteWithContext, HeadContent, Scripts } from "@tanstack/react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AuthProvider } from "@/lib/auth";
import { Toaster } from "@/components/ui/sonner";
import { useEffect } from "react";

import appCss from "../styles.css?url";

interface RouterContext {
  queryClient: QueryClient;
}

function NotFoundComponent() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="max-w-md text-center">
        <h1 className="text-7xl font-bold text-foreground">404</h1>
        <h2 className="mt-4 text-xl font-semibold text-foreground">Page not found</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          The page you're looking for doesn't exist or has been moved.
        </p>
        <div className="mt-6">
          <Link
            to="/"
            className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Go home
          </Link>
        </div>
      </div>
    </div>
  );
}

export const Route = createRootRouteWithContext<RouterContext>()({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "Sarai Platform — Agentes IA para CRM" },
      { name: "description", content: "Painel de agentes IA para CRM" },
      { property: "og:title", content: "Sarai Platform — Agentes IA para CRM" },
      { name: "twitter:title", content: "Sarai Platform — Agentes IA para CRM" },
      { property: "og:description", content: "Painel de agentes IA para CRM" },
      { name: "twitter:description", content: "Painel de agentes IA para CRM" },
      { property: "og:image", content: "https://pub-bb2e103a32db4e198524a2e9ed8f35b4.r2.dev/a50716e6-013e-4dda-8739-1c31e99a948a/id-preview-0baf5f78--b9def3f2-cdca-46bd-bd60-e390afc0784f.lovable.app-1779233881319.png" },
      { name: "twitter:image", content: "https://pub-bb2e103a32db4e198524a2e9ed8f35b4.r2.dev/a50716e6-013e-4dda-8739-1c31e99a948a/id-preview-0baf5f78--b9def3f2-cdca-46bd-bd60-e390afc0784f.lovable.app-1779233881319.png" },
      { name: "twitter:card", content: "summary_large_image" },
      { property: "og:type", content: "website" },
    ],
    links: [
      { rel: "preconnect", href: "https://fonts.googleapis.com" },
      { rel: "preconnect", href: "https://fonts.gstatic.com", crossOrigin: "anonymous" },
      { rel: "stylesheet", href: "https://fonts.googleapis.com/css2?family=Poppins:wght@300;400;500;600;700&display=swap" },
      { rel: "stylesheet", href: appCss },
    ],
  }),
  shellComponent: RootShell,
  component: RootComponent,
  notFoundComponent: NotFoundComponent,
});

function RootShell({ children }: { children: React.ReactNode }) {
  return (
    <html lang="pt-BR">
      <head>
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  );
}

// Detecta cliente com bundle desatualizado após um novo deploy e recarrega.
// O TanStack Start gera IDs de serverFn por hash do conteúdo — após redeploy
// o servidor tem novos IDs mas o cliente ainda usa os antigos. Um reload
// baixa o novo bundle e resolve o problema silenciosamente.
const STALE_RELOAD_KEY = "sfn_last_reload";
const STALE_RELOAD_COOLDOWN_MS = 5 * 60 * 1000; // 5 min entre reloads

function useStaleClientReload() {
  useEffect(() => {
    const handler = (event: PromiseRejectionEvent) => {
      const msg: string =
        event.reason?.message ??
        event.reason?.cause?.message ??
        String(event.reason ?? "");
      if (!msg.includes("Server function module export not resolved")) return;

      const lastReload = parseInt(
        sessionStorage.getItem(STALE_RELOAD_KEY) ?? "0",
        10,
      );
      if (Date.now() - lastReload < STALE_RELOAD_COOLDOWN_MS) return;

      console.warn(
        "[app] serverFn ID desatualizado — novo deploy detectado, recarregando…",
      );
      sessionStorage.setItem(STALE_RELOAD_KEY, String(Date.now()));
      window.location.reload();
    };

    window.addEventListener("unhandledrejection", handler);
    return () => window.removeEventListener("unhandledrejection", handler);
  }, []);
}

function RootComponent() {
  const { queryClient } = Route.useRouteContext();
  useStaleClientReload();
  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <Outlet />
        <Toaster richColors position="top-right" />
      </AuthProvider>
    </QueryClientProvider>
  );
}
