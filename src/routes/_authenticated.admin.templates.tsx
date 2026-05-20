import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState, useEffect } from "react";
import { Plus, Pencil, Trash2, Loader2, X, Eye, EyeOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { toast } from "sonner";
import {
  listAllTemplates,
  createTemplate,
  updateTemplate,
  deleteTemplate,
} from "@/lib/templates.functions";

export const Route = createFileRoute("/_authenticated/admin/templates")({
  component: AdminTemplates,
});

const INTEGRATION_OPTIONS = [
  { value: "", label: "Nenhuma" },
  { value: "clinicorp", label: "Clinicorp" },
  { value: "google_calendar", label: "Google Calendar" },
  { value: "clinup", label: "Clinup" },
] as const;

const INTEGRATION_COLORS: Record<string, string> = {
  clinicorp: "bg-teal-100 text-teal-700",
  google_calendar: "bg-blue-100 text-blue-700",
  clinup: "bg-violet-100 text-violet-700",
};

type TemplateRow = {
  id: string;
  nome: string;
  descricao: string;
  cover_url: string | null;
  system_prompt: string;
  integration_type: string | null;
  categoria: string;
  ordem: number;
  ativo: boolean;
};

type FormState = Omit<TemplateRow, "id"> & { id?: string };

const EMPTY_FORM: FormState = {
  nome: "",
  descricao: "",
  cover_url: "",
  system_prompt: "",
  integration_type: "",
  categoria: "geral",
  ordem: 0,
  ativo: true,
};

function AdminTemplates() {
  const qc = useQueryClient();
  const listFn = useServerFn(listAllTemplates);
  const createFn = useServerFn(createTemplate);
  const updateFn = useServerFn(updateTemplate);
  const deleteFn = useServerFn(deleteTemplate);

  const { data, isLoading } = useQuery({
    queryKey: ["admin", "templates"],
    queryFn: () => listFn(),
  });

  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [previewPrompt, setPreviewPrompt] = useState(false);

  const editing = !!form.id;

  function openCreate() {
    setForm(EMPTY_FORM);
    setPreviewPrompt(false);
    setShowForm(true);
  }

  function openEdit(t: TemplateRow) {
    setForm({ ...t, integration_type: t.integration_type ?? "", cover_url: t.cover_url ?? "" });
    setPreviewPrompt(false);
    setShowForm(true);
  }

  function closeForm() {
    setShowForm(false);
    setForm(EMPTY_FORM);
  }

  const save = useMutation({
    mutationFn: async () => {
      const payload = {
        nome: form.nome,
        descricao: form.descricao,
        cover_url: form.cover_url ?? "",
        system_prompt: form.system_prompt,
        integration_type: (form.integration_type ?? "") as "" | "clinicorp" | "google_calendar" | "clinup",
        categoria: form.categoria,
        ordem: form.ordem,
        ativo: form.ativo,
      };
      if (editing && form.id) {
        await updateFn({ data: { id: form.id, ...payload } });
      } else {
        await createFn({ data: payload });
      }
    },
    onSuccess: () => {
      toast.success(editing ? "Template atualizado." : "Template criado.");
      qc.invalidateQueries({ queryKey: ["admin", "templates"] });
      closeForm();
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Erro ao salvar."),
  });

  const del = useMutation({
    mutationFn: (id: string) => deleteFn({ data: { id } }),
    onSuccess: () => {
      toast.success("Template excluído.");
      qc.invalidateQueries({ queryKey: ["admin", "templates"] });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Erro ao excluir."),
  });

  const templates: TemplateRow[] = (data?.templates ?? []) as TemplateRow[];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Templates de Prompt</h1>
          <p className="text-sm text-muted-foreground">
            Templates disponíveis no seletor de treinamento do embed
          </p>
        </div>
        <Button onClick={openCreate}>
          <Plus className="mr-2 h-4 w-4" /> Novo template
        </Button>
      </div>

      {isLoading && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Carregando…
        </div>
      )}

      {templates.length === 0 && !isLoading && (
        <Card className="p-8 text-center">
          <p className="text-sm text-muted-foreground">Nenhum template cadastrado ainda.</p>
          <Button className="mt-4" onClick={openCreate}>Criar primeiro template</Button>
        </Card>
      )}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {templates.map((t) => (
          <Card key={t.id} className="overflow-hidden">
            {/* Cover */}
            <div
              className="h-28 w-full bg-gradient-to-br from-primary/20 to-primary/5 bg-cover bg-center"
              style={t.cover_url ? { backgroundImage: `url(${t.cover_url})` } : {}}
            />
            <div className="p-4 space-y-2">
              <div className="flex items-start justify-between gap-2">
                <p className="font-semibold text-sm leading-tight">{t.nome}</p>
                {!t.ativo && <Badge variant="outline" className="shrink-0 text-[10px]">Inativo</Badge>}
              </div>
              <p className="text-xs text-muted-foreground line-clamp-2">{t.descricao}</p>
              <div className="flex items-center gap-2 flex-wrap">
                <Badge variant="outline" className="text-[10px]">{t.categoria}</Badge>
                {t.integration_type && (
                  <Badge
                    variant="outline"
                    className={`text-[10px] border-0 ${INTEGRATION_COLORS[t.integration_type] ?? "bg-zinc-100 text-zinc-600"}`}
                  >
                    {INTEGRATION_OPTIONS.find((o) => o.value === t.integration_type)?.label}
                  </Badge>
                )}
              </div>
              <div className="flex gap-2 pt-1">
                <Button size="sm" variant="outline" className="flex-1" onClick={() => openEdit(t)}>
                  <Pencil className="mr-1 h-3.5 w-3.5" /> Editar
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="text-destructive hover:text-destructive"
                  onClick={() => {
                    if (confirm(`Excluir "${t.nome}"?`)) del.mutate(t.id);
                  }}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            </div>
          </Card>
        ))}
      </div>

      {/* ── Create / Edit modal ── */}
      {showForm && (
        <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/50 p-4 pt-10">
          <div className="w-full max-w-2xl rounded-2xl bg-white shadow-2xl">
            <div className="flex items-center justify-between border-b px-6 py-4">
              <h2 className="font-semibold">{editing ? "Editar template" : "Novo template"}</h2>
              <button onClick={closeForm} className="rounded p-1 hover:bg-slate-100">
                <X className="h-5 w-5" />
              </button>
            </div>

            <div className="space-y-4 overflow-y-auto px-6 py-4" style={{ maxHeight: "80vh" }}>
              {/* Nome */}
              <div>
                <Label>Nome *</Label>
                <Input
                  value={form.nome}
                  onChange={(e) => setForm((p) => ({ ...p, nome: e.target.value }))}
                  placeholder="Agendamentos Clinicorp"
                  className="mt-1"
                />
              </div>

              {/* Descrição */}
              <div>
                <Label>Descrição</Label>
                <Textarea
                  rows={2}
                  value={form.descricao}
                  onChange={(e) => setForm((p) => ({ ...p, descricao: e.target.value }))}
                  placeholder="Esse template conecta o agente ao Clinicorp para…"
                  className="mt-1"
                />
              </div>

              {/* Cover URL */}
              <div>
                <Label>URL da capa (imagem)</Label>
                <Input
                  value={form.cover_url ?? ""}
                  onChange={(e) => setForm((p) => ({ ...p, cover_url: e.target.value }))}
                  placeholder="https://..."
                  className="mt-1"
                />
                {form.cover_url && (
                  <img
                    src={form.cover_url}
                    alt="preview"
                    className="mt-2 h-24 w-full rounded-lg object-cover"
                    onError={(e) => (e.currentTarget.style.display = "none")}
                  />
                )}
              </div>

              {/* Integração */}
              <div>
                <Label>Integração requerida</Label>
                <select
                  value={form.integration_type ?? ""}
                  onChange={(e) => setForm((p) => ({ ...p, integration_type: e.target.value }))}
                  className="mt-1 w-full rounded-md border bg-background p-2 text-sm"
                >
                  {INTEGRATION_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>{o.label}</option>
                  ))}
                </select>
                <p className="mt-1 text-[11px] text-muted-foreground">
                  Se selecionada, o usuário precisa configurar a integração antes de aplicar o template.
                </p>
              </div>

              {/* Categoria + Ordem */}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label>Categoria</Label>
                  <Input
                    value={form.categoria}
                    onChange={(e) => setForm((p) => ({ ...p, categoria: e.target.value }))}
                    placeholder="geral"
                    className="mt-1"
                  />
                </div>
                <div>
                  <Label>Ordem (menor = primeiro)</Label>
                  <Input
                    type="number"
                    min={0}
                    value={form.ordem}
                    onChange={(e) => setForm((p) => ({ ...p, ordem: Number(e.target.value) }))}
                    className="mt-1"
                  />
                </div>
              </div>

              {/* System Prompt */}
              <div>
                <div className="flex items-center justify-between mb-1">
                  <Label>Prompt base *</Label>
                  <button
                    className="flex items-center gap-1 text-[11px] text-primary"
                    onClick={() => setPreviewPrompt((v) => !v)}
                  >
                    {previewPrompt ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                    {previewPrompt ? "Editar" : "Preview"}
                  </button>
                </div>
                {previewPrompt ? (
                  <pre className="mt-1 max-h-64 overflow-auto rounded-md border bg-slate-50 p-3 text-xs leading-relaxed whitespace-pre-wrap">
                    {form.system_prompt || <span className="text-muted-foreground">(vazio)</span>}
                  </pre>
                ) : (
                  <Textarea
                    rows={12}
                    value={form.system_prompt}
                    onChange={(e) => setForm((p) => ({ ...p, system_prompt: e.target.value }))}
                    placeholder="Você é um assistente virtual especializado em…"
                    className="mt-1 font-mono text-xs"
                  />
                )}
                <p className="mt-1 text-right text-[10px] text-muted-foreground">
                  {form.system_prompt.length.toLocaleString()} caracteres
                </p>
              </div>

              {/* Ativo */}
              <div className="flex items-center justify-between rounded-md border p-3">
                <span className="text-sm">Template ativo (visível no embed)</span>
                <Switch
                  checked={form.ativo}
                  onCheckedChange={(v) => setForm((p) => ({ ...p, ativo: v }))}
                />
              </div>
            </div>

            <div className="flex gap-3 border-t px-6 py-4">
              <Button onClick={() => save.mutate()} disabled={save.isPending || !form.nome.trim()} className="flex-1">
                {save.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                {editing ? "Salvar alterações" : "Criar template"}
              </Button>
              <Button variant="outline" onClick={closeForm}>Cancelar</Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
