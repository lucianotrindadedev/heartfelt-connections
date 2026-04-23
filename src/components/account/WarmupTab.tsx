import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import type { Agent, WarmupConfig } from "@/lib/types";

const WUS = [1, 2, 3, 4, 5] as const;

export function WarmupTab({ accountId }: { accountId: string }) {
  const queryClient = useQueryClient();
  const agents = useQuery({
    queryKey: ["agents", accountId],
    queryFn: () => api<Agent[]>(`/api/accounts/${accountId}/agents`),
  });
  const agent = agents.data?.find((a) => a.kind === "warmup");

  const cfg = useQuery({
    queryKey: ["warmup", agent?.id],
    queryFn: () => api<WarmupConfig>(`/api/agents/${agent!.id}/warmup`),
    enabled: !!agent,
  });

  const [draft, setDraft] = useState<WarmupConfig | null>(null);
  useEffect(() => {
    if (cfg.data) setDraft(cfg.data);
  }, [cfg.data]);

  const save = useMutation({
    mutationFn: async (payload: Partial<WarmupConfig>) =>
      api(`/api/agents/${agent!.id}/warmup`, { method: "PATCH", json: payload }),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ["warmup", agent?.id] }),
  });

  if (agents.isLoading) return <p>Carregando…</p>;
  if (!agent)
    return (
      <div className="rounded-lg border border-border bg-card p-6 text-sm text-muted-foreground">
        Esta conta ainda não tem agente de Warm-up. Crie pelo painel Admin.
      </div>
    );
  if (!draft) return <p>Carregando configuração…</p>;

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
        Warm-up ativo
      </label>

      <div className="grid gap-3 md:grid-cols-5">
        {WUS.map((n) => {
          const key = `tempo_wu${n}` as keyof WarmupConfig;
          return (
            <Field key={n} label={`WU${n} (horas antes)`}>
              <input
                type="number"
                min={0}
                value={draft[key] as number}
                onChange={(e) =>
                  setDraft({ ...draft, [key]: Number(e.target.value) } as WarmupConfig)
                }
                className="input"
              />
            </Field>
          );
        })}
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        <Field label="Subscriber ID (Clinicorp)">
          <input
            value={draft.subscriber_id ?? ""}
            onChange={(e) =>
              setDraft({ ...draft, subscriber_id: e.target.value })
            }
            className="input"
          />
        </Field>
        <Field label="Business ID (Clinicorp)">
          <input
            value={draft.business_id ?? ""}
            onChange={(e) =>
              setDraft({ ...draft, business_id: e.target.value })
            }
            className="input"
          />
        </Field>
      </div>

      <div className="space-y-3">
        {WUS.map((n) => {
          const key = `wu${n}` as keyof WarmupConfig["prompts"];
          return (
            <Field key={n} label={`Prompt WU${n}`}>
              <textarea
                rows={3}
                value={draft.prompts[key] ?? ""}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    prompts: { ...draft.prompts, [key]: e.target.value },
                  })
                }
                className="input font-mono text-xs"
              />
            </Field>
          );
        })}
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
