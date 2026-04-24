import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  Bold,
  Italic,
  Underline,
  Strikethrough,
  Link2,
  Mic,
  Redo2,
  Undo2,
  Sparkles,
  RefreshCw,
  MessageCircle,
  RotateCcw,
  LayoutTemplate,
  Play,
  Settings,
} from "lucide-react";
import { Link } from "@tanstack/react-router";
import { api } from "@/lib/api";
import type { Agent, AgentKind } from "@/lib/types";

const MAX_CHARS = 75000;

type Section = "instrucoes" | "midia" | "neural";

export function TrainingTab({
  accountId,
  kind = "main",
}: {
  accountId: string;
  kind?: AgentKind;
}) {
  const queryClient = useQueryClient();
  const agentsQuery = useQuery({
    queryKey: ["agents", accountId],
    queryFn: () => api<Agent[]>(`/api/accounts/${accountId}/agents`),
  });

  const agent = agentsQuery.data?.find((a) => a.kind === kind);

  const [prompt, setPrompt] = useState("");
  const [autosave, setAutosave] = useState(true);
  const [section, setSection] = useState<Section>("instrucoes");
  const [savedAt, setSavedAt] = useState<Date | null>(null);

  useEffect(() => {
    if (agent) setPrompt(agent.system_prompt ?? "");
  }, [agent?.id]);

  const save = useMutation({
    mutationFn: async (next: string) => {
      if (!agent) throw new Error("Agent not loaded");
      return api<Agent>(`/api/agents/${agent.id}`, {
        method: "PATCH",
        json: { system_prompt: next },
      });
    },
    onSuccess: () => {
      setSavedAt(new Date());
      queryClient.invalidateQueries({ queryKey: ["agents", accountId] });
    },
  });

  // Autosave debounced
  useEffect(() => {
    if (!autosave || !agent) return;
    if (prompt === agent.system_prompt) return;
    const t = setTimeout(() => save.mutate(prompt), 1200);
    return () => clearTimeout(t);
  }, [prompt, autosave, agent?.id]);

  const charCount = prompt.length;
  const isSaved = useMemo(
    () => agent && prompt === agent.system_prompt,
    [agent, prompt],
  );

  if (agentsQuery.isLoading) {
    return <p className="text-sm text-muted-foreground">Carregando agente…</p>;
  }
  if (!agent) {
    return (
      <div className="rounded-lg border border-border bg-card p-6 text-sm text-muted-foreground">
        Esta conta ainda não tem agente configurado.
      </div>
    );
  }

  const sectionDescriptions: Record<Section, string> = {
    instrucoes:
      "Use essa seção para cadastrar treinamentos gerais para que eu tenha informações suficientes para manter uma conversação adequada com os clientes",
    midia:
      "Adicione conteúdos em mídia (imagens, áudios, documentos) que o agente pode enviar durante a conversa.",
    neural:
      "Configure cadeias neurais — fluxos encadeados de raciocínio para tarefas específicas.",
  };

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center gap-2">
        <Settings className="h-4 w-4 text-muted-foreground" />
        <h1 className="text-sm font-semibold">Treinamento</h1>
      </div>

      {/* Top action bar */}
      <div className="flex flex-wrap items-center gap-2">
        <Link
          to="/embed/account/$accountId/main-agent"
          params={{ accountId }}
          className="inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-3 py-1.5 text-xs font-medium text-foreground hover:bg-accent"
        >
          <ArrowLeft className="h-3.5 w-3.5" /> VOLTAR
        </Link>
        <button className="inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-3 py-1.5 text-xs font-medium hover:bg-accent">
          <RefreshCw className="h-3.5 w-3.5" /> Atualizar instruções <Play className="h-3 w-3" />
        </button>
        <button className="inline-flex items-center gap-1.5 rounded-md bg-emerald-500 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-600">
          <MessageCircle className="h-3.5 w-3.5" /> Modo Treinador <Play className="h-3 w-3" />
        </button>
        <button className="inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-3 py-1.5 text-xs font-medium hover:bg-accent">
          <RotateCcw className="h-3.5 w-3.5" /> Follow Up <Play className="h-3 w-3" />
        </button>
        <button className="inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-3 py-1.5 text-xs font-medium hover:bg-accent">
          <LayoutTemplate className="h-3.5 w-3.5" /> Templates <Play className="h-3 w-3" />
        </button>
      </div>

      <p className="text-xs text-muted-foreground">
        Navegue pelas modalidades de treinamento clicando no botões abaixo
      </p>

      {/* Section tabs */}
      <div className="flex flex-wrap gap-2">
        <SectionButton
          active={section === "instrucoes"}
          onClick={() => setSection("instrucoes")}
        >
          INSTRUÇÕES
        </SectionButton>
        <SectionButton
          active={section === "midia"}
          onClick={() => setSection("midia")}
        >
          CONTEÚDOS EM MÍDIA
        </SectionButton>
        <SectionButton
          active={section === "neural"}
          onClick={() => setSection("neural")}
        >
          NEURAL CHAINS
        </SectionButton>
      </div>

      {/* Description bar */}
      <div className="rounded-md bg-slate-900 px-4 py-2.5 text-xs text-slate-100">
        {sectionDescriptions[section]}
      </div>

      {section === "instrucoes" && (
        <>
          {/* Toolbar */}
          <div className="flex flex-wrap items-center gap-1 rounded-md border border-border bg-card px-2 py-1.5">
            <ToolbarBtn icon={<Undo2 className="h-3.5 w-3.5" />} />
            <ToolbarBtn icon={<Redo2 className="h-3.5 w-3.5" />} />
            <Divider />
            <ToolbarBtn icon={<Bold className="h-3.5 w-3.5" />} />
            <ToolbarBtn icon={<Italic className="h-3.5 w-3.5" />} />
            <ToolbarBtn icon={<Underline className="h-3.5 w-3.5" />} />
            <ToolbarBtn icon={<Strikethrough className="h-3.5 w-3.5" />} />
            <Divider />
            <button className="inline-flex items-center gap-1 rounded px-2 py-1 text-xs hover:bg-accent">
              T Tamanho ▾
            </button>
            <Divider />
            <ToolbarBtn icon={<Link2 className="h-3.5 w-3.5" />} />
            <button className="ml-1 inline-flex items-center gap-1 rounded-md bg-slate-900 px-2.5 py-1 text-xs text-white hover:bg-slate-800">
              <Sparkles className="h-3.5 w-3.5" /> AI Magic
            </button>
            <ToolbarBtn icon={<Mic className="h-3.5 w-3.5" />} />
            <span className="ml-1 inline-flex items-center gap-1 text-xs text-muted-foreground">
              {charCount.toLocaleString("pt-BR")} / {MAX_CHARS.toLocaleString("pt-BR")} <Play className="h-3 w-3" />
            </span>
            <div className="ml-auto flex items-center gap-3">
              <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] font-medium text-emerald-700">
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                {save.isPending ? "Salvando…" : isSaved ? "Salvo" : "Não salvo"}
              </span>
              <label className="inline-flex items-center gap-2 text-xs text-muted-foreground">
                Autosave
                <input
                  type="checkbox"
                  checked={autosave}
                  onChange={(e) => setAutosave(e.target.checked)}
                  className="accent-amber-500"
                />
              </label>
            </div>
          </div>

          {/* Editor */}
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value.slice(0, MAX_CHARS))}
            rows={28}
            className="w-full rounded-md border border-border bg-card px-5 py-4 font-mono text-sm leading-relaxed text-foreground focus:outline-none focus:ring-2 focus:ring-primary/40"
            placeholder="Escreva aqui o prompt e instruções de treinamento do agente…"
          />

          {!autosave && (
            <div className="flex justify-end">
              <button
                onClick={() => save.mutate(prompt)}
                disabled={save.isPending || isSaved}
                className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
              >
                {save.isPending ? "Salvando…" : "Salvar"}
              </button>
            </div>
          )}

          {savedAt && (
            <p className="text-right text-[11px] text-muted-foreground">
              Última gravação: {savedAt.toLocaleTimeString("pt-BR")}
            </p>
          )}
        </>
      )}

      {section === "midia" && (
        <div className="rounded-md border border-dashed border-border bg-card p-10 text-center text-sm text-muted-foreground">
          Gerencie mídias na aba <strong>Mídias</strong>.
        </div>
      )}

      {section === "neural" && (
        <div className="rounded-md border border-dashed border-border bg-card p-10 text-center text-sm text-muted-foreground">
          Neural Chains em breve.
        </div>
      )}
    </div>
  );
}

function SectionButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={
        active
          ? "inline-flex items-center gap-1.5 rounded-md bg-slate-900 px-3 py-1.5 text-xs font-semibold text-white"
          : "inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-3 py-1.5 text-xs font-semibold text-foreground hover:bg-accent"
      }
    >
      {children} <Play className="h-3 w-3" />
    </button>
  );
}

function ToolbarBtn({ icon }: { icon: React.ReactNode }) {
  return (
    <button className="inline-flex h-7 w-7 items-center justify-center rounded hover:bg-accent">
      {icon}
    </button>
  );
}

function Divider() {
  return <span className="mx-1 h-5 w-px bg-border" />;
}
