import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { useSession } from "@/lib/session";
import { IS_MOCK } from "@/lib/api";

interface EmbedSearch {
  accountId?: string;
  userId?: string;
  sig?: string;
  ts?: string;
}

export const Route = createFileRoute("/embed")({
  validateSearch: (search: Record<string, unknown>): EmbedSearch => ({
    accountId: (search.accountId as string | undefined) ?? undefined,
    userId: (search.userId as string | undefined) ?? undefined,
    sig: (search.sig as string | undefined) ?? undefined,
    ts: (search.ts as string | undefined) ?? undefined,
  }),
  component: EmbedEntrypoint,
});

function EmbedEntrypoint() {
  const search = Route.useSearch();
  const navigate = useNavigate();
  const { accountId, status, error, signIn } = useSession();

  // Em modo mock, usamos accountId padrão se não vier nenhum
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
        userId: search.userId ?? (IS_MOCK ? "demo-user" : undefined),
        sig: search.sig ?? (IS_MOCK ? "mock" : undefined),
        ts: search.ts ?? (IS_MOCK ? String(Date.now()) : undefined),
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
      title={IS_MOCK ? "Carregando preview…" : "Carregando painel…"}
      body={IS_MOCK ? "Modo mock ativo — usando dados de demonstração." : "Validando assinatura HMAC com o backend."}
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
