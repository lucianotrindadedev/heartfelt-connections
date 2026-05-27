// Pagina admin para configurar a Evolution API GLOBAL do SAAS.
// Apenas superadmin. URL + API key sao salvos em system_evolution_config (singleton).
// Apos salvar, mostra a lista de instancias detectadas via /instance/fetchInstances.

import { createFileRoute, Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import {
  getSystemEvolutionConfig,
  listEvolutionInstances,
  saveSystemEvolutionConfig,
} from "@/lib/evolution.functions";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ArrowLeft, Check, Loader2, RefreshCw, AlertCircle } from "lucide-react";
import { toast } from "sonner";

export const Route = createFileRoute("/_authenticated/admin/evolution")({
  component: AdminEvolution,
});

function AdminEvolution() {
  const fetchCfg = useServerFn(getSystemEvolutionConfig);
  const fetchInstances = useServerFn(listEvolutionInstances);
  const save = useServerFn(saveSystemEvolutionConfig);
  const qc = useQueryClient();

  const cfgQ = useQuery({
    queryKey: ["admin", "evolution", "config"],
    queryFn: () => fetchCfg(),
  });

  const instancesQ = useQuery({
    queryKey: ["admin", "evolution", "instances"],
    queryFn: () => fetchInstances(),
    enabled: !!cfgQ.data?.configured,
  });

  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");

  const saved = cfgQ.data;
  const initialUrl = saved?.base_url ?? "";

  const mut = useMutation({
    mutationFn: () =>
      save({
        data: {
          base_url: (baseUrl || initialUrl).trim(),
          ...(apiKey ? { api_key: apiKey } : {}),
        },
      }),
    onSuccess: () => {
      toast.success("Credenciais salvas");
      setApiKey("");
      qc.invalidateQueries({ queryKey: ["admin", "evolution"] });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Erro ao salvar"),
  });

  return (
    <div className="space-y-6">
      <Link
        to="/admin"
        className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-4 w-4" /> Voltar
      </Link>

      <div>
        <h1 className="text-2xl font-bold">Evolution API</h1>
        <p className="text-sm text-muted-foreground">
          Credenciais globais do SAAS. Cada agente seleciona uma instância e um grupo nesta Evolution.
        </p>
      </div>

      <Card className="space-y-4 p-4">
        <h2 className="font-semibold">Credenciais</h2>
        <div className="space-y-2">
          <Label htmlFor="base_url">URL Evolution API</Label>
          <Input
            id="base_url"
            placeholder="https://evolution.meudominio.com.br"
            defaultValue={initialUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="api_key">API Key</Label>
          <Input
            id="api_key"
            type="password"
            placeholder={saved?.key_last4 ? `•••• ${saved.key_last4}` : "cole a API key"}
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
          />
          <p className="text-xs text-muted-foreground">
            {saved?.key_last4
              ? "Já há uma key salva. Deixe em branco para mantê-la."
              : "Necessária para listar instâncias e enviar mensagens de alerta."}
          </p>
        </div>
        <div className="flex justify-end">
          <Button
            onClick={() => mut.mutate()}
            disabled={mut.isPending || (!apiKey && !saved?.key_last4 && !baseUrl)}
          >
            {mut.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Check className="mr-2 h-4 w-4" />
            )}
            Salvar
          </Button>
        </div>
        {saved?.atualizado_em && (
          <p className="text-xs text-muted-foreground">
            Última atualização: {new Date(saved.atualizado_em).toLocaleString("pt-BR")}
          </p>
        )}
      </Card>

      <Card className="space-y-4 p-4">
        <div className="flex items-center justify-between">
          <h2 className="font-semibold">Instâncias detectadas</h2>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => qc.invalidateQueries({ queryKey: ["admin", "evolution", "instances"] })}
            disabled={instancesQ.isFetching || !saved?.configured}
          >
            <RefreshCw
              className={`mr-2 h-3.5 w-3.5 ${instancesQ.isFetching ? "animate-spin" : ""}`}
            />
            Recarregar
          </Button>
        </div>

        {!saved?.configured && (
          <p className="text-sm text-muted-foreground">
            Configure a URL + API key acima para listar as instâncias.
          </p>
        )}

        {saved?.configured && instancesQ.isLoading && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Buscando instâncias…
          </div>
        )}

        {saved?.configured && instancesQ.data && instancesQ.data.ok === false && (
          <div className="flex items-start gap-2 rounded-md bg-rose-50 p-3 text-sm text-rose-700">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
            <div>
              <strong>
                {instancesQ.data.error === "not_configured"
                  ? "Não configurada"
                  : "Erro na API"}
              </strong>
              <p className="text-xs">{instancesQ.data.message}</p>
            </div>
          </div>
        )}

        {saved?.configured && instancesQ.data && instancesQ.data.ok === true && (
          <>
            {instancesQ.data.data.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                Nenhuma instância encontrada nesta Evolution.
              </p>
            ) : (
              <ul className="divide-y divide-border text-sm">
                {instancesQ.data.data.map((inst) => (
                  <li
                    key={inst.name}
                    className="flex items-center justify-between gap-3 py-2"
                  >
                    <div className="flex-1 min-w-0">
                      <div className="font-mono text-sm">{inst.name}</div>
                      {inst.profileName && (
                        <div className="text-xs text-muted-foreground">{inst.profileName}</div>
                      )}
                    </div>
                    <StatusPill status={inst.status} />
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </Card>
    </div>
  );
}

function StatusPill({ status }: { status?: string }) {
  const s = (status ?? "").toLowerCase();
  const map: Record<string, { label: string; cls: string }> = {
    open: { label: "Conectada", cls: "bg-green-50 text-green-700 border-green-200" },
    close: { label: "Desconectada", cls: "bg-rose-50 text-rose-700 border-rose-200" },
    connecting: { label: "Conectando", cls: "bg-amber-50 text-amber-700 border-amber-200" },
  };
  const ent = map[s] ?? {
    label: status || "—",
    cls: "bg-slate-100 text-slate-600 border-slate-200",
  };
  return (
    <span className={`shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-medium ${ent.cls}`}>
      {ent.label}
    </span>
  );
}
