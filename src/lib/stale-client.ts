// Detecção + recuperação de "cliente desatualizado" após um deploy.
//
// O TanStack Start gera IDs de server functions por hash do conteúdo. Após um
// novo deploy, os IDs mudam; clientes com a página já aberta continuam chamando
// os IDs antigos e o servidor responde 500 ("Server function module export not
// resolved"). A correção é recarregar a página (baixa o bundle novo).
//
// Usado tanto no handler global de unhandledrejection (__root) quanto no
// onError do QueryCache/MutationCache (router) — este último é essencial
// porque o React Query CAPTURA os erros das queries/mutations (inclusive as de
// polling), então eles nunca chegam ao unhandledrejection.

const STALE_RE = /Server function module export not resolved/i;
const RELOAD_KEY = "sfn_last_reload";
const RELOAD_COOLDOWN_MS = 5 * 60 * 1000; // no máx. 1 reload a cada 5 min

export function isStaleServerFnError(error: unknown): boolean {
  const e = error as { message?: string; cause?: { message?: string } } | null;
  const msg = e?.message ?? e?.cause?.message ?? String(error ?? "");
  return STALE_RE.test(msg);
}

export function reloadForStaleClient(): void {
  if (typeof window === "undefined") return;
  try {
    const last = parseInt(sessionStorage.getItem(RELOAD_KEY) ?? "0", 10);
    if (Date.now() - last < RELOAD_COOLDOWN_MS) return;
    sessionStorage.setItem(RELOAD_KEY, String(Date.now()));
  } catch {
    /* sessionStorage indisponível — segue para o reload mesmo assim */
  }
  console.warn(
    "[app] serverFn desatualizado (novo deploy detectado) — recarregando…",
  );
  window.location.reload();
}
