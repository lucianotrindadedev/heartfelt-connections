import { createRouter, useRouter } from "@tanstack/react-router";
import { QueryClient, QueryCache, MutationCache } from "@tanstack/react-query";
import { routeTree } from "./routeTree.gen";
import { isStaleServerFnError, reloadForStaleClient } from "@/lib/stale-client";

function DefaultErrorComponent({ error, reset }: { error: Error; reset: () => void }) {
  const router = useRouter();
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="max-w-md text-center">
        <h1 className="text-2xl font-bold tracking-tight text-foreground">Algo deu errado</h1>
        <p className="mt-2 text-sm text-muted-foreground">{error.message}</p>
        <div className="mt-6 flex items-center justify-center gap-3">
          <button
            onClick={() => {
              router.invalidate();
              reset();
            }}
            className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
          >
            Tentar novamente
          </button>
          <a
            href="/"
            className="inline-flex items-center justify-center rounded-md border border-input bg-background px-4 py-2 text-sm font-medium text-foreground hover:bg-accent"
          >
            Início
          </a>
        </div>
      </div>
    </div>
  );
}

export const getRouter = () => {
  // Handler global: queries/mutations de polling capturam seus erros (não
  // chegam ao unhandledrejection), então recarregamos aqui quando o serverFn
  // está desatualizado após um deploy — para de spammar 500 no servidor.
  const onStaleError = (error: unknown) => {
    if (isStaleServerFnError(error)) reloadForStaleClient();
  };

  const queryClient = new QueryClient({
    queryCache: new QueryCache({ onError: onStaleError }),
    mutationCache: new MutationCache({ onError: onStaleError }),
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        retry: (failureCount, error) => {
          // serverFn desatualizado não adianta repetir — só recarregando.
          if (isStaleServerFnError(error)) return false;
          const msg = error instanceof Error ? error.message : "";
          if (/unauthor|denied|inválido|invalid/i.test(msg)) return false;
          return failureCount < 2;
        },
      },
    },
  });

  const router = createRouter({
    routeTree,
    context: { queryClient },
    scrollRestoration: true,
    defaultPreloadStaleTime: 0,
    defaultErrorComponent: DefaultErrorComponent,
  });

  return router;
};
