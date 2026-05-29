import { Outlet, Link, createRootRouteWithContext, HeadContent, Scripts } from "@tanstack/react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AuthProvider } from "@/lib/auth";
import { Toaster } from "@/components/ui/sonner";
import { useEffect } from "react";
import { isStaleServerFnError, reloadForStaleClient } from "@/lib/stale-client";

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

// Rede de segurança extra: rejeições NÃO capturadas (fora do React Query) que
// indicam serverFn desatualizado também disparam o reload. O caso principal
// (queries/mutations de polling) é tratado no onError do QueryCache (router).
function useStaleClientReload() {
  useEffect(() => {
    const handler = (event: PromiseRejectionEvent) => {
      if (isStaleServerFnError(event.reason)) reloadForStaleClient();
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
