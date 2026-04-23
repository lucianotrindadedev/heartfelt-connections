import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import type { Agent, MediaAsset } from "@/lib/types";
import { Trash2 } from "lucide-react";

export function MediaTab({ accountId }: { accountId: string }) {
  const queryClient = useQueryClient();
  const agents = useQuery({
    queryKey: ["agents", accountId],
    queryFn: () => api<Agent[]>(`/api/accounts/${accountId}/agents`),
  });
  const main = agents.data?.find((a) => a.kind === "main");

  const list = useQuery({
    queryKey: ["media", main?.id],
    queryFn: () => api<MediaAsset[]>(`/api/agents/${main!.id}/media`),
    enabled: !!main,
  });

  const [form, setForm] = useState({
    name: "",
    description: "",
    source: "gdrive" as MediaAsset["source"],
    external_id: "",
    mime_type: "image/jpeg",
  });

  const create = useMutation({
    mutationFn: () =>
      api(`/api/agents/${main!.id}/media`, { method: "POST", json: form }),
    onSuccess: () => {
      setForm({ ...form, name: "", external_id: "", description: "" });
      queryClient.invalidateQueries({ queryKey: ["media", main?.id] });
    },
  });

  const remove = useMutation({
    mutationFn: (id: string) =>
      api(`/api/agents/${main!.id}/media/${id}`, { method: "DELETE" }),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ["media", main?.id] }),
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
        className="grid gap-3 rounded-lg border border-border bg-card p-4 md:grid-cols-2"
        onSubmit={(e) => {
          e.preventDefault();
          create.mutate();
        }}
      >
        <Field label="Nome (chave)">
          <input
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            className="input"
            placeholder="foto_clinica_fachada"
            required
          />
        </Field>
        <Field label="Origem">
          <select
            value={form.source}
            onChange={(e) =>
              setForm({ ...form, source: e.target.value as MediaAsset["source"] })
            }
            className="input"
          >
            <option value="gdrive">Google Drive</option>
            <option value="supabase_storage">Supabase Storage</option>
          </select>
        </Field>
        <Field label="External ID (file_id Drive ou path Storage)">
          <input
            value={form.external_id}
            onChange={(e) => setForm({ ...form, external_id: e.target.value })}
            className="input"
            required
          />
        </Field>
        <Field label="MIME">
          <input
            value={form.mime_type}
            onChange={(e) => setForm({ ...form, mime_type: e.target.value })}
            className="input"
          />
        </Field>
        <Field label="Descrição (usada pelo LLM para escolher)" className="md:col-span-2">
          <textarea
            rows={2}
            value={form.description}
            onChange={(e) => setForm({ ...form, description: e.target.value })}
            className="input"
          />
        </Field>
        <div className="md:col-span-2">
          <button
            type="submit"
            disabled={create.isPending}
            className="rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground disabled:opacity-50"
          >
            {create.isPending ? "Adicionando…" : "Adicionar mídia"}
          </button>
        </div>
      </form>

      <div className="rounded-lg border border-border bg-card">
        {list.isLoading && (
          <p className="p-4 text-sm text-muted-foreground">Carregando…</p>
        )}
        {list.data?.length === 0 && (
          <p className="p-4 text-sm text-muted-foreground">Sem mídias.</p>
        )}
        {list.data && list.data.length > 0 && (
          <ul className="divide-y divide-border">
            {list.data.map((m) => (
              <li
                key={m.id}
                className="flex items-start justify-between gap-3 p-3 text-sm"
              >
                <div className="min-w-0">
                  <p className="font-medium">{m.name}</p>
                  <p className="truncate text-xs text-muted-foreground">
                    {m.source} · {m.mime_type} · {m.external_id}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {m.description}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => remove.mutate(m.id)}
                  className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-destructive"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function Field({
  label,
  children,
  className,
}: {
  label: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <label className={`block ${className ?? ""}`}>
      <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </span>
      {children}
    </label>
  );
}
