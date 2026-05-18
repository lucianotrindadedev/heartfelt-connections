import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { createAccount, listAccounts } from "@/lib/admin.functions";
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
import { Check, ChevronRight, Copy, Loader2, Plus } from "lucide-react";
import { toast } from "sonner";

export const Route = createFileRoute("/_authenticated/admin/")({
  component: AdminIndex,
});

function AdminIndex() {
  const fetchAccounts = useServerFn(listAccounts);
  const q = useQuery({
    queryKey: ["admin", "accounts"],
    queryFn: () => fetchAccounts(),
  });

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">Contas</h1>
          <p className="text-sm text-muted-foreground">
            Todas as contas Helena conectadas — clique para ver performance e custos.
          </p>
        </div>
        <CreateAccountDialog />
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
        {q.data?.accounts.map((a) => (
          <Link
            key={a.id}
            to="/admin/account/$accountId"
            params={{ accountId: a.id }}
            className="block"
          >
            <Card className="flex items-center justify-between p-4 hover:bg-accent/40 transition">
              <div>
                <div className="font-medium">{a.nome}</div>
                <div className="text-xs text-muted-foreground font-mono">{a.id}</div>
              </div>
              <ChevronRight className="h-4 w-4 text-muted-foreground" />
            </Card>
          </Link>
        ))}
        {q.data && q.data.accounts.length === 0 && (
          <Card className="p-6 text-center text-sm text-muted-foreground">
            Nenhuma conta ainda. Clique em "Nova conta" para criar a primeira.
          </Card>
        )}
      </div>
    </div>
  );
}

interface CreatedAccount {
  accountId: string;
  agentId: string;
  webhookSecret: string;
}

function CreateAccountDialog() {
  const [open, setOpen] = useState(false);
  const [id, setId] = useState("");
  const [nome, setNome] = useState("");
  const [helenaToken, setHelenaToken] = useState("");
  const [helenaBaseUrl, setHelenaBaseUrl] = useState("");
  const [created, setCreated] = useState<CreatedAccount | null>(null);

  const qc = useQueryClient();
  const createFn = useServerFn(createAccount);

  const reset = () => {
    setId("");
    setNome("");
    setHelenaToken("");
    setHelenaBaseUrl("");
    setCreated(null);
  };

  const m = useMutation({
    mutationFn: (input: {
      id: string;
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
                id: id.trim(),
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
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-4 py-4">
              <div className="space-y-2">
                <Label htmlFor="acc-nome">Nome da conta</Label>
                <Input
                  id="acc-nome"
                  value={nome}
                  onChange={(e) => setNome(e.target.value)}
                  placeholder="ex: Clínica Magnum"
                  required
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="acc-id">ID da conta no Helena</Label>
                <Input
                  id="acc-id"
                  value={id}
                  onChange={(e) => setId(e.target.value)}
                  placeholder="ex: magnum"
                  required
                />
                <p className="text-xs text-muted-foreground">
                  Letras, números, _ ou -. Deve bater com <code>id_conta</code> no Helena.
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
  const origin =
    typeof window !== "undefined" ? window.location.origin : "https://app.exemplo.com";
  const webhookUrl = `${origin}/api/public/webhook/helena/${created.accountId}`;

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

