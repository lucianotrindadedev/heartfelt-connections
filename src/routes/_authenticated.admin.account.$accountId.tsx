import { createFileRoute, Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery } from "@tanstack/react-query";
import { getAccountDetail, listAccountLogs } from "@/lib/admin.functions";
import { embedAccountUrl, helenaWebhookUrl, useClientAppBaseUrl } from "@/lib/app-base-url";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Loader2, ArrowLeft, ExternalLink, Copy, Check, Filter, RefreshCw,
  ChevronDown, ChevronRight, AlertCircle, Activity, Bell, Flame,
} from "lucide-react";
import { useState, useMemo } from "react";

function CopyField({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard.writeText(value);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };
  return (
    <div className="space-y-1">
      <div className="text-xs uppercase text-muted-foreground">{label}</div>
      <div className="flex items-center gap-2">
        <code className="flex-1 break-all rounded bg-muted px-2 py-1.5 font-mono text-xs">
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

type Tab = "overview" | "logs" | "setup";

function AdminAccountDetail() {
  const { accountId } = Route.useParams();
  const appBaseUrl = useClientAppBaseUrl();
  const fetch = useServerFn(getAccountDetail);
  const q = useQuery({
    queryKey: ["admin", "account", accountId],
    queryFn: () => fetch({ data: { accountId } }),
  });

  const [tab, setTab] = useState<Tab>("overview");

  const totalCost = useMemo(
    () => q.data?.usage.reduce((s, r) => s + Number(r.total_cost_usd ?? 0), 0) ?? 0,
    [q.data?.usage],
  );
  const totalTokens = useMemo(
    () => q.data?.usage.reduce((s, r) => s + Number(r.total_tokens ?? 0), 0) ?? 0,
    [q.data?.usage],
  );

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
          {/* Header */}
          <div className="flex items-start justify-between">
            <div>
              <h1 className="text-2xl font-bold">{q.data.account.nome}</h1>
              <div className="font-mono text-xs text-muted-foreground">
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

          {/* KPI cards (sempre visíveis) */}
          <div className="grid gap-3 md:grid-cols-3">
            <Card className="p-4">
              <div className="text-xs uppercase text-muted-foreground">Mensagens (total)</div>
              <div className="mt-1 text-2xl font-semibold">
                {q.data.messageCount.toLocaleString("pt-BR")}
              </div>
            </Card>
            <Card className="p-4">
              <div className="text-xs uppercase text-muted-foreground">Custo LLM (30d)</div>
              <div className="mt-1 text-2xl font-semibold">${totalCost.toFixed(4)}</div>
            </Card>
            <Card className="p-4">
              <div className="text-xs uppercase text-muted-foreground">Tokens (30d)</div>
              <div className="mt-1 text-2xl font-semibold">
                {totalTokens.toLocaleString("pt-BR")}
              </div>
            </Card>
          </div>

          {/* Tabs */}
          <div className="flex gap-1 border-b border-border">
            <TabButton active={tab === "overview"} onClick={() => setTab("overview")}>
              Visão geral
            </TabButton>
            <TabButton active={tab === "logs"} onClick={() => setTab("logs")}>
              Logs
            </TabButton>
            <TabButton active={tab === "setup"} onClick={() => setTab("setup")}>
              Setup / Integração
            </TabButton>
          </div>

          {tab === "overview" && (
            <OverviewTab
              data={q.data}
            />
          )}

          {tab === "logs" && (
            <LogsTab accountId={accountId} agentId={q.data.agent?.id as string | undefined} />
          )}

          {tab === "setup" && (
            <SetupTab
              accountId={accountId}
              appBaseUrl={appBaseUrl}
              webhookSecret={String(q.data.agent?.webhook_secret ?? "")}
            />
          )}
        </>
      )}
    </div>
  );
}

function TabButton({
  active, onClick, children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={`relative px-4 py-2 text-sm font-medium transition-colors ${
        active ? "text-foreground" : "text-muted-foreground hover:text-foreground"
      }`}
    >
      {children}
      {active && (
        <span className="absolute inset-x-0 bottom-0 h-0.5 bg-primary" />
      )}
    </button>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Overview Tab
// ─────────────────────────────────────────────────────────────────────

type OverviewData = Awaited<ReturnType<typeof getAccountDetail>>;

function OverviewTab({ data }: { data: OverviewData }) {
  return (
    <div className="space-y-6">
      <Card className="p-4">
        <h2 className="font-semibold">Agente</h2>
        {data.agent ? (
          <dl className="mt-3 grid grid-cols-2 gap-y-2 text-sm">
            <dt className="text-muted-foreground">Nome</dt>
            <dd>{data.agent.nome ?? "—"}</dd>
            <dt className="text-muted-foreground">Status</dt>
            <dd>
              <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs ${
                data.agent.ativo
                  ? "bg-green-50 text-green-700"
                  : "bg-slate-100 text-slate-600"
              }`}>
                <span className={`h-1.5 w-1.5 rounded-full ${data.agent.ativo ? "bg-green-500" : "bg-slate-400"}`} />
                {data.agent.ativo ? "Ativo" : "Inativo"}
              </span>
            </dd>
            <dt className="text-muted-foreground">Criado em</dt>
            <dd>{new Date(data.agent.criado_em).toLocaleString("pt-BR")}</dd>
          </dl>
        ) : (
          <p className="mt-2 text-sm text-muted-foreground">Sem agente configurado.</p>
        )}
      </Card>

      {data.lastLogs.length > 0 && (
        <Card className="p-4">
          <div className="flex items-center justify-between">
            <h2 className="font-semibold">Últimos eventos</h2>
            <span className="text-[10px] uppercase text-muted-foreground">
              (5 mais recentes — veja "Logs" pra detalhes)
            </span>
          </div>
          <ul className="mt-3 divide-y divide-border text-sm">
            {data.lastLogs.map((l) => (
              <li key={l.id} className="flex items-center gap-3 py-2">
                <KindIcon kind={l.kind as string} />
                <span className="flex-1 min-w-0 truncate">
                  <strong className="capitalize">{l.kind.replace("_", " ")}</strong>
                  {l.model && <span className="text-muted-foreground"> · {l.model}</span>}
                  {l.error && (
                    <span className="text-rose-600"> · {l.error.slice(0, 80)}</span>
                  )}
                </span>
                <StatusBadge status={l.status as string} />
                <time className="shrink-0 text-[10px] text-muted-foreground">
                  {new Date(l.created_at).toLocaleString("pt-BR")}
                </time>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <Card className="p-4">
        <h2 className="font-semibold">Uso diário (30 dias)</h2>
        <div className="mt-3 max-h-80 overflow-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase text-muted-foreground">
              <tr>
                <th className="pb-2">Dia</th>
                <th className="pb-2">Requests</th>
                <th className="pb-2">Tokens</th>
                <th className="pb-2">Custo (USD)</th>
              </tr>
            </thead>
            <tbody>
              {data.usage.map((u) => (
                <tr key={u.day} className="border-t border-border">
                  <td className="py-1.5">{u.day}</td>
                  <td>{u.requests.toLocaleString("pt-BR")}</td>
                  <td>{u.total_tokens.toLocaleString("pt-BR")}</td>
                  <td>${u.total_cost_usd.toFixed(4)}</td>
                </tr>
              ))}
              {data.usage.length === 0 && (
                <tr>
                  <td colSpan={4} className="py-4 text-center text-muted-foreground">
                    Sem uso registrado
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Logs Tab
// ─────────────────────────────────────────────────────────────────────

type LogKind = "all" | "agent_turn" | "followup" | "warmup";
type LogStatus = "all" | "success" | "failed";

function LogsTab({ accountId, agentId }: { accountId: string; agentId?: string }) {
  const [kind, setKind] = useState<LogKind>("all");
  const [status, setStatus] = useState<LogStatus>("all");
  const [offset, setOffset] = useState(0);
  const PAGE = 50;

  const fetchLogs = useServerFn(listAccountLogs);
  const q = useQuery({
    queryKey: ["admin", "logs", accountId, kind, status, offset],
    queryFn: () =>
      fetchLogs({
        data: { accountId, kind, status, limit: PAGE, offset, agentId },
      }),
  });

  const logs = q.data?.logs ?? [];

  return (
    <div className="space-y-4">
      {/* Filtros */}
      <Card className="p-3">
        <div className="flex flex-wrap items-center gap-3">
          <Filter className="h-3.5 w-3.5 text-muted-foreground" />
          <FilterGroup
            label="Tipo"
            value={kind}
            onChange={(v) => { setKind(v as LogKind); setOffset(0); }}
            options={[
              { value: "all", label: "Todos" },
              { value: "agent_turn", label: "Agente" },
              { value: "followup", label: "Follow-up" },
              { value: "warmup", label: "Warm-up" },
            ]}
          />
          <FilterGroup
            label="Status"
            value={status}
            onChange={(v) => { setStatus(v as LogStatus); setOffset(0); }}
            options={[
              { value: "all", label: "Todos" },
              { value: "success", label: "Sucesso" },
              { value: "failed", label: "Falhou" },
            ]}
          />
          <div className="flex-1" />
          <button
            onClick={() => q.refetch()}
            className="flex items-center gap-1.5 rounded-md border border-border bg-white px-3 py-1.5 text-xs font-medium hover:bg-muted"
          >
            <RefreshCw className={`h-3 w-3 ${q.isFetching ? "animate-spin" : ""}`} />
            Atualizar
          </button>
          <span className="text-xs text-muted-foreground">
            {q.data?.total.toLocaleString("pt-BR") ?? "—"} eventos
          </span>
        </div>
      </Card>

      {/* Lista */}
      <Card className="p-0 overflow-hidden">
        {q.isLoading && (
          <div className="flex items-center justify-center gap-2 py-12 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Carregando logs…
          </div>
        )}
        {!q.isLoading && logs.length === 0 && (
          <div className="py-12 text-center text-sm text-muted-foreground">
            Nenhum log encontrado pra esses filtros.
          </div>
        )}
        {!q.isLoading && logs.length > 0 && (
          <ul className="divide-y divide-border">
            {logs.map((l) => (
              <LogRow key={l.id + l.kind} log={l} />
            ))}
          </ul>
        )}
      </Card>

      {/* Paginação */}
      {q.data && q.data.total > PAGE && (
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span>
            Mostrando {offset + 1}–{Math.min(offset + PAGE, q.data.total)} de {q.data.total}
          </span>
          <div className="flex gap-2">
            <button
              onClick={() => setOffset(Math.max(0, offset - PAGE))}
              disabled={offset === 0}
              className="rounded-md border border-border bg-white px-3 py-1 disabled:opacity-40 hover:bg-muted"
            >
              ← Anterior
            </button>
            <button
              onClick={() => setOffset(offset + PAGE)}
              disabled={!q.data.hasMore}
              className="rounded-md border border-border bg-white px-3 py-1 disabled:opacity-40 hover:bg-muted"
            >
              Próximo →
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function FilterGroup<T extends string>({
  label, value, onChange, options,
}: {
  label: string;
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: string }[];
}) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="text-xs font-semibold text-muted-foreground">{label}:</span>
      <div className="flex rounded-md border border-border bg-white p-0.5">
        {options.map((o) => (
          <button
            key={o.value}
            onClick={() => onChange(o.value)}
            className={`rounded px-2.5 py-1 text-xs font-medium transition-colors ${
              value === o.value
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}

interface LogEntry {
  id: string;
  kind: string;
  status: string;
  created_at: string;
  model: string | null;
  provider: string | null;
  latency_ms: number | null;
  tokens_in: number | null;
  tokens_out: number | null;
  cost_usd: number | null;
  error: string | null;
  detail: string | null;
  conversation_id: string | null;
  agent_id: string | null;
}

function LogRow({ log }: { log: LogEntry }) {
  const [open, setOpen] = useState(false);
  const hasDetail = !!log.error || !!log.detail || !!log.conversation_id;

  return (
    <li className="hover:bg-muted/30">
      <button
        onClick={() => hasDetail && setOpen((o) => !o)}
        className={`flex w-full items-center gap-3 px-4 py-2.5 text-left text-sm ${
          hasDetail ? "cursor-pointer" : "cursor-default"
        }`}
      >
        {hasDetail ? (
          open ? <ChevronDown className="h-3 w-3 text-muted-foreground" /> :
                 <ChevronRight className="h-3 w-3 text-muted-foreground" />
        ) : (
          <span className="h-3 w-3" />
        )}
        <KindIcon kind={log.kind} />
        <span className="w-20 shrink-0 capitalize text-xs font-medium">
          {log.kind.replace("_", " ")}
        </span>
        <StatusBadge status={log.status} />
        <span className="flex-1 min-w-0 truncate text-xs text-muted-foreground">
          {log.error
            ? <span className="text-rose-600">{log.error.slice(0, 120)}</span>
            : log.model
              ? <>model: <code>{log.model}</code></>
              : log.detail?.slice(0, 120) ?? ""}
        </span>
        {log.latency_ms != null && (
          <span className="shrink-0 text-[10px] text-muted-foreground">{log.latency_ms}ms</span>
        )}
        {Number(log.cost_usd) > 0 && (
          <span className="shrink-0 text-[10px] text-muted-foreground">
            ${Number(log.cost_usd).toFixed(5)}
          </span>
        )}
        {(log.tokens_in || log.tokens_out) ? (
          <span className="shrink-0 text-[10px] text-muted-foreground">
            {log.tokens_in}↓ / {log.tokens_out}↑
          </span>
        ) : null}
        <time className="shrink-0 text-[10px] text-muted-foreground tabular-nums">
          {new Date(log.created_at).toLocaleString("pt-BR", { hour12: false })}
        </time>
      </button>

      {open && hasDetail && (
        <div className="border-t border-border bg-slate-50/50 px-4 py-3 pl-12 text-xs">
          {log.error && (
            <div className="mb-2 rounded-md border border-rose-200 bg-rose-50 p-3">
              <div className="mb-1 flex items-center gap-1.5 font-semibold text-rose-800">
                <AlertCircle className="h-3 w-3" /> Erro
              </div>
              <pre className="whitespace-pre-wrap break-words text-rose-700">{log.error}</pre>
            </div>
          )}
          {log.detail && (
            <div className="mb-2">
              <div className="mb-1 font-semibold text-muted-foreground">Detalhe</div>
              <pre className="whitespace-pre-wrap break-words rounded-md bg-white p-2 text-foreground">{log.detail}</pre>
            </div>
          )}
          <dl className="grid grid-cols-2 gap-y-1 text-[11px]">
            {log.conversation_id && (
              <>
                <dt className="text-muted-foreground">conversation_id</dt>
                <dd className="font-mono">{log.conversation_id}</dd>
              </>
            )}
            {log.agent_id && (
              <>
                <dt className="text-muted-foreground">agent_id</dt>
                <dd className="font-mono">{log.agent_id}</dd>
              </>
            )}
            {log.provider && (
              <>
                <dt className="text-muted-foreground">provider</dt>
                <dd>{log.provider}</dd>
              </>
            )}
            <dt className="text-muted-foreground">id</dt>
            <dd className="font-mono">{log.id}</dd>
          </dl>
        </div>
      )}
    </li>
  );
}

function KindIcon({ kind }: { kind: string }) {
  if (kind === "agent_turn") return <Activity className="h-3.5 w-3.5 shrink-0 text-blue-600" />;
  if (kind === "followup") return <Bell className="h-3.5 w-3.5 shrink-0 text-orange-600" />;
  if (kind === "warmup") return <Flame className="h-3.5 w-3.5 shrink-0 text-rose-600" />;
  return <Activity className="h-3.5 w-3.5 shrink-0 text-slate-500" />;
}

function StatusBadge({ status }: { status: string }) {
  const cls = status === "success"
    ? "bg-green-50 text-green-700 border-green-200"
    : status === "failed"
      ? "bg-rose-50 text-rose-700 border-rose-200"
      : "bg-slate-100 text-slate-600 border-slate-200";
  return (
    <span className={`shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-medium ${cls}`}>
      {status}
    </span>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Setup Tab
// ─────────────────────────────────────────────────────────────────────

function SetupTab({
  accountId, appBaseUrl, webhookSecret,
}: {
  accountId: string;
  appBaseUrl: string;
  webhookSecret: string;
}) {
  return (
    <Card className="space-y-4 p-4">
      <h2 className="font-semibold">Configuração de Integração</h2>
      <CopyField
        label="Webhook do CRM (cole em: CRM → Gatilhos → URL)"
        value={helenaWebhookUrl(accountId, appBaseUrl)}
      />
      <CopyField
        label="Header de autenticação (X-Helena-Secret)"
        value={webhookSecret}
      />
      <CopyField
        label="URL do Embed (cole no iframe do CRM)"
        value={embedAccountUrl(accountId, appBaseUrl)}
      />
      <p className="text-xs text-muted-foreground">
        No CRM: Configurações → Integrações → Webhook → URL acima + header{" "}
        <code className="font-mono">X-Helena-Secret: &lt;valor acima&gt;</code>{" "}
        (o nome do header é técnico — não altere).
      </p>
    </Card>
  );
}
