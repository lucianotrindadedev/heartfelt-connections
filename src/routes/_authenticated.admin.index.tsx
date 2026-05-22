import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { createAccount, listAccounts } from "@/lib/admin.functions";
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
import { Check, ChevronDown, ChevronRight, Copy, Loader2, Plus } from "lucide-react";
import { toast } from "sonner";

export const Route = createFileRoute("/_authenticated/admin/")({
  component: AdminIndex,
});

type AccountRow = {
  id: string;
  nome: string;
  helena_account_id?: string | null;
};

function AdminIndex() {
  const fetchAccounts = useServerFn(listAccounts);
  const q = useQuery({
    queryKey: ["admin", "accounts"],
    queryFn: () => fetchAccounts(),
  });

  // Agrupa contas pelo helena_account_id
  const groups = useMemo(() => {
    const accounts: AccountRow[] = q.data?.accounts ?? [];
    const map = new Map<string, AccountRow[]>();
    for (const a of accounts) {
      const key = a.helena_account_id ?? a.id;
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(a);
    }
    return Array.from(map.entries()); // [ [helenaId, [account, ...]], ... ]
  }, [q.data]);

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">Contas</h1>
          <p className="text-sm text-muted-foreground">
            Todas as contas Helena conectadas — clique para ver performance e custos.
          </p>
        </div>
        <div className="flex gap-2">
          <Link
            to="/admin/templates"
            className="inline-flex items-center gap-1.5 rounded-md border px-3 py-2 text-sm font-medium text-foreground hover:bg-muted"
          >
            Templates
          </Link>
          <CreateAccountDialog />
        </div>
      </div>

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
            /* Conta única para esse Helena ID — card simples */
            <SingleAccountCard key={helenaId} account={accounts[0]} />
          ) : (
            /* Múltiplas contas para o mesmo Helena ID — card agrupado */
            <MultiAccountGroup key={helenaId} helenaId={helenaId} accounts={accounts} />
          ),
        )}
        {q.data && groups.length === 0 && (
          <Card className="p-6 text-center text-sm text-muted-foreground">
            Nenhuma conta ainda. Clique em "Nova conta" para criar a primeira.
          </Card>
        )}
      </div>
    </div>
  );
}

function SingleAccountCard({ account }: { account: AccountRow }) {
  return (
    <Link to="/admin/account/$accountId" params={{ accountId: account.id }} className="block">
      <Card className="flex items-center justify-between p-4 hover:bg-accent/40 transition">
        <div>
          <div className="font-medium">{account.nome}</div>
          <div className="text-xs text-muted-foreground font-mono">{account.id}</div>
        </div>
        <ChevronRight className="h-4 w-4 text-muted-foreground" />
      </Card>
    </Link>
  );
}

function MultiAccountGroup({ helenaId, accounts }: { helenaId: string; accounts: AccountRow[] }) {
  const [open, setOpen] = useState(true);

  return (
    <div className="rounded-lg border overflow-hidden">
      {/* Cabeçalho do grupo */}
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between bg-muted/50 px-4 py-3 hover:bg-muted/80 transition"
      >
        <div className="text-left">
          <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
            Helena CRM
          </span>
          <p className="font-mono text-xs text-foreground mt-0.5">{helenaId}</p>
        </div>
        <div className="flex items-center gap-2">
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

      {/* Lista de contas do grupo */}
      {open && (
        <div className="divide-y">
          {accounts.map((a) => (
            <Link
              key={a.id}
              to="/admin/account/$accountId"
              params={{ accountId: a.id }}
              className="flex items-center justify-between px-4 py-3 hover:bg-accent/40 transition"
            >
              <div>
                <div className="font-medium text-sm">{a.nome}</div>
                <div className="text-xs text-muted-foreground font-mono">{a.id}</div>
              </div>
              <ChevronRight className="h-4 w-4 text-muted-foreground" />
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

// =============================================================
// Dialog de criação
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
          <Plus className="h-4 w-4 mr-2" /> Nova conta
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
                Conecta uma conta do CRM Helena. O webhook é gerado automaticamente.
                Você pode criar múltiplos agentes para a mesma conta Helena.
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
                <Label htmlFor="acc-helena-id">ID da conta no Helena</Label>
                <Input
                  id="acc-helena-id"
                  value={helenaAccountId}
                  onChange={(e) => setHelenaAccountId(e.target.value)}
                  placeholder="ex: 8b8c63cf-c6d3-4e78-b2df-6fbbc732fb1b"
                  required
                />
                <p className="text-xs text-muted-foreground">
                  UUID da conta no CRM Helena. Pode repetir se você quiser múltiplos
                  agentes para a mesma conta.
                </p>
              </div>

              <div className="space-y-2">
                <Label htmlFor="acc-token">Token do CRM Helena (Bearer)</Label>
                <Input
                  id="acc-token"
                  type="password"
                  value={helenaToken}
                  onChange={(e) => setHelenaToken(e.target.value)}
                  placeholder="••••••••••••"
                  required
                />
                <p className="text-xs text-muted-foreground">
                  Guardado criptografado. Usado para enviar mensagens de volta pelo Helena.
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
                {m.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
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
  created,
  onClose,
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
          Cole o webhook abaixo no CRM Helena, nos eventos <strong>Mensagem recebida</strong> e{" "}
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
          <div className="rounded-md border bg-muted/40 p-3 text-xs font-mono">
            X-Helena-Secret: <span className="select-all">{created.webhookSecret}</span>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => copy(created.webhookSecret, "secret")}
          >
            {copiedSecret ? (
              <Check className="h-4 w-4 mr-1.5" />
            ) : (
              <Copy className="h-4 w-4 mr-1.5" />
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
