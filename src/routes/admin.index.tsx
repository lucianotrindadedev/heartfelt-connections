import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import type { Account } from "@/lib/types";
import { ChevronRight, Plus } from "lucide-react";

export const Route = createFileRoute("/admin/")({
  component: AdminAccounts,
});

function AdminAccounts() {
  const queryClient = useQueryClient();
  const accounts = useQuery({
    queryKey: ["admin", "accounts"],
    queryFn: () => api<Account[]>("/api/admin/accounts", { admin: true }),
  });

  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ id: "", name: "", crm_base_api: "" });

  const create = useMutation({
    mutationFn: () =>
      api<Account>("/api/admin/accounts", {
        method: "POST",
        admin: true,
        json: form,
      }),
    onSuccess: () => {
      setCreating(false);
      setForm({ id: "", name: "", crm_base_api: "" });
      queryClient.invalidateQueries({ queryKey: ["admin", "accounts"] });
    },
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">Contas Helena</h1>
          <p className="text-sm text-muted-foreground">
            Cada conta corresponde a um <code>id_da_conta</code> do CRM Helena.
          </p>
        </div>
        <button
          onClick={() => setCreating((v) => !v)}
          className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-2 text-sm text-primary-foreground"
        >
          <Plus className="h-4 w-4" /> Nova conta
        </button>
      </div>

      {creating && (
        <form
          className="grid gap-3 rounded-lg border border-border bg-card p-4 md:grid-cols-3"
          onSubmit={(e) => {
            e.preventDefault();
            create.mutate();
          }}
        >
          <Field label="account_id (Helena)">
            <input
              required
              value={form.id}
              onChange={(e) => setForm({ ...form, id: e.target.value })}
              className="input"
            />
          </Field>
          <Field label="Nome">
            <input
              required
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              className="input"
            />
          </Field>
          <Field label="CRM Base API">
            <input
              value={form.crm_base_api}
              onChange={(e) =>
                setForm({ ...form, crm_base_api: e.target.value })
              }
              className="input"
              placeholder="https://api.helena.app"
            />
          </Field>
          <div className="md:col-span-3">
            <button
              type="submit"
              disabled={create.isPending}
              className="rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground disabled:opacity-50"
            >
              Criar
            </button>
          </div>
        </form>
      )}

      <div className="rounded-lg border border-border bg-card">
        {accounts.isLoading && <p className="p-4 text-sm">Carregando…</p>}
        {accounts.data?.length === 0 && (
          <p className="p-4 text-sm text-muted-foreground">
            Nenhuma conta cadastrada.
          </p>
        )}
        <ul className="divide-y divide-border">
          {accounts.data?.map((acc) => (
            <li key={acc.id}>
              <Link
                to="/admin/account/$accountId"
                params={{ accountId: acc.id }}
                className="flex items-center justify-between gap-4 p-3 text-sm hover:bg-accent"
              >
                <div>
                  <p className="font-medium">{acc.name}</p>
                  <p className="text-xs text-muted-foreground">{acc.id}</p>
                </div>
                <ChevronRight className="h-4 w-4 text-muted-foreground" />
              </Link>
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
