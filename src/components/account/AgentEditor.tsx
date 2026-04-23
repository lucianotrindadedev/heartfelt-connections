import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import type { Agent, AgentKind } from "@/lib/types";

const ALL_TOOLS = [
  "escalar_humano",
  "enviar_midia",
  "buscar_ou_criar_contato",
  "buscar_agendamentos",
  "criar_agendamento",
  "cancelar_agendamento",
  "listar_arquivos",
  "refletir",
];

export function AgentEditor({
  accountId,
  kind,
  emptyMessage,
}: {
  accountId: string;
  kind: AgentKind;
  emptyMessage: string;
}) {
  const queryClient = useQueryClient();
  const agentsQuery = useQuery({
    queryKey: ["agents", accountId],
    queryFn: () => api<Agent[]>(`/api/accounts/${accountId}/agents`),
  });

  const agent = agentsQuery.data?.find((a) => a.kind === kind);

  const [draft, setDraft] = useState<Agent | null>(null);
  useEffect(() => {
    if (agent) setDraft(agent);
  }, [agent?.id]);

  const save = useMutation({
    mutationFn: async (payload: Partial<Agent>) => {
      if (!agent) throw new Error("Agent not loaded");
      return api<Agent>(`/api/agents/${agent.id}`, {
        method: "PATCH",
        json: payload,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["agents", accountId] });
    },
  });

  if (agentsQuery.isLoading) {
    return <p className="text-sm text-muted-foreground">Carregando…</p>;
  }
  if (!agent || !draft) {
    return (
      <div className="rounded-lg border border-border bg-card p-6 text-sm text-muted-foreground">
        {emptyMessage}
      </div>
    );
  }

  const toggleTool = (tool: string) => {
    setDraft((d) =>
      d
        ? {
            ...d,
            tools: d.tools.includes(tool)
              ? d.tools.filter((t) => t !== tool)
              : [...d.tools, tool],
          }
        : d,
    );
  };

  return (
    <form
      className="space-y-5"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate({
          name: draft.name,
          enabled: draft.enabled,
          llm_provider: draft.llm_provider,
          llm_model: draft.llm_model,
          system_prompt: draft.system_prompt,
          tools: draft.tools,
        });
      }}
    >
      <div className="grid gap-4 md:grid-cols-2">
        <Field label="Nome do agente">
          <input
            value={draft.name}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            className="input"
          />
        </Field>
        <Field label="Status">
          <label className="inline-flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={draft.enabled}
              onChange={(e) =>
                setDraft({ ...draft, enabled: e.target.checked })
              }
            />
            Habilitado
          </label>
        </Field>
        <Field label="Provider">
          <input
            value={draft.llm_provider}
            onChange={(e) =>
              setDraft({ ...draft, llm_provider: e.target.value })
            }
            className="input"
            placeholder="openrouter"
          />
        </Field>
        <Field label="Modelo">
          <input
            value={draft.llm_model}
            onChange={(e) => setDraft({ ...draft, llm_model: e.target.value })}
            className="input"
            placeholder="x-ai/grok-4-fast"
          />
        </Field>
      </div>

      <Field label="System prompt">
        <textarea
          value={draft.system_prompt}
          onChange={(e) =>
            setDraft({ ...draft, system_prompt: e.target.value })
          }
          rows={14}
          className="input font-mono text-xs"
        />
      </Field>

      <Field label="Tools habilitadas">
        <div className="flex flex-wrap gap-2">
          {ALL_TOOLS.map((tool) => {
            const active = draft.tools.includes(tool);
            return (
              <button
                key={tool}
                type="button"
                onClick={() => toggleTool(tool)}
                className={
                  active
                    ? "rounded-md bg-primary px-2.5 py-1 text-xs text-primary-foreground"
                    : "rounded-md border border-border px-2.5 py-1 text-xs text-muted-foreground hover:bg-accent"
                }
              >
                {tool}
              </button>
            );
          })}
        </div>
      </Field>

      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={save.isPending}
          className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
        >
          {save.isPending ? "Salvando…" : "Salvar"}
        </button>
        {save.isError && (
          <span className="text-xs text-destructive">
            {(save.error as Error).message}
          </span>
        )}
        {save.isSuccess && (
          <span className="text-xs text-muted-foreground">Salvo.</span>
        )}
      </div>
    </form>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </span>
      {children}
    </label>
  );
}
