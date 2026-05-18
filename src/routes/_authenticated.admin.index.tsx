import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { createAccount, listAccounts } from "@/lib/admin.functions";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { ChevronRight, Loader2, Plus } from "lucide-react";
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

function CreateAccountDialog() {
  const [open, setOpen] = useState(false);
  const [id, setId] = useState("");
  const [nome, setNome] = useState("");
  const [nomeAgente, setNomeAgente] = useState("");
  const [systemPrompt, setSystemPrompt] = useState("");

  const qc = useQueryClient();
  const navigate = useNavigate();
  const createFn = useServerFn(createAccount);

  const m = useMutation({
    mutationFn: (input: {
      id: string;
      nome: string;
      nomeAgente?: string;
      systemPrompt?: string;
    }) => createFn({ data: input }),
    onSuccess: (res) => {
      toast.success("Conta criada");
      qc.invalidateQueries({ queryKey: ["admin", "accounts"] });
      setOpen(false);
      setId("");
      setNome("");
      setNomeAgente("");
      setSystemPrompt("");
      navigate({ to: "/admin/account/$accountId", params: { accountId: res.accountId } });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Erro ao criar"),
  });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button>
          <Plus className="h-4 w-4 mr-2" /> Nova conta
        </Button>
      </DialogTrigger>
      <DialogContent>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            m.mutate({
              id: id.trim(),
              nome: nome.trim(),
              nomeAgente: nomeAgente.trim() || undefined,
              systemPrompt: systemPrompt.trim() || undefined,
            });
          }}
        >
          <DialogHeader>
            <DialogTitle>Criar nova conta</DialogTitle>
            <DialogDescription>
              Cria uma conta Helena e o agente associado (1 por conta).
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="acc-id">ID da conta (Helena)</Label>
              <Input
                id="acc-id"
                value={id}
                onChange={(e) => setId(e.target.value)}
                placeholder="ex: cliente-acme"
                required
              />
              <p className="text-xs text-muted-foreground">
                Letras, números, _ ou -. Deve bater com <code>id_conta</code> na Helena.
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="acc-nome">Nome</Label>
              <Input
                id="acc-nome"
                value={nome}
                onChange={(e) => setNome(e.target.value)}
                placeholder="ex: ACME Ltda"
                required
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="acc-agente">Nome do agente (opcional)</Label>
              <Input
                id="acc-agente"
                value={nomeAgente}
                onChange={(e) => setNomeAgente(e.target.value)}
                placeholder="Assistente Virtual"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="acc-prompt">System prompt inicial (opcional)</Label>
              <Textarea
                id="acc-prompt"
                value={systemPrompt}
                onChange={(e) => setSystemPrompt(e.target.value)}
                rows={5}
                placeholder="Você é um assistente que…"
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
      </DialogContent>
    </Dialog>
  );
}
