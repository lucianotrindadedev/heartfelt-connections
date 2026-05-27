// Replay determinístico de conversa (admin/dev tool).
// Carrega uma conversa real e re-executa cada turn do user com o código atual
// em dry-run. Útil para validar que um bug primário (ex.: lead_data sendo
// preenchido com mensagem de saudação) já não acontece com a versão atual.

import { createFileRoute, Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";

import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ArrowLeft, Loader2, Play } from "lucide-react";
import { toast } from "sonner";

import { replayConversation, type ReplayResult, type ReplayTurn } from "@/lib/replay.functions";

export const Route = createFileRoute("/_authenticated/admin/replay")({
  component: AdminReplay,
});

function AdminReplay() {
  const run = useServerFn(replayConversation);
  const [conversationId, setConversationId] = useState("");
  const [result, setResult] = useState<ReplayResult | null>(null);

  const mutation = useMutation<ReplayResult, Error, string>({
    mutationFn: async (id: string) => {
      const out = (await run({ data: { conversationId: id } })) as ReplayResult;
      return out;
    },
    onSuccess: (data) => {
      setResult(data);
      toast.success(`Replay concluído: ${data.totalTurns} turns reexecutados`);
    },
    onError: (e) => {
      toast.error(e instanceof Error ? e.message : "Erro ao reexecutar");
    },
  });

  const onRun = () => {
    const id = conversationId.trim();
    if (!id) {
      toast.error("Informe o conversationId");
      return;
    }
    mutation.mutate(id);
  };

  return (
    <div className="container mx-auto max-w-6xl space-y-6 p-6">
      <div className="flex items-center gap-2">
        <Link to="/admin">
          <Button variant="ghost" size="sm">
            <ArrowLeft className="h-4 w-4" />
            Voltar
          </Button>
        </Link>
        <h1 className="text-2xl font-semibold">Replay de Conversa (dry-run)</h1>
      </div>

      <Card className="space-y-3 p-4">
        <p className="text-sm text-muted-foreground">
          Cole o <code>conversationId</code> e clique em <b>Reexecutar</b>. O sistema vai rodar a mesma
          sequência de mensagens do usuário pelo código atual, em modo dry-run (sem efeitos colaterais).
          Útil para validar correções de bugs.
        </p>
        <div className="flex items-end gap-2">
          <div className="flex-1">
            <Label htmlFor="convId">Conversation ID (UUID)</Label>
            <Input
              id="convId"
              value={conversationId}
              onChange={(e) => setConversationId(e.target.value)}
              placeholder="00000000-0000-0000-0000-000000000000"
            />
          </div>
          <Button onClick={onRun} disabled={mutation.isPending}>
            {mutation.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Play className="h-4 w-4" />
            )}
            Reexecutar
          </Button>
        </div>
      </Card>

      {result && (
        <Card className="p-4">
          <div className="mb-3 flex flex-wrap items-center gap-x-6 gap-y-1 text-sm">
            <span>
              <b>Conta:</b> <code>{result.accountId}</code>
            </span>
            <span>
              <b>Agente:</b> <code>{result.agentId}</code>
            </span>
            <span>
              <b>Turns:</b> {result.totalTurns}
            </span>
          </div>
          <div className="space-y-4">
            {result.turns.map((t) => (
              <TurnCard key={t.index} turn={t} />
            ))}
          </div>
        </Card>
      )}
    </div>
  );
}

function TurnCard({ turn }: { turn: ReplayTurn }) {
  const telemetryKeys = turn.telemetry ? Object.keys(turn.telemetry) : [];
  const hasTelemetry = telemetryKeys.length > 0;
  const replyDiverged =
    turn.originalAssistantReply !== null &&
    turn.originalAssistantReply.trim() !== turn.replayReply.trim();

  return (
    <div className="rounded border bg-card p-3">
      <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
        <span>
          <b>#{turn.index + 1}</b>
        </span>
        <span>
          stage: <code>{turn.stageBefore}</code> → <code>{turn.stageAfter}</code>
        </span>
        <span>route: {turn.route}</span>
        <span>model: {turn.model}</span>
        {turn.toolsCalled.length > 0 && (
          <span>tools: {turn.toolsCalled.join(", ")}</span>
        )}
        {hasTelemetry && (
          <span className="rounded bg-yellow-100 px-1 text-yellow-800">
            telemetria: {telemetryKeys.join(", ")}
          </span>
        )}
        {replyDiverged && (
          <span className="rounded bg-orange-100 px-1 text-orange-800">divergente</span>
        )}
      </div>

      <div className="mb-2">
        <div className="text-xs font-semibold text-muted-foreground">USUÁRIO</div>
        <div className="whitespace-pre-wrap rounded bg-muted/40 p-2 text-sm">
          {turn.userMessage}
        </div>
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        <div>
          <div className="text-xs font-semibold text-muted-foreground">RESPOSTA ORIGINAL (banco)</div>
          <div className="whitespace-pre-wrap rounded bg-muted/40 p-2 text-sm">
            {turn.originalAssistantReply ?? "(sem resposta seguida)"}
          </div>
        </div>
        <div>
          <div className="text-xs font-semibold text-muted-foreground">RESPOSTA NOVA (replay)</div>
          <div
            className={`whitespace-pre-wrap rounded p-2 text-sm ${
              replyDiverged ? "bg-orange-50" : "bg-muted/40"
            }`}
          >
            {turn.replayReply}
          </div>
        </div>
      </div>

      {Object.keys(turn.leadDataAfter).length > 0 && (
        <details className="mt-2 text-xs">
          <summary className="cursor-pointer text-muted-foreground">lead_data após replay</summary>
          <pre className="mt-1 overflow-auto rounded bg-muted/40 p-2">
            {JSON.stringify(turn.leadDataAfter, null, 2)}
          </pre>
        </details>
      )}
      {hasTelemetry && (
        <details className="mt-2 text-xs">
          <summary className="cursor-pointer text-amber-700">telemetria</summary>
          <pre className="mt-1 overflow-auto rounded bg-amber-50 p-2">
            {JSON.stringify(turn.telemetry, null, 2)}
          </pre>
        </details>
      )}
    </div>
  );
}
