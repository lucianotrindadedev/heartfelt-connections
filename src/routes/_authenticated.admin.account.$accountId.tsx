import { createFileRoute, Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery } from "@tanstack/react-query";
import { getAccountDetail } from "@/lib/admin.functions";
import { embedAccountUrl, helenaWebhookUrl, useClientAppBaseUrl } from "@/lib/app-base-url";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Loader2, ArrowLeft, ExternalLink, Copy, Check } from "lucide-react";
import { useState } from "react";

function CopyField({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard.writeText(value);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };
  return (
    <div className="space-y-1">
      <div className="text-xs text-muted-foreground uppercase">{label}</div>
      <div className="flex items-center gap-2">
        <code className="flex-1 rounded bg-muted px-2 py-1.5 text-xs font-mono break-all">
          {value}
        </code>
        <Button size="icon" variant="ghost" className="h-7 w-7 shrink-0" onClick={copy}>
          {copied ? <Check className="h-3.5 w-3.5 text-green-500" /> : <Copy className="h-3.5 w-3.5" />}
        </Button>
      </div>
    </div>
  );
}

export const Route = createFileRoute("/_authenticated/admin/account/$accountId")({
  component: AdminAccountDetail,
});

function AdminAccountDetail() {
  const { accountId } = Route.useParams();
  const appBaseUrl = useClientAppBaseUrl();
  const fetch = useServerFn(getAccountDetail);
  const q = useQuery({
    queryKey: ["admin", "account", accountId],
    queryFn: () => fetch({ data: { accountId } }),
  });

  const totalCost =
    q.data?.usage.reduce((s: number, r: { total_cost_usd?: number | null }) => s + Number(r.total_cost_usd ?? 0), 0) ?? 0;
  const totalTokens =
    q.data?.usage.reduce((s: number, r: { total_tokens?: number | null }) => s + Number(r.total_tokens ?? 0), 0) ?? 0;

  return (
    <div className="space-y-6">
      <Link
        to="/admin"
        className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-4 w-4" /> Voltar
      </Link>

      {q.isLoading && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Carregando…
        </div>
      )}
      {q.error && (
        <p className="text-sm text-destructive">
          {q.error instanceof Error ? q.error.message : "Erro"}
        </p>
      )}

      {q.data?.account && (
        <>
          <div className="flex items-start justify-between">
            <div>
              <h1 className="text-2xl font-bold">{q.data.account.nome}</h1>
              <div className="text-xs font-mono text-muted-foreground">
                {q.data.account.id}
              </div>
            </div>
            <Link
              to="/embed/account/$accountId"
              params={{ accountId }}
              className="inline-flex items-center gap-1 text-sm text-primary hover:underline"
            >
              Abrir embed <ExternalLink className="h-3.5 w-3.5" />
            </Link>
          </div>

          <div className="grid gap-3 md:grid-cols-3">
            <Card className="p-4">
              <div className="text-xs uppercase text-muted-foreground">Mensagens (total)</div>
              <div className="mt-1 text-2xl font-semibold">{q.data.messageCount}</div>
            </Card>
            <Card className="p-4">
              <div className="text-xs uppercase text-muted-foreground">Custo LLM (30d)</div>
              <div className="mt-1 text-2xl font-semibold">${totalCost.toFixed(4)}</div>
            </Card>
            <Card className="p-4">
              <div className="text-xs uppercase text-muted-foreground">Tokens (30d)</div>
              <div className="mt-1 text-2xl font-semibold">
                {totalTokens.toLocaleString()}
              </div>
            </Card>
          </div>

          <Card className="p-4">
            <h2 className="font-semibold">Agente</h2>
            {q.data.agent ? (
              <dl className="mt-3 grid grid-cols-2 gap-y-2 text-sm">
                <dt className="text-muted-foreground">Nome</dt>
                <dd>{q.data.agent.nome ?? "—"}</dd>
                <dt className="text-muted-foreground">Status</dt>
                <dd>{q.data.agent.ativo ? "Ativo" : "Inativo"}</dd>
                <dt className="text-muted-foreground">Criado em</dt>
                <dd>{new Date(q.data.agent.criado_em).toLocaleString("pt-BR")}</dd>
              </dl>
            ) : (
              <p className="mt-2 text-sm text-muted-foreground">Sem agente configurado.</p>
            )}
          </Card>

          {q.data.agent && (
            <Card className="p-4 space-y-4">
              <h2 className="font-semibold">Configuração de Integração</h2>
              <CopyField
                label="Webhook Helena (cole em: CRM → Gatilhos → URL)"
                value={helenaWebhookUrl(accountId, appBaseUrl)}
              />
              <CopyField
                label="Header de autenticação (X-Helena-Secret)"
                value={String(q.data.agent.webhook_secret ?? "")}
              />
              <CopyField
                label="URL do Embed (cole no iframe do CRM)"
                value={embedAccountUrl(accountId, appBaseUrl)}
              />
              <p className="text-xs text-muted-foreground">
                No Helena: Configurações → Integrações → Webhook → URL acima + header{" "}
                <code className="font-mono">X-Helena-Secret: &lt;valor acima&gt;</code>
              </p>
            </Card>
          )}

          <Card className="p-4">
            <h2 className="font-semibold">Uso diário (30 dias)</h2>
            <div className="mt-3 max-h-80 overflow-auto">
              <table className="w-full text-sm">
                <thead className="text-left text-xs uppercase text-muted-foreground">
                  <tr>
                    <th className="pb-2">Dia</th>
                    <th className="pb-2">Tokens</th>
                    <th className="pb-2">Custo (USD)</th>
                  </tr>
                </thead>
                <tbody>
                  {q.data.usage.map((u: { day: string; total_tokens?: number | null; total_cost_usd?: number | null }) => (
                    <tr key={u.day} className="border-t border-border">
                      <td className="py-1.5">{u.day}</td>
                      <td>{Number(u.total_tokens).toLocaleString()}</td>
                      <td>${Number(u.total_cost_usd).toFixed(4)}</td>
                    </tr>
                  ))}
                  {q.data.usage.length === 0 && (
                    <tr>
                      <td colSpan={3} className="py-4 text-center text-muted-foreground">
                        Sem uso registrado
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </Card>
        </>
      )}
    </div>
  );
}
