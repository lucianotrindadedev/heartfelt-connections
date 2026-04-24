import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useState, useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import type { Template, CredentialField } from "@/lib/types";
import { ArrowLeft, Plus, Trash2, Save } from "lucide-react";

export const Route = createFileRoute("/admin/templates/$templateId")({
  component: AdminTemplateDetail,
});

function AdminTemplateDetail() {
  const { templateId } = Route.useParams();
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  const { data: template, isLoading } = useQuery({
    queryKey: ["admin", "template", templateId],
    queryFn: () => api<Template>(`/api/admin/templates/${templateId}`, { admin: true }),
  });

  const [form, setForm] = useState<Partial<Template>>({});
  const [credFields, setCredFields] = useState<CredentialField[]>([]);

  useEffect(() => {
    if (template) {
      setForm({
        label: template.label,
        description: template.description,
        integrationKey: template.integrationKey,
        requiredIntegrations: template.requiredIntegrations,
        optionalIntegrations: template.optionalIntegrations,
        defaultTools: template.defaultTools,
        defaultPrompt: template.defaultPrompt,
        toolInstructions: template.toolInstructions,
        enabled: template.enabled,
      });
      setCredFields(template.credentialFields || []);
    }
  }, [template]);

  const save = useMutation({
    mutationFn: () =>
      api(`/api/admin/templates/${templateId}`, {
        method: "PATCH",
        admin: true,
        json: {
          label: form.label,
          description: form.description,
          integration_key: form.integrationKey,
          required_integrations: form.requiredIntegrations,
          optional_integrations: form.optionalIntegrations,
          default_tools: form.defaultTools,
          default_prompt: form.defaultPrompt,
          tool_instructions: form.toolInstructions,
          credential_fields: credFields,
          enabled: form.enabled,
        },
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["admin", "template", templateId] });
      queryClient.invalidateQueries({ queryKey: ["admin", "templates"] });
    },
  });

  if (isLoading) return <p className="p-4 text-sm">Carregando...</p>;
  if (!template) return <p className="p-4 text-sm text-destructive">Template nao encontrado</p>;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <Link to="/admin/templates" className="text-xs text-muted-foreground hover:underline">
            <ArrowLeft className="inline h-3 w-3" /> Templates
          </Link>
          <h1 className="mt-1 text-xl font-semibold">{template.label}</h1>
          <p className="text-xs text-muted-foreground">key: <code>{template.key}</code></p>
        </div>
        <button
          onClick={() => save.mutate()}
          disabled={save.isPending}
          className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-2 text-sm text-primary-foreground disabled:opacity-50"
        >
          <Save className="h-4 w-4" /> Salvar
        </button>
      </div>

      {save.isSuccess && <p className="text-xs text-emerald-600">Salvo com sucesso!</p>}
      {save.isError && <p className="text-xs text-destructive">{(save.error as Error).message}</p>}

      <div className="grid gap-6 md:grid-cols-2">
        {/* Basic Info */}
        <div className="rounded-lg border border-border bg-card p-4 space-y-3">
          <h2 className="text-sm font-semibold">Informacoes gerais</h2>
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-muted-foreground">Label</span>
            <input value={form.label || ""} onChange={(e) => setForm({ ...form, label: e.target.value })} className="input" />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-muted-foreground">Descricao</span>
            <input value={form.description || ""} onChange={(e) => setForm({ ...form, description: e.target.value })} className="input" />
          </label>
          <label className="inline-flex items-center gap-2 text-sm">
            <input type="checkbox" checked={form.enabled ?? true} onChange={(e) => setForm({ ...form, enabled: e.target.checked })} />
            Template ativo
          </label>
        </div>

        {/* Credential Fields Editor */}
        <div className="rounded-lg border border-border bg-card p-4 space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold">Campos de credenciais</h2>
            <button
              onClick={() => setCredFields([...credFields, { key: "", label: "", type: "text", required: true }])}
              className="text-xs text-primary hover:underline"
            >
              <Plus className="inline h-3 w-3" /> Adicionar campo
            </button>
          </div>
          <p className="text-xs text-muted-foreground">
            Define quais campos aparecem no modal de configuracao para o cliente
          </p>
          {credFields.map((field, idx) => (
            <div key={idx} className="grid grid-cols-4 gap-2 items-end">
              <input
                placeholder="key"
                value={field.key}
                onChange={(e) => { const c = [...credFields]; c[idx] = { ...c[idx], key: e.target.value }; setCredFields(c); }}
                className="input text-xs"
              />
              <input
                placeholder="Label"
                value={field.label}
                onChange={(e) => { const c = [...credFields]; c[idx] = { ...c[idx], label: e.target.value }; setCredFields(c); }}
                className="input text-xs"
              />
              <select
                value={field.type}
                onChange={(e) => { const c = [...credFields]; c[idx] = { ...c[idx], type: e.target.value as any }; setCredFields(c); }}
                className="input text-xs"
              >
                <option value="text">Texto</option>
                <option value="password">Senha</option>
                <option value="google_oauth">Google OAuth</option>
              </select>
              <button
                onClick={() => setCredFields(credFields.filter((_, i) => i !== idx))}
                className="rounded-md border border-border p-1.5 text-destructive hover:bg-destructive/10 w-fit"
              >
                <Trash2 className="h-3 w-3" />
              </button>
            </div>
          ))}
        </div>
      </div>

      {/* Default Prompt */}
      <div className="rounded-lg border border-border bg-card p-4 space-y-3">
        <h2 className="text-sm font-semibold">Prompt padrao do agente</h2>
        <textarea
          value={form.defaultPrompt || ""}
          onChange={(e) => setForm({ ...form, defaultPrompt: e.target.value })}
          className="input min-h-[200px] font-mono text-xs"
          placeholder="Prompt do sistema que sera usado como default ao criar agentes com este template..."
        />
      </div>

      {/* Tool Instructions */}
      <div className="rounded-lg border border-border bg-card p-4 space-y-3">
        <h2 className="text-sm font-semibold">Instrucoes de ferramentas</h2>
        <p className="text-xs text-muted-foreground">Texto injetado apos o prompt principal, com regras de uso de ferramentas</p>
        <textarea
          value={form.toolInstructions || ""}
          onChange={(e) => setForm({ ...form, toolInstructions: e.target.value })}
          className="input min-h-[150px] font-mono text-xs"
          placeholder="Instrucoes sobre quando e como usar cada ferramenta..."
        />
      </div>
    </div>
  );
}
