import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import type { Template } from "@/lib/types";
import { Plus, Pencil, Trash2, CheckCircle, XCircle } from "lucide-react";

export const Route = createFileRoute("/admin/templates")({
  component: AdminTemplates,
});

function AdminTemplates() {
  const queryClient = useQueryClient();
  const [showCreate, setShowCreate] = useState(false);

  const templates = useQuery({
    queryKey: ["admin", "templates"],
    queryFn: () => api<Template[]>("/api/admin/templates", { admin: true }),
  });

  const deleteMut = useMutation({
    mutationFn: (id: string) =>
      api(`/api/admin/templates/${id}`, { method: "DELETE", admin: true }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["admin", "templates"] }),
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">Templates de Agente</h1>
          <p className="text-sm text-muted-foreground">
            Defina os modelos de agente com suas integrações e ferramentas
          </p>
        </div>
        <button
          onClick={() => setShowCreate(true)}
          className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-2 text-sm text-primary-foreground"
        >
          <Plus className="h-4 w-4" /> Novo Template
        </button>
      </div>

      {showCreate && (
        <CreateTemplateForm
          onClose={() => setShowCreate(false)}
          onCreated={() => {
            setShowCreate(false);
            queryClient.invalidateQueries({ queryKey: ["admin", "templates"] });
          }}
        />
      )}

      <div className="rounded-lg border border-border bg-card">
        {templates.isLoading && <p className="p-4 text-sm">Carregando...</p>}
        {templates.data?.length === 0 && (
          <p className="p-4 text-sm text-muted-foreground">Nenhum template criado.</p>
        )}
        <ul className="divide-y divide-border">
          {templates.data?.map((t) => (
            <li key={t.id} className="flex items-center justify-between p-4">
              <div className="flex items-center gap-3">
                {t.imageUrl ? (
                  <img
                    src={t.imageUrl}
                    alt={t.label}
                    className="h-12 w-12 shrink-0 rounded-md border border-border object-cover bg-muted"
                  />
                ) : (
                  <div className="h-12 w-12 shrink-0 rounded-md border border-dashed border-border bg-muted/30" />
                )}
                <div className="space-y-1">
                  <div className="flex items-center gap-2">
                    <p className="font-medium">{t.label}</p>
                    {t.enabled ? (
                      <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2 py-0.5 text-xs text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400">
                        <CheckCircle className="h-3 w-3" /> Ativo
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                        <XCircle className="h-3 w-3" /> Inativo
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    <code className="rounded bg-muted px-1">{t.key}</code>
                    {" · "}
                    Integração: <strong>{t.integrationKey}</strong>
                    {" · "}
                    {t.requiredIntegrations.length} obrigatórias, {t.optionalIntegrations.length} opcionais
                    {" · "}
                    {t.credentialFields.length} campos de credencial
                  </p>
                  {t.description && (
                    <p className="text-xs text-muted-foreground">{t.description}</p>
                  )}
                </div>
              </div>
              <div className="flex items-center gap-2">
                <Link
                  to="/admin/templates/$templateId"
                  params={{ templateId: t.id }}
                  className="rounded-md border border-border p-1.5 hover:bg-accent"
                >
                  <Pencil className="h-3.5 w-3.5" />
                </Link>
                <button
                  onClick={() => {
                    if (confirm(`Excluir template "${t.label}"?`)) deleteMut.mutate(t.id);
                  }}
                  className="rounded-md border border-border p-1.5 text-destructive hover:bg-destructive/10"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

const INTEGRATION_KEYS = [
  { value: "clinicorp", label: "Clinicorp" },
  { value: "clinicexpress", label: "Clinic Express" },
  { value: "clinup", label: "Clinup" },
  { value: "google_calendar", label: "Google Agenda" },
];

const ALL_INTEGRATIONS = [
  "helena_crm", "clinicorp", "clinicexpress", "google_calendar", "google_drive",
  "clinup", "elevenlabs", "openrouter", "evolution_api", "central360", "groq",
];

function slugify(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "");
}

function CreateTemplateForm({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [form, setForm] = useState({
    key: "",
    label: "",
    description: "",
    integration_key: "clinicorp",
    required_integrations: ["helena_crm", "openrouter"] as string[],
    optional_integrations: [] as string[],
    default_prompt: "",
    image_url: "",
  });

  // Auto-gerar key a partir do label
  const handleLabelChange = (label: string) => {
    setForm((f) => ({ ...f, label, key: slugify(label) }));
  };

  const create = useMutation({
    mutationFn: () =>
      api("/api/admin/templates", {
        method: "POST",
        admin: true,
        json: { ...form, image_url: form.image_url || null },
      }),
    onSuccess: onCreated,
  });

  return (
    <div className="rounded-lg border border-border bg-card p-4 space-y-4">
      <h2 className="text-sm font-semibold">Novo Template</h2>
      <form
        onSubmit={(e) => { e.preventDefault(); create.mutate(); }}
        className="space-y-3"
      >
        <div className="grid gap-3 md:grid-cols-2">
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-muted-foreground">Label (nome exibido)</span>
            <input required value={form.label} onChange={(e) => handleLabelChange(e.target.value)} className="input" placeholder="Ex: Clinica Odontologica [Clinicorp]" />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-muted-foreground">Key (gerada automaticamente)</span>
            <input value={form.key} onChange={(e) => setForm({ ...form, key: e.target.value })} className="input bg-muted/50" placeholder="clinica_odontologica_clinicorp" />
          </label>
        </div>
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-muted-foreground">Descricao</span>
          <input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} className="input" placeholder="Descricao do template..." />
        </label>
        <div className="grid gap-3 md:grid-cols-[120px_1fr] items-start">
          {form.image_url ? (
            <img
              src={form.image_url}
              alt="Preview"
              className="h-[120px] w-[120px] rounded-md border border-border object-cover bg-muted"
              onError={(e) => { (e.target as HTMLImageElement).style.opacity = "0.3"; }}
            />
          ) : (
            <div className="flex h-[120px] w-[120px] items-center justify-center rounded-md border border-dashed border-border bg-muted/30 text-[10px] text-muted-foreground text-center px-2">
              Sem imagem
            </div>
          )}
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-muted-foreground">Imagem destaque (URL)</span>
            <input
              type="url"
              value={form.image_url}
              onChange={(e) => setForm({ ...form, image_url: e.target.value })}
              className="input"
              placeholder="https://exemplo.com/imagem.png"
            />
            <span className="mt-1 block text-[11px] text-muted-foreground">
              Cole a URL pública de uma imagem (PNG/JPG/SVG) que representará este template.
            </span>
          </label>
        </div>
        <div className="grid gap-3 md:grid-cols-2">
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-muted-foreground">Software de Agenda</span>
            <select value={form.integration_key} onChange={(e) => setForm({ ...form, integration_key: e.target.value })} className="input">
              {INTEGRATION_KEYS.map((i) => <option key={i.value} value={i.value}>{i.label}</option>)}
            </select>
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-muted-foreground">Integracoes obrigatorias</span>
            <div className="flex flex-wrap gap-2 rounded-md border border-border p-2">
              {ALL_INTEGRATIONS.map((i) => (
                <label key={i} className="inline-flex items-center gap-1 text-xs">
                  <input
                    type="checkbox"
                    checked={form.required_integrations.includes(i)}
                    onChange={(e) => {
                      if (e.target.checked) setForm({ ...form, required_integrations: [...form.required_integrations, i] });
                      else setForm({ ...form, required_integrations: form.required_integrations.filter((x) => x !== i) });
                    }}
                  />
                  {i}
                </label>
              ))}
            </div>
          </label>
        </div>
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-muted-foreground">Prompt base do template</span>
          <textarea
            value={form.default_prompt}
            onChange={(e) => setForm({ ...form, default_prompt: e.target.value })}
            className="input min-h-[200px] font-mono text-xs"
            placeholder="Cole aqui o prompt base que sera usado como default ao criar agentes com este template..."
          />
        </label>
        <div className="flex gap-2">
          <button type="submit" disabled={create.isPending} className="rounded-md bg-primary px-3 py-2 text-sm text-primary-foreground disabled:opacity-50">
            Criar
          </button>
          <button type="button" onClick={onClose} className="rounded-md border border-border px-3 py-2 text-sm hover:bg-accent">
            Cancelar
          </button>
          {create.isError && <p className="self-center text-xs text-destructive">{(create.error as Error).message}</p>}
        </div>
      </form>
    </div>
  );
}
