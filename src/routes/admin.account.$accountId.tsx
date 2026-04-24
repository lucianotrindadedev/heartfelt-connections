import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import type { Agent, AgentKind, Template } from "@/lib/types";
import { Plus, ExternalLink } from "lucide-react";

export const Route = createFileRoute("/admin/account/$accountId")({
  component: AdminAccountDetail,
});

const KINDS: AgentKind[] = ["main", "followup", "warmup"];

function AdminAccountDetail() {
  const { accountId } = Route.useParams();
  const queryClient = useQueryClient();

  const agents = useQuery({
    queryKey: ["admin", "agents", accountId],
    queryFn: () => api<Agent[]>(`/api/admin/accounts/${accountId}/agents`, { admin: true }),
  });

  // Load templates from DB
  const templates = useQuery({
    queryKey: ["admin", "templates"],
    queryFn: () => api<Template[]>("/api/admin/templates", { admin: true }),
  });

  const [form, setForm] = useState({
    name: "",
    kind: "main" as AgentKind,
    template: "",
  });

  const create = useMutation({
    mutationFn: () =>
      api(`/api/admin/accounts/${accountId}/agents`, {
        method: "POST",
        admin: true,
        json: form,
      }),
    onSuccess: () => {
      setForm({ ...form, name: "" });
      queryClient.invalidateQueries({ queryKey: ["admin", "agents", accountId] });
    },
  });

  // Set default template when templates load
  if (templates.data?.length && !form.template) {
    setForm((f) => ({ ...f, template: templates.data![0].key }));
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <Link to="/admin" className="text-xs text-muted-foreground hover:underline">
            ← Contas
          </Link>
          <h1 className="mt-1 text-xl font-semibold">{accountId}</h1>
        </div>
        <Link
          to="/embed/account/$accountId/overview"
          params={{ accountId }}
          search={{}}
          className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-2 text-sm hover:bg-accent"
        >
          <ExternalLink className="h-3.5 w-3.5" /> Abrir painel da conta
        </Link>
      </div>

      <form
        className="grid gap-3 rounded-lg border border-border bg-card p-4 md:grid-cols-4"
        onSubmit={(e) => {
          e.preventDefault();
          create.mutate();
        }}
      >
        <Field label="Nome">
          <input
            required
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            className="input"
            placeholder="Sarai Principal"
          />
        </Field>
        <Field label="Tipo">
          <select
            value={form.kind}
            onChange={(e) => setForm({ ...form, kind: e.target.value as AgentKind })}
            className="input"
          >
            {KINDS.map((k) => (
              <option key={k} value={k}>{k}</option>
            ))}
          </select>
        </Field>
        <Field label="Template">
          <select
            value={form.template}
            onChange={(e) => setForm({ ...form, template: e.target.value })}
            className="input"
          >
            {templates.isLoading && <option>Carregando...</option>}
            {templates.data?.map((t) => (
              <option key={t.key} value={t.key}>{t.label}</option>
            ))}
          </select>
        </Field>
        <div className="self-end">
          <button
            type="submit"
            disabled={create.isPending || !form.template}
            className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-2 text-sm text-primary-foreground disabled:opacity-50"
          >
            <Plus className="h-4 w-4" /> Criar agente
          </button>
        </div>
      </form>

      <div className="rounded-lg border border-border bg-card">
        {agents.isLoading && <p className="p-4 text-sm">Carregando...</p>}
        {agents.data?.length === 0 && (
          <p className="p-4 text-sm text-muted-foreground">
            Nenhum agente nesta conta.
          </p>
        )}
        <ul className="divide-y divide-border">
          {agents.data?.map((a) => (
            <li key={a.id} className="flex items-center justify-between p-3 text-sm">
              <div>
                <p className="font-medium">{a.name}</p>
                <p className="text-xs text-muted-foreground">
                  {a.kind} · {a.template} · {a.llm_provider}/{a.llm_model}
                </p>
              </div>
              <span
                className={
                  a.enabled
                    ? "rounded-full bg-secondary px-2 py-0.5 text-xs"
                    : "rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground"
                }
              >
                {a.enabled ? "Ativo" : "Pausado"}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </div>
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
