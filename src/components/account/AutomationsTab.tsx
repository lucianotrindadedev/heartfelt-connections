import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import type { Agent, AutomationRule } from "@/lib/types";
import { Trash2 } from "lucide-react";

export function AutomationsTab({ accountId }: { accountId: string }) {
  const queryClient = useQueryClient();
  const agents = useQuery({
    queryKey: ["agents", accountId],
    queryFn: () => api<Agent[]>(`/api/accounts/${accountId}/agents`),
  });
  const main = agents.data?.find((a) => a.kind === "main");

  const list = useQuery({
    queryKey: ["automations", main?.id],
    queryFn: () => api<AutomationRule[]>(`/api/agents/${main!.id}/automations`),
    enabled: !!main,
  });

  const [draft, setDraft] = useState<{
    trigger: AutomationRule["trigger"];
    conditions: string;
    actions: string;
  }>({
    trigger: "tag_changed",
    conditions: '{ "tag": "FUF Financeiro" }',
    actions: '[ { "type": "pause_ai" } ]',
  });

  const create = useMutation({
    mutationFn: () => {
      const conditions = JSON.parse(draft.conditions);
      const actions = JSON.parse(draft.actions);
      return api(`/api/agents/${main!.id}/automations`, {
        method: "POST",
        json: { trigger: draft.trigger, conditions, actions, enabled: true },
      });
    },
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ["automations", main?.id] }),
  });

  const remove = useMutation({
    mutationFn: (id: string) =>
      api(`/api/agents/${main!.id}/automations/${id}`, { method: "DELETE" }),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ["automations", main?.id] }),
  });

  if (!main)
    return (
      <div className="rounded-lg border border-border bg-card p-6 text-sm text-muted-foreground">
        Sem agente principal nesta conta.
      </div>
    );

  return (
    <div className="space-y-6">
      <form
        className="grid gap-3 rounded-lg border border-border bg-card p-4"
        onSubmit={(e) => {
          e.preventDefault();
          create.mutate();
        }}
      >
        <label className="block">
          <span className="mb-1 block text-xs font-medium uppercase text-muted-foreground">
            Trigger
          </span>
          <select
            value={draft.trigger}
            onChange={(e) =>
              setDraft({
                ...draft,
                trigger: e.target.value as AutomationRule["trigger"],
              })
            }
            className="input"
          >
            <option value="tag_changed">tag_changed (Helena)</option>
            <option value="appointment_status">appointment_status (Clinicorp)</option>
          </select>
        </label>
        <label className="block">
          <span className="mb-1 block text-xs font-medium uppercase text-muted-foreground">
            Conditions (JSON)
          </span>
          <textarea
            rows={3}
            value={draft.conditions}
            onChange={(e) => setDraft({ ...draft, conditions: e.target.value })}
            className="input font-mono text-xs"
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs font-medium uppercase text-muted-foreground">
            Actions (JSON array)
          </span>
          <textarea
            rows={3}
            value={draft.actions}
            onChange={(e) => setDraft({ ...draft, actions: e.target.value })}
            className="input font-mono text-xs"
          />
        </label>
        <button
          type="submit"
          disabled={create.isPending}
          className="self-start rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground disabled:opacity-50"
        >
          {create.isPending ? "Salvando…" : "Adicionar regra"}
        </button>
        {create.isError && (
          <p className="text-xs text-destructive">
            {(create.error as Error).message}
          </p>
        )}
      </form>

      <div className="rounded-lg border border-border bg-card">
        {list.data?.length === 0 && (
          <p className="p-4 text-sm text-muted-foreground">Sem regras.</p>
        )}
        {list.data?.map((rule) => (
          <div
            key={rule.id}
            className="flex items-start justify-between gap-3 border-b border-border p-3 text-sm last:border-0"
          >
            <div className="min-w-0 space-y-1">
              <p className="text-xs font-medium uppercase text-muted-foreground">
                {rule.trigger}
              </p>
              <pre className="overflow-auto rounded bg-muted p-2 text-[11px]">
                {JSON.stringify(rule.conditions, null, 2)}
              </pre>
              <pre className="overflow-auto rounded bg-muted p-2 text-[11px]">
                {JSON.stringify(rule.actions, null, 2)}
              </pre>
            </div>
            <button
              type="button"
              onClick={() => remove.mutate(rule.id)}
              className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-destructive"
            >
              <Trash2 className="h-4 w-4" />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
