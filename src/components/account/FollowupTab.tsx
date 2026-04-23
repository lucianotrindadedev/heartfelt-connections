import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import type { Agent, FollowupConfig } from "@/lib/types";

export function FollowupTab({ accountId }: { accountId: string }) {
  const queryClient = useQueryClient();
  const agents = useQuery({
    queryKey: ["agents", accountId],
    queryFn: () => api<Agent[]>(`/api/accounts/${accountId}/agents`),
  });
  const agent = agents.data?.find((a) => a.kind === "followup");

  const cfgQuery = useQuery({
    queryKey: ["followup", agent?.id],
    queryFn: () =>
      api<FollowupConfig>(`/api/agents/${agent!.id}/followup`),
    enabled: !!agent,
  });

  const [draft, setDraft] = useState<FollowupConfig | null>(null);
  useEffect(() => {
    if (cfgQuery.data) setDraft(cfgQuery.data);
  }, [cfgQuery.data]);

  const save = useMutation({
    mutationFn: async (payload: Partial<FollowupConfig>) =>
      api(`/api/agents/${agent!.id}/followup`, {
        method: "PATCH",
        json: payload,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["followup", agent?.id] });
    },
  });

  if (agents.isLoading) return <p>Carregando…</p>;
  if (!agent)
    return (
      <div className="rounded-lg border border-border bg-card p-6 text-sm text-muted-foreground">
        Esta conta ainda não tem agente de Follow-up. Crie pelo painel Admin.
      </div>
    );
  if (!draft) return <p>Carregando configuração…</p>;

  const updatePrompt = (idx: number, value: string) => {
    const prompts = [...draft.prompts];
    prompts[idx] = value;
    setDraft({ ...draft, prompts });
  };

  return (
    <form
      className="space-y-5"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate(draft);
      }}
    >
      <label className="inline-flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={draft.enabled}
          onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })}
        />
        Follow-up ativo
      </label>

      <div className="grid gap-4 md:grid-cols-2">
        <Field label="Cron (formato 6 campos pg_cron)">
          <input
            value={draft.cron_expression}
            onChange={(e) =>
              setDraft({ ...draft, cron_expression: e.target.value })
            }
            className="input font-mono"
            placeholder="0 */10 8-21 * * *"
          />
        </Field>
        <Field label="Máximo de follow-ups por lead">
          <input
            type="number"
            min={1}
            max={10}
            value={draft.max_followups}
            onChange={(e) =>
              setDraft({ ...draft, max_followups: Number(e.target.value) })
            }
            className="input"
          />
        </Field>
      </div>

      <div className="space-y-3">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Prompts por sequência
        </p>
        {Array.from({ length: draft.max_followups }).map((_, idx) => (
          <Field key={idx} label={`Sequência #${idx + 1}`}>
            <textarea
              value={draft.prompts[idx] ?? ""}
              onChange={(e) => updatePrompt(idx, e.target.value)}
              rows={3}
              className="input font-mono text-xs"
              placeholder="Lead não respondeu há X horas. Use tom amigável…"
            />
          </Field>
        ))}
      </div>

      <button
        type="submit"
        disabled={save.isPending}
        className="rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground disabled:opacity-50"
      >
        {save.isPending ? "Salvando…" : "Salvar"}
      </button>
    </form>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </span>
      {children}
    </label>
  );
}
