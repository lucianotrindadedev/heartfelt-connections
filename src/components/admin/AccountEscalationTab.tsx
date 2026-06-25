// Aba "Escalada" no painel admin de uma conta.
// Lista os agentes e permite ao superadmin escolher para cada um:
//   - Instancia da Evolution (dropdown — vem de listEvolutionInstances)
//   - Grupo de alerta (dropdown — vem de listEvolutionGroups, filtrado pela instancia)
// O toggle ativo/desativo continua sendo controlavel pelo dono no embed —
// aqui apenas exibimos read-only.

import { useServerFn } from "@tanstack/react-start";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import {
  getSystemEvolutionConfig,
  listAccountAgentsEscalation,
  listEvolutionGroups,
  listEvolutionInstances,
  saveAgentEscalationAdmin,
} from "@/lib/evolution.functions";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { AlertCircle, Check, ExternalLink, Loader2, RefreshCw } from "lucide-react";
import { Link } from "@tanstack/react-router";
import { toast } from "sonner";
import { NotificationFormatEditor } from "./NotificationFormatEditor";

export function AccountEscalationTab({ accountId }: { accountId: string }) {
  const fetchSys = useServerFn(getSystemEvolutionConfig);
  const fetchAgents = useServerFn(listAccountAgentsEscalation);
  const fetchInstances = useServerFn(listEvolutionInstances);

  const sysQ = useQuery({
    queryKey: ["admin", "evolution", "config"],
    queryFn: () => fetchSys(),
  });
  const agentsQ = useQuery({
    queryKey: ["admin", "account", accountId, "escalation"],
    queryFn: () => fetchAgents({ data: { accountId } }),
  });
  const instancesQ = useQuery({
    queryKey: ["admin", "evolution", "instances"],
    queryFn: () => fetchInstances(),
    enabled: !!sysQ.data?.configured,
  });

  if (!sysQ.data?.configured) {
    return (
      <Card className="space-y-2 p-4">
        <h2 className="font-semibold">Evolution não configurada</h2>
        <p className="text-sm text-muted-foreground">
          Antes de vincular agentes a instâncias/grupos, configure a URL e a API key
          globais da Evolution.
        </p>
        <Link
          to="/admin/evolution"
          className="inline-flex items-center gap-1 text-sm text-primary hover:underline"
        >
          Configurar agora <ExternalLink className="h-3.5 w-3.5" />
        </Link>
      </Card>
    );
  }

  const instances =
    instancesQ.data && instancesQ.data.ok ? instancesQ.data.data : [];

  return (
    <div className="space-y-4">
      <Card className="space-y-3 p-4">
        <div className="flex items-center justify-between">
          <h2 className="font-semibold">Vinculação por agente</h2>
          <Link
            to="/admin/evolution"
            className="text-xs text-muted-foreground hover:text-foreground hover:underline"
          >
            Gerenciar credenciais →
          </Link>
        </div>
        <p className="text-xs text-muted-foreground">
          Selecione qual instância da Evolution envia o alerta e em qual grupo. O dono
          do agente continua controlando o toggle ativar/desativar no embed.
        </p>

        {instancesQ.data && instancesQ.data.ok === false && (
          <div className="flex items-start gap-2 rounded-md bg-rose-50 p-3 text-sm text-rose-700">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
            <p className="text-xs">{instancesQ.data.message}</p>
          </div>
        )}
      </Card>

      {agentsQ.isLoading && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Carregando agentes…
        </div>
      )}

      {agentsQ.data?.agents.map((a) => (
        <AgentEscalationRow
          key={a.id}
          agent={a}
          instances={instances}
          instancesLoading={instancesQ.isLoading}
        />
      ))}

      {agentsQ.data && agentsQ.data.agents.length === 0 && (
        <Card className="p-4 text-sm text-muted-foreground">
          Esta conta não tem agentes.
        </Card>
      )}
    </div>
  );
}

interface AgentRow {
  id: string;
  nome: string;
  ativo: boolean;
  evolution_instance: string;
  grupo_alerta: string;
  notificar_agendamentos: boolean;
  notification_template: string;
  notification_summary_enabled: boolean;
  notification_summary_instruction: string;
}

interface InstanceRow {
  name: string;
  status?: string;
  profileName?: string;
}

function AgentEscalationRow({
  agent,
  instances,
  instancesLoading,
}: {
  agent: AgentRow;
  instances: InstanceRow[];
  instancesLoading: boolean;
}) {
  const fetchGroups = useServerFn(listEvolutionGroups);
  const save = useServerFn(saveAgentEscalationAdmin);
  const qc = useQueryClient();

  const [instance, setInstance] = useState(agent.evolution_instance);
  const [grupo, setGrupo] = useState(agent.grupo_alerta);
  const [notify, setNotify] = useState(agent.notificar_agendamentos);
  const [tmpl, setTmpl] = useState(agent.notification_template);
  const [sumEn, setSumEn] = useState(agent.notification_summary_enabled);
  const [sumInstr, setSumInstr] = useState(agent.notification_summary_instruction);

  const groupsQ = useQuery({
    queryKey: ["admin", "evolution", "groups", instance],
    queryFn: () => fetchGroups({ data: { instance } }),
    enabled: !!instance,
  });

  const mut = useMutation({
    mutationFn: () =>
      save({
        data: {
          agentId: agent.id,
          evolution_instance: instance || undefined,
          grupo_alerta: grupo || undefined,
          notificar_agendamentos: notify,
          notification_template: tmpl,
          notification_summary_enabled: sumEn,
          notification_summary_instruction: sumInstr,
        },
      }),
    onSuccess: () => {
      toast.success(`Vinculação salva para ${agent.nome}`);
      qc.invalidateQueries({ queryKey: ["admin", "account"] });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Erro ao salvar"),
  });

  const groups =
    groupsQ.data && groupsQ.data.ok ? groupsQ.data.data : [];

  // Adiciona o JID atual como opcao caso nao apareca na listagem (grupo privado, etc).
  const groupOptions =
    grupo && !groups.find((g) => g.id === grupo)
      ? [{ id: grupo, subject: "(JID atual)" }, ...groups]
      : groups;

  const dirty =
    instance !== agent.evolution_instance ||
    grupo !== agent.grupo_alerta ||
    notify !== agent.notificar_agendamentos ||
    tmpl !== agent.notification_template ||
    sumEn !== agent.notification_summary_enabled ||
    sumInstr !== agent.notification_summary_instruction;

  return (
    <Card className="space-y-3 p-4">
      <div className="flex items-start justify-between">
        <div className="min-w-0">
          <div className="font-medium">{agent.nome}</div>
          <div className="font-mono text-[11px] text-muted-foreground">{agent.id}</div>
        </div>
        <span
          className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs ${
            agent.ativo
              ? "bg-green-50 text-green-700"
              : "bg-slate-100 text-slate-600"
          }`}
        >
          <span
            className={`h-1.5 w-1.5 rounded-full ${
              agent.ativo ? "bg-green-500" : "bg-slate-400"
            }`}
          />
          Escalada {agent.ativo ? "ativa" : "inativa"}
        </span>
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        <div className="space-y-1.5">
          <Label>Instância Evolution</Label>
          <Select value={instance || undefined} onValueChange={(v) => {
            setInstance(v);
            setGrupo("");
          }}>
            <SelectTrigger>
              <SelectValue placeholder={instancesLoading ? "Carregando…" : "Selecionar instância"} />
            </SelectTrigger>
            <SelectContent>
              {instances.map((i) => (
                <SelectItem key={i.name} value={i.name}>
                  {i.name} {i.status ? `· ${i.status}` : ""}
                </SelectItem>
              ))}
              {/* Permite manter um valor antigo que nao apareca na listagem */}
              {agent.evolution_instance &&
                !instances.find((i) => i.name === agent.evolution_instance) && (
                  <SelectItem value={agent.evolution_instance}>
                    {agent.evolution_instance} (atual)
                  </SelectItem>
                )}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1.5">
          <Label>Grupo de alerta</Label>
          <Select
            value={grupo || undefined}
            onValueChange={(v) => setGrupo(v)}
            disabled={!instance || groupsQ.isLoading}
          >
            <SelectTrigger>
              <SelectValue
                placeholder={
                  !instance
                    ? "Escolha uma instância primeiro"
                    : groupsQ.isLoading
                      ? "Carregando grupos…"
                      : "Selecionar grupo"
                }
              />
            </SelectTrigger>
            <SelectContent>
              {groupOptions.map((g) => (
                <SelectItem key={g.id} value={g.id}>
                  <span className="truncate">{g.subject}</span>
                  <span className="ml-2 text-[10px] text-muted-foreground">
                    {g.id.slice(0, 12)}…
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {groupsQ.data && groupsQ.data.ok === false && (
            <p className="text-xs text-rose-600">{groupsQ.data.message}</p>
          )}
        </div>
      </div>

      <div className="space-y-4 rounded-lg border border-slate-200 bg-slate-50/60 p-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <Label className="text-sm font-medium">Notificar agendamentos</Label>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Envia uma mensagem a este grupo sempre que um agendamento for
              confirmado, cancelado ou remarcado.
            </p>
            {notify && (!instance || !grupo) && (
              <p className="mt-1 text-xs text-amber-600">
                Selecione uma instância e um grupo acima para as notificações funcionarem.
              </p>
            )}
          </div>
          <Switch checked={notify} onCheckedChange={setNotify} />
        </div>
        {notify && (
          <NotificationFormatEditor
            template={tmpl}
            summaryEnabled={sumEn}
            summaryInstruction={sumInstr}
            onChange={(patch) => {
              if (patch.template !== undefined) setTmpl(patch.template);
              if (patch.summaryEnabled !== undefined) setSumEn(patch.summaryEnabled);
              if (patch.summaryInstruction !== undefined)
                setSumInstr(patch.summaryInstruction);
            }}
          />
        )}
      </div>

      <div className="flex items-center justify-end gap-2">
        {instance && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() =>
              qc.invalidateQueries({ queryKey: ["admin", "evolution", "groups", instance] })
            }
            disabled={groupsQ.isFetching}
          >
            <RefreshCw
              className={`mr-1.5 h-3.5 w-3.5 ${groupsQ.isFetching ? "animate-spin" : ""}`}
            />
            Recarregar grupos
          </Button>
        )}
        <Button size="sm" onClick={() => mut.mutate()} disabled={!dirty || mut.isPending}>
          {mut.isPending ? (
            <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
          ) : (
            <Check className="mr-1.5 h-3.5 w-3.5" />
          )}
          Salvar
        </Button>
      </div>
    </Card>
  );
}
