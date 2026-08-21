// Controles de OPERAÇÃO do agente — saíram do card do cliente (embed) e vivem
// aqui. Motivo: são ações de infra/suporte, não do dia a dia de quem usa o
// agente, e "Resetar" a um clique do dono apagava TODO o histórico de conversas
// sem rede de proteção nenhuma.
//
// As funções são exatamente as mesmas de antes — nada foi desligado, só mudou
// de lugar.
import { useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Loader2, Power, RotateCcw, Zap, Sparkles, Copy, Check, AlertTriangle } from "lucide-react";
import { toast } from "sonner";
import { updateAgent, mergeAgentSettings } from "@/lib/agent.functions";
import { resetAgent } from "@/lib/integrations.functions";
import { helenaWebhookUrl } from "@/lib/app-base-url";

export function AccountAgentTab({
  accountId,
  agentId,
  ativo,
  settings,
}: {
  accountId: string;
  agentId: string | undefined;
  ativo: boolean;
  settings: Record<string, string>;
}) {
  const qc = useQueryClient();
  const updateAgentFn = useServerFn(updateAgent);
  const mergeSettingsFn = useServerFn(mergeAgentSettings);
  const resetAgentFn = useServerFn(resetAgent);

  const unified = (settings.agent_mode ?? "").toLowerCase() === "unified";
  const [copied, setCopied] = useState(false);
  const [resetConfirm, setResetConfirm] = useState("");

  const invalidate = () => qc.invalidateQueries({ queryKey: ["admin", "account", accountId] });

  const toggleAtivo = useMutation({
    mutationFn: (next: boolean) => updateAgentFn({ data: { accountId, ativo: next } }),
    onSuccess: (_r, next) => {
      toast.success(next ? "Agente ATIVADO." : "Agente pausado.");
      invalidate();
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Erro ao alterar status"),
  });

  const toggleAgentMode = useMutation({
    mutationFn: (next: boolean) =>
      mergeSettingsFn({
        data: { accountId, settings: { agent_mode: next ? "unified" : "staged" } },
      }),
    onSuccess: (_r, next) => {
      toast.success(next ? "Agente único ATIVADO." : "Voltou para o modo dividido.");
      invalidate();
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Erro ao alterar modo do agente"),
  });

  const doReset = useMutation({
    mutationFn: () => {
      if (!agentId) throw new Error("Agente indisponível");
      return resetAgentFn({ data: { agentId } });
    },
    onSuccess: (r) => {
      toast.success(`Histórico limpo em ${r.deleted ?? 0} conversa(s).`);
      setResetConfirm("");
      invalidate();
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Erro ao resetar"),
  });

  const webhookUrl = helenaWebhookUrl(accountId);
  const copyWebhook = async () => {
    try {
      await navigator.clipboard.writeText(webhookUrl);
      setCopied(true);
      toast.success("URL do webhook copiada.");
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error("Não foi possível copiar.");
    }
  };

  // Digitar o ID da conta é a trava do reset. É a única ação desta aba que
  // destrói dado e não tem desfazer.
  const resetArmed = resetConfirm.trim() === accountId.trim();

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Controles operacionais do agente. Ficavam no painel do cliente e foram movidos
        para cá — as funções são as mesmas.
      </p>

      {/* Ativo / pausado */}
      <Card className="p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="font-semibold">Status do agente</h3>
            <p className="mt-0.5 text-sm text-muted-foreground">
              Pausado, o agente não responde nenhum lead. As mensagens continuam sendo
              gravadas no histórico.
            </p>
          </div>
          <div className="flex items-center gap-3">
            <span
              className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-semibold ${
                ativo ? "bg-green-50 text-green-700" : "bg-slate-100 text-slate-600"
              }`}
            >
              <span className={`h-1.5 w-1.5 rounded-full ${ativo ? "bg-green-500" : "bg-slate-400"}`} />
              {ativo ? "Ativo" : "Pausado"}
            </span>
            <Button
              variant={ativo ? "outline" : "default"}
              size="sm"
              onClick={() => toggleAtivo.mutate(!ativo)}
              disabled={toggleAtivo.isPending}
            >
              {toggleAtivo.isPending ? (
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
              ) : (
                <Power className="mr-1.5 h-3.5 w-3.5" />
              )}
              {ativo ? "Pausar" : "Ativar"}
            </Button>
          </div>
        </div>
      </Card>

      {/* Agente único */}
      <Card className="p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="max-w-xl">
            <h3 className="flex items-center gap-2 font-semibold">
              <Sparkles className="h-4 w-4 text-violet-500" />
              Agente único
            </h3>
            <p className="mt-0.5 text-sm text-muted-foreground">
              No modo padrão o atendimento é dividido em dois sub-agentes (um conversa, outro
              mexe na agenda) e a troca entre eles pode falhar, deixando o lead sem os horários.
              No modo único, um só agente conduz da saudação ao agendamento com todas as
              ferramentas sempre à mão. Todas as travas de segurança continuam valendo.
            </p>
          </div>
          <div className="flex items-center gap-3">
            <span
              className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-semibold ${
                unified ? "bg-violet-50 text-violet-700" : "bg-slate-100 text-slate-600"
              }`}
            >
              {unified ? "Único" : "Dividido"}
            </span>
            <Button
              variant="outline"
              size="sm"
              onClick={() => toggleAgentMode.mutate(!unified)}
              disabled={toggleAgentMode.isPending}
            >
              {toggleAgentMode.isPending ? (
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
              ) : (
                <Sparkles className="mr-1.5 h-3.5 w-3.5" />
              )}
              {unified ? "Voltar p/ dividido" : "Ativar agente único"}
            </Button>
          </div>
        </div>
      </Card>

      {/* Webhook URL */}
      <Card className="p-4">
        <h3 className="flex items-center gap-2 font-semibold">
          <Zap className="h-4 w-4 text-amber-500" />
          Webhook URL
        </h3>
        <p className="mt-0.5 text-sm text-muted-foreground">
          Endereço que o CRM Helena chama a cada mensagem recebida.
        </p>
        <div className="mt-3 flex items-center gap-2">
          <code className="flex-1 break-all rounded bg-muted px-2 py-1.5 font-mono text-xs">
            {webhookUrl}
          </code>
          <Button size="icon" variant="ghost" className="h-7 w-7 shrink-0" onClick={copyWebhook}>
            {copied ? <Check className="h-3.5 w-3.5 text-green-500" /> : <Copy className="h-3.5 w-3.5" />}
          </Button>
        </div>
      </Card>

      {/* Reset — destrutivo */}
      <Card className="border-destructive/40 p-4">
        <h3 className="flex items-center gap-2 font-semibold text-destructive">
          <RotateCcw className="h-4 w-4" />
          Resetar histórico de conversas
        </h3>
        <div className="mt-2 flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
          <p className="text-sm text-muted-foreground">
            Apaga <b>todo</b> o histórico de mensagens de <b>todas</b> as conversas deste agente.
            Não tem desfazer, e leva junto o contexto que o agente usa pra continuar atendimentos
            em aberto. Para liberar, digite o ID da conta abaixo.
          </p>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Input
            value={resetConfirm}
            onChange={(e) => setResetConfirm(e.target.value)}
            placeholder={accountId}
            className="max-w-xs font-mono text-xs"
          />
          <Button
            variant="destructive"
            size="sm"
            onClick={() => doReset.mutate()}
            disabled={!resetArmed || doReset.isPending || !agentId}
          >
            {doReset.isPending ? (
              <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
            ) : (
              <RotateCcw className="mr-1.5 h-3.5 w-3.5" />
            )}
            Resetar histórico
          </Button>
        </div>
      </Card>
    </div>
  );
}
