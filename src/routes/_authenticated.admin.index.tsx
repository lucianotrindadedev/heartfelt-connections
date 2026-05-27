import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { createAccount, listAccounts, deleteAccount } from "@/lib/admin.functions";
import { helenaWebhookUrl } from "@/lib/app-base-url";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Check, ChevronDown, ChevronRight, Copy, Loader2, Plus,
  Trash2, MessageSquare, DollarSign, Activity, Search,
  AlertTriangle, Users,
} from "lucide-react";
import { toast } from "sonner";

export const Route = createFileRoute("/_authenticated/admin/")({
  component: AdminIndex,
});

type AccountRow = {
  id: string;
  nome: string;
  helena_account_id?: string | null;
  msg_count_30d?: number;
  cost_usd_30d?: number;
  tokens_30d?: number;
  turns_30d?: number;
  criado_em?: string;
};

function AdminIndex() {
  const fetchAccounts = useServerFn(listAccounts);
  const q = useQuery({
    queryKey: ["admin", "accounts"],
    queryFn: () => fetchAccounts(),
  });

  const [search, setSearch] = useState("");

  const accounts: AccountRow[] = q.data?.accounts ?? [];

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return accounts;
    return accounts.filter(
      (a) =>
        a.nome.toLowerCase().includes(term) ||
        a.id.toLowerCase().includes(term) ||
        (a.helena_account_id ?? "").toLowerCase().includes(term),
    );
  }, [accounts, search]);

  const totals = useMemo(() => {
    return accounts.reduce(
      (t, a) => ({
        msgs: t.msgs + (a.msg_count_30d ?? 0),
        cost: t.cost + (a.cost_usd_30d ?? 0),
        turns: t.turns + (a.turns_30d ?? 0),
      }),
      { msgs: 0, cost: 0, turns: 0 },
    );
  }, [accounts]);

  // Agrupa contas pelo helena_account_id
  const groups = useMemo(() => {
    const map = new Map<string, AccountRow[]>();
    for (const a of filtered) {
      const key = a.helena_account_id ?? a.id;
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(a);
    }
    return Array.from(map.entries());
  }, [filtered]);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">Contas</h1>
          <p className="text-sm text-muted-foreground">
            Todas as contas do CRM conectadas — clique para ver performance, logs e custos.
          </p>
        </div>
        <div className="flex gap-2">
          <Link
            to="/admin/replay"
            className="inline-flex items-center gap-1.5 rounded-md border px-3 py-2 text-sm font-medium text-foreground hover:bg-muted"
          >
            Replay
          </Link>
          <Link
            to="/admin/telemetry"
            className="inline-flex items-center gap-1.5 rounded-md border px-3 py-2 text-sm font-medium text-foreground hover:bg-muted"
          >
            Telemetria
          </Link>
          <Link
            to="/admin/evolution"
            className="inline-flex items-center gap-1.5 rounded-md border px-3 py-2 text-sm font-medium text-foreground hover:bg-muted"
          >
            Evolution
          </Link>
          <Link
            to="/admin/templates"
            className="inline-flex items-center gap-1.5 rounded-md border px-3 py-2 text-sm font-medium text-foreground hover:bg-muted"
          >
            Templates
          </Link>
          <CreateAccountDialog />
        </div>
      </div>

      {/* KPIs globais */}
      {q.data && (
        <div className="grid gap-3 md:grid-cols-4">
          <KpiCard
            icon={<Users className="h-4 w-4 text-slate-500" />}
            label="Total de contas"
            value={accounts.length.toLocaleString("pt-BR")}
          />
          <KpiCard
            icon={<MessageSquare className="h-4 w-4 text-blue-500" />}
            label="Mensagens (30d)"
            value={totals.msgs.toLocaleString("pt-BR")}
          />
          <KpiCard
            icon={<Activity className="h-4 w-4 text-amber-500" />}
            label="Turnos LLM (30d)"
            value={totals.turns.toLocaleString("pt-BR")}
          />
          <KpiCard
            icon={<DollarSign className="h-4 w-4 text-emerald-500" />}
            label="Custo (30d)"
            value={`$${totals.cost.toFixed(2)}`}
          />
        </div>
      )}

      {/* Search */}
      {accounts.length > 0 && (
        <div className="flex items-center gap-2 rounded-md border border-border bg-white px-3 py-2">
          <Search className="h-3.5 w-3.5 text-muted-foreground" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Buscar por nome, ID interno ou ID do CRM…"
            className="flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          />
          {search && (
            <button
              onClick={() => setSearch("")}
              className="text-xs text-muted-foreground hover:text-foreground"
            >
              Limpar
            </button>
          )}
        </div>
      )}

      {q.isLoading && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Carregando…
        </div>
      )}
      {q.error && (
        <p className="text-sm text-destructive">
          {q.error instanceof Error ? q.error.message : "Erro ao carregar"}
        </p>
      )}

      <div className="grid gap-3">
        {groups.map(([helenaId, accounts]) =>
          accounts.length === 1 ? (
            <SingleAccountCard key={helenaId} account={accounts[0]} />
          ) : (
            <MultiAccountGroup key={helenaId} helenaId={helenaId} accounts={accounts} />
          ),
        )}
        {q.data && groups.length === 0 && (
          <Card className="p-8 text-center text-sm text-muted-foreground">
            {search
              ? `Nenhuma conta encontrada para "${search}".`
              : 'Nenhuma conta ainda. Clique em "Nova conta" para criar a primeira.'}
          </Card>
        )}
      </div>
    </div>
  );
}

function KpiCard({
  icon, label, value,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
}) {
  return (
    <Card className="p-4">
      <div className="flex items-center gap-2 text-xs uppercase text-muted-foreground">
        {icon} {label}
      </div>
      <div className="mt-1 text-2xl font-semibold tabular-nums">{value}</div>
    </Card>
  );
}

function AccountStats({ account }: { account: AccountRow }) {
  const stats = [
    { icon: <MessageSquare className="h-3 w-3" />, label: `${(account.msg_count_30d ?? 0).toLocaleString("pt-BR")} msgs` },
    { icon: <Activity className="h-3 w-3" />, label: `${(account.turns_30d ?? 0).toLocaleString("pt-BR")} turnos` },
    { icon: <DollarSign className="h-3 w-3" />, label: `$${(account.cost_usd_30d ?? 0).toFixed(4)}` },
  ];
  return (
    <div className="flex items-center gap-3 text-[11px] text-muted-foreground">
      {stats.map((s, i) => (
        <span key={i} className="flex items-center gap-1 tabular-nums">
          {s.icon}
          {s.label}
        </span>
      ))}
    </div>
  );
}

function SingleAccountCard({ account }: { account: AccountRow }) {
  return (
    <Card className="overflow-hidden p-0 hover:bg-accent/30 transition">
      <div className="flex items-center justify-between gap-4 p-4">
        <Link
          to="/admin/account/$accountId"
          params={{ accountId: account.id }}
          className="flex flex-1 min-w-0 flex-col gap-1.5"
        >
          <div className="font-medium">{account.nome}</div>
          <div className="font-mono text-[11px] text-muted-foreground truncate">{account.id}</div>
          <AccountStats account={account} />
        </Link>
        <div className="flex items-center gap-1.5 shrink-0">
          <DeleteAccountButton account={account} />
          <Link
            to="/admin/account/$accountId"
            params={{ accountId: account.id }}
            className="rounded-md p-1.5 hover:bg-muted"
          >
            <ChevronRight className="h-4 w-4 text-muted-foreground" />
          </Link>
        </div>
      </div>
    </Card>
  );
}

function MultiAccountGroup({
  helenaId, accounts,
}: {
  helenaId: string;
  accounts: AccountRow[];
}) {
  const [open, setOpen] = useState(true);

  const groupTotals = accounts.reduce(
    (t, a) => ({
      msgs: t.msgs + (a.msg_count_30d ?? 0),
      cost: t.cost + (a.cost_usd_30d ?? 0),
    }),
    { msgs: 0, cost: 0 },
  );

  return (
    <div className="overflow-hidden rounded-lg border">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between bg-muted/50 px-4 py-3 hover:bg-muted/80 transition"
      >
        <div className="text-left">
          <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            CRM
          </span>
          <p className="mt-0.5 font-mono text-xs text-foreground">{helenaId}</p>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-[11px] text-muted-foreground tabular-nums">
            {groupTotals.msgs.toLocaleString("pt-BR")} msgs · ${groupTotals.cost.toFixed(2)}
          </span>
          <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[11px] font-semibold text-primary">
            {accounts.length} agentes
          </span>
          {open ? (
            <ChevronDown className="h-4 w-4 text-muted-foreground" />
          ) : (
            <ChevronRight className="h-4 w-4 text-muted-foreground" />
          )}
        </div>
      </button>

      {open && (
        <div className="divide-y">
          {accounts.map((a) => (
            <div
              key={a.id}
              className="flex items-center justify-between gap-4 px-4 py-3 hover:bg-accent/30 transition"
            >
              <Link
                to="/admin/account/$accountId"
                params={{ accountId: a.id }}
                className="flex flex-1 min-w-0 flex-col gap-1"
              >
                <div className="text-sm font-medium">{a.nome}</div>
                <div className="font-mono text-[11px] text-muted-foreground truncate">{a.id}</div>
                <AccountStats account={a} />
              </Link>
              <div className="flex items-center gap-1.5 shrink-0">
                <DeleteAccountButton account={a} />
                <Link
                  to="/admin/account/$accountId"
                  params={{ accountId: a.id }}
                  className="rounded-md p-1.5 hover:bg-muted"
                >
                  <ChevronRight className="h-4 w-4 text-muted-foreground" />
                </Link>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// =============================================================
// Delete account dialog
// =============================================================

function DeleteAccountButton({ account }: { account: AccountRow }) {
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState("");
  const qc = useQueryClient();
  const deleteFn = useServerFn(deleteAccount);

  const m = useMutation({
    mutationFn: () =>
      deleteFn({ data: { accountId: account.id, confirmName: confirm } }),
    onSuccess: (res) => {
      toast.success(
        `Conta "${res.deleted.nome}" deletada — ${res.deleted.agents} agente(s), ${res.deleted.conversations} conversa(s), ${res.deleted.messages} msg(s).`,
        { duration: 6000 },
      );
      qc.invalidateQueries({ queryKey: ["admin", "accounts"] });
      setOpen(false);
      setConfirm("");
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Erro ao deletar"),
  });

  const canDelete = confirm.trim().toLowerCase() === account.nome.trim().toLowerCase()
    || confirm.trim().toLowerCase() === account.id.trim().toLowerCase();

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        setOpen(v);
        if (!v) setConfirm("");
      }}
    >
      <DialogTrigger asChild>
        <button
          onClick={(e) => e.stopPropagation()}
          className="rounded-md p-1.5 text-muted-foreground hover:bg-rose-50 hover:text-rose-600"
          title="Deletar conta"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-rose-700">
            <AlertTriangle className="h-5 w-5" />
            Deletar conta
          </DialogTitle>
          <DialogDescription>
            Essa ação <strong>não pode ser desfeita</strong>. Tudo será apagado em cascata:
            agentes, conversas, mensagens, runs do LLM, follow-ups, warm-ups, base de conhecimento,
            mídias, integrações (Clinicorp/GCal/Clinup), secrets e configurações.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 rounded-md border border-rose-200 bg-rose-50 p-3 text-xs">
          <div className="grid grid-cols-2 gap-y-1">
            <span className="text-muted-foreground">Conta</span>
            <span className="font-semibold">{account.nome}</span>
            <span className="text-muted-foreground">ID</span>
            <span className="font-mono">{account.id}</span>
            <span className="text-muted-foreground">Mensagens (30d)</span>
            <span>{(account.msg_count_30d ?? 0).toLocaleString("pt-BR")}</span>
            <span className="text-muted-foreground">Custo LLM (30d)</span>
            <span>${(account.cost_usd_30d ?? 0).toFixed(4)}</span>
          </div>
        </div>

        <div className="space-y-2">
          <Label htmlFor="confirm-name" className="text-sm">
            Digite <strong>{account.nome}</strong> ou o ID da conta pra confirmar:
          </Label>
          <Input
            id="confirm-name"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            placeholder={account.nome}
            autoComplete="off"
          />
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            Cancelar
          </Button>
          <Button
            variant="destructive"
            disabled={!canDelete || m.isPending}
            onClick={() => m.mutate()}
          >
            {m.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Deletar permanentemente
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// =============================================================
// Create account dialog
// =============================================================

interface CreatedAccount {
  accountId: string;
  agentId: string;
  webhookSecret: string;
}

function CreateAccountDialog() {
  const [open, setOpen] = useState(false);
  const [helenaAccountId, setHelenaAccountId] = useState("");
  const [nome, setNome] = useState("");
  const [helenaToken, setHelenaToken] = useState("");
  const [helenaBaseUrl, setHelenaBaseUrl] = useState("");
  const [created, setCreated] = useState<CreatedAccount | null>(null);

  const qc = useQueryClient();
  const createFn = useServerFn(createAccount);

  const reset = () => {
    setHelenaAccountId("");
    setNome("");
    setHelenaToken("");
    setHelenaBaseUrl("");
    setCreated(null);
  };

  const m = useMutation({
    mutationFn: (input: {
      helenaAccountId: string;
      nome: string;
      helenaToken: string;
      helenaBaseUrl?: string;
    }) => createFn({ data: input }),
    onSuccess: (res) => {
      toast.success("Conta criada");
      qc.invalidateQueries({ queryKey: ["admin", "accounts"] });
      setCreated(res);
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Erro ao criar"),
  });

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        setOpen(v);
        if (!v) reset();
      }}
    >
      <DialogTrigger asChild>
        <Button>
          <Plus className="mr-2 h-4 w-4" /> Nova conta
        </Button>
      </DialogTrigger>
      <DialogContent>
        {created ? (
          <SuccessStep created={created} onClose={() => setOpen(false)} />
        ) : (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              m.mutate({
                helenaAccountId: helenaAccountId.trim(),
                nome: nome.trim(),
                helenaToken: helenaToken.trim(),
                helenaBaseUrl: helenaBaseUrl.trim() || undefined,
              });
            }}
          >
            <DialogHeader>
              <DialogTitle>Criar nova conta</DialogTitle>
              <DialogDescription>
                Conecta uma conta do CRM. O webhook é gerado automaticamente.
                Você pode criar múltiplos agentes para a mesma conta do CRM.
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-4 py-4">
              <div className="space-y-2">
                <Label htmlFor="acc-nome">Nome da conta</Label>
                <Input
                  id="acc-nome"
                  value={nome}
                  onChange={(e) => setNome(e.target.value)}
                  placeholder="ex: Clínica Magnum — Agente Principal"
                  required
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="acc-helena-id">ID da conta no CRM</Label>
                <Input
                  id="acc-helena-id"
                  value={helenaAccountId}
                  onChange={(e) => setHelenaAccountId(e.target.value)}
                  placeholder="ex: 8b8c63cf-c6d3-4e78-b2df-6fbbc732fb1b"
                  required
                />
                <p className="text-xs text-muted-foreground">
                  UUID da conta no CRM. Pode repetir se você quiser múltiplos
                  agentes para a mesma conta.
                </p>
              </div>

              <div className="space-y-2">
                <Label htmlFor="acc-token">Token do CRM (Bearer)</Label>
                <Input
                  id="acc-token"
                  type="password"
                  value={helenaToken}
                  onChange={(e) => setHelenaToken(e.target.value)}
                  placeholder="••••••••••••"
                  required
                />
                <p className="text-xs text-muted-foreground">
                  Guardado criptografado. Usado para enviar mensagens de volta pelo CRM.
                </p>
              </div>

              <div className="space-y-2">
                <Label htmlFor="acc-base">Base URL (opcional)</Label>
                <Input
                  id="acc-base"
                  value={helenaBaseUrl}
                  onChange={(e) => setHelenaBaseUrl(e.target.value)}
                  placeholder="https://api.crmmentoriae7.com.br"
                />
              </div>
            </div>

            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setOpen(false)}>
                Cancelar
              </Button>
              <Button type="submit" disabled={m.isPending}>
                {m.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Criar conta
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

function SuccessStep({
  created, onClose,
}: {
  created: CreatedAccount;
  onClose: () => void;
}) {
  const navigate = useNavigate();
  const webhookUrl = helenaWebhookUrl(created.accountId);

  const [copiedUrl, setCopiedUrl] = useState(false);
  const [copiedSecret, setCopiedSecret] = useState(false);

  const copy = async (text: string, which: "url" | "secret") => {
    try {
      await navigator.clipboard.writeText(text);
      if (which === "url") {
        setCopiedUrl(true);
        setTimeout(() => setCopiedUrl(false), 1500);
      } else {
        setCopiedSecret(true);
        setTimeout(() => setCopiedSecret(false), 1500);
      }
      toast.success("Copiado");
    } catch {
      toast.error("Não foi possível copiar");
    }
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2">
          <Check className="h-5 w-5 text-emerald-600" />
          Conta criada com sucesso
        </DialogTitle>
        <DialogDescription>
          Cole o webhook abaixo no CRM, nos eventos <strong>Mensagem recebida</strong> e{" "}
          <strong>Mensagem enviada</strong>.
        </DialogDescription>
      </DialogHeader>

      <div className="space-y-4 py-4">
        <div className="space-y-2">
          <Label>URL do webhook</Label>
          <div className="flex gap-2">
            <Input value={webhookUrl} readOnly className="font-mono text-xs" />
            <Button type="button" variant="outline" size="icon" onClick={() => copy(webhookUrl, "url")}>
              {copiedUrl ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
            </Button>
          </div>
        </div>

        <div className="space-y-2">
          <Label>Header de segurança</Label>
          <div className="rounded-md border bg-muted/40 p-3 font-mono text-xs">
            X-Helena-Secret: <span className="select-all">{created.webhookSecret}</span>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => copy(created.webhookSecret, "secret")}
          >
            {copiedSecret ? (
              <Check className="mr-1.5 h-4 w-4" />
            ) : (
              <Copy className="mr-1.5 h-4 w-4" />
            )}
            Copiar secret
          </Button>
        </div>

        <div className="rounded-md border border-amber-500/30 bg-amber-500/5 p-3 text-xs text-muted-foreground">
          <strong className="text-foreground">Importante:</strong> sem esse header, o webhook é rejeitado
          (401). Você pode regenerar o secret depois nas configurações da conta.
        </div>
      </div>

      <DialogFooter>
        <Button variant="outline" onClick={onClose}>
          Fechar
        </Button>
        <Button
          onClick={() => {
            onClose();
            navigate({
              to: "/admin/account/$accountId",
              params: { accountId: created.accountId },
            });
          }}
        >
          Abrir conta
        </Button>
      </DialogFooter>
    </>
  );
}
