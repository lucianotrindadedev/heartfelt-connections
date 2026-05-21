import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState, useEffect, useRef, useCallback } from "react";
import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { Color } from "@tiptap/extension-color";
import { TextStyle } from "@tiptap/extension-text-style";
import Highlight from "@tiptap/extension-highlight";
import Placeholder from "@tiptap/extension-placeholder";
import { Markdown } from "tiptap-markdown";
import {
  Bot,
  Power,
  RotateCcw,
  Play,
  GraduationCap,
  Settings,
  MessageCircle,
  Headphones,
  Calendar,
  Stethoscope,
  ClipboardList,
  Bell,
  Flame,
  UserX,
  KeyRound,
  Loader2,
  Check,
  ExternalLink,
  AlertCircle,
  ArrowRight,
  Zap,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import {
  getAgent,
  updateAgent,
  updateLlmConfig,
  updateVoiceConfig,
  updateAudio,
} from "@/lib/agent.functions";
import {
  setOpenRouterKey,
  setElevenLabsKey,
  setGroqKey,
  testOpenRouterKey,
  listOpenRouterModels,
  listElevenLabsVoices,
  getUsageSummary,
  getHelenaConfig,
  setHelenaConfig,
} from "@/lib/secrets.functions";
import {
  getGoogleCalendarStatusFn,
  getGoogleAuthUrl,
  disconnectGoogleCalendar,
  getClinicorpConfig,
  saveClinicorpConfig,
  testClinicorpConnection,
  listClinicorpProfessionalsFn,
  getClinupConfig,
  saveClinupConfig,
  testClinupConnection,
  getAgentEscalation,
  saveAgentEscalation,
  getFollowupConfig,
  saveFollowupConfig,
  getWarmupConfig,
  saveWarmupConfig,
  resetAgent,
} from "@/lib/integrations.functions";
import { listTemplates } from "@/lib/templates.functions";

export const Route = createFileRoute("/embed/account/$accountId/")({
  component: EmbedHome,
});

type SheetKey =
  | null
  | "training"
  | "settings"
  | "secrets"
  | "followup"
  | "warmup"
  | "escalation";

function EmbedHome() {
  const { accountId } = Route.useParams();
  const qc = useQueryClient();
  const fetchAgent = useServerFn(getAgent);
  const updateAgentFn = useServerFn(updateAgent);
  const resetAgentFn = useServerFn(resetAgent);

  const [openSheet, setOpenSheet] = useState<SheetKey>(null);

  const { data, isLoading } = useQuery({
    queryKey: ["agent", accountId],
    queryFn: () => fetchAgent({ data: { accountId } }),
  });

  const toggleAtivo = useMutation({
    mutationFn: (ativo: boolean) => updateAgentFn({ data: { accountId, ativo } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["agent", accountId] }),
  });

  const doReset = useMutation({
    mutationFn: () => resetAgentFn({ data: { agentId: data!.agent!.id as string } }),
    onSuccess: () => {
      toast.success("Histórico do agente limpo.");
      qc.invalidateQueries({ queryKey: ["agent", accountId] });
    },
  });

  if (isLoading || !data?.agent) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gradient-to-br from-slate-50 to-white">
        <div className="flex flex-col items-center gap-3">
          <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-primary/10">
            <Loader2 className="h-6 w-6 animate-spin text-primary" />
          </div>
          <p className="text-xs font-medium text-muted-foreground">Carregando…</p>
        </div>
      </div>
    );
  }

  const agent = data.agent;
  const ativo = agent.ativo as boolean;
  const agentId = agent.id as string;

  // Full-screen training view replaces the dashboard
  if (openSheet === "training") {
    return (
      <TrainingView
        accountId={accountId}
        initialPrompt={(agent.system_prompt as string | null) ?? ""}
        initialNome={(agent.nome as string) ?? ""}
        agentSettings={(agent.settings as Record<string, string> | null) ?? {}}
        onClose={() => setOpenSheet(null)}
      />
    );
  }

  // Full-screen settings view replaces the dashboard
  if (openSheet === "settings") {
    return (
      <AgentSettingsView
        accountId={accountId}
        agentId={agentId}
        agentSettings={(agent.settings as Record<string, string> | null) ?? {}}
        currentModel={(agent.llm_model_override as string | null) ?? (data.llm?.default_model as string | null) ?? ""}
        currentVoice={(data.voice?.elevenlabs_voice_id as string | null) ?? null}
        debounceSegundos={(agent.debounce_segundos as number | null) ?? 20}
        hasOpenRouter={!!data.secrets?.openrouter_last4}
        hasElevenLabs={!!data.secrets?.elevenlabs_last4}
        audioHabilitado={!!(data.audio?.habilitado)}
        audioTranscrever={!!(data.audio?.transcrever_in)}
        audioResponder={!!(data.audio?.responder_out)}
        onClose={() => setOpenSheet(null)}
      />
    );
  }

  // Full-screen Follow-up view
  if (openSheet === "followup") {
    return <FollowupView agentId={agentId} onClose={() => setOpenSheet(null)} />;
  }

  // Full-screen Warm-up view
  if (openSheet === "warmup") {
    return <WarmupView agentId={agentId} onClose={() => setOpenSheet(null)} />;
  }

  // Full-screen Escalation view
  if (openSheet === "escalation") {
    return <EscalationView agentId={agentId} onClose={() => setOpenSheet(null)} />;
  }

  return (
    <div className="min-h-screen w-full bg-gradient-to-br from-slate-50 via-white to-slate-50/80">
      {/* ── Header ── */}
      <header className="sticky top-0 z-20 border-b border-slate-200/60 bg-white/85 backdrop-blur-xl">
        <div className="flex items-center justify-between gap-3 px-4 py-3 sm:px-6">
          <div className="flex items-center gap-3">
            <div className="relative flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-primary to-primary/70 shadow-lg shadow-primary/25">
              <Bot className="h-5 w-5 text-white" />
              <span className={`absolute -right-0.5 -top-0.5 h-3 w-3 rounded-full border-2 border-white ${ativo ? "bg-emerald-400 shadow-sm shadow-emerald-400/50" : "bg-zinc-300"}`} />
            </div>
            <div>
              <p className="text-sm font-semibold leading-tight text-foreground">{agent.nome as string}</p>
              <p className="text-[11px] text-muted-foreground">{ativo ? "Atendendo agora" : "Assistente pausado"}</p>
            </div>
          </div>
          <div className="flex items-center gap-2.5">
            <span className={`hidden rounded-full px-3 py-1 text-[11px] font-semibold tracking-wide sm:inline-block ${ativo ? "bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200" : "bg-zinc-100 text-zinc-500 ring-1 ring-zinc-200"}`}>
              {ativo ? "● ATIVO" : "● PAUSADO"}
            </span>
            <Switch checked={ativo} onCheckedChange={(v) => toggleAtivo.mutate(v)} disabled={toggleAtivo.isPending} />
          </div>
        </div>
      </header>

      <main className="w-full space-y-6 px-4 py-6 sm:px-6">

        {/* ── Hero Card ── */}
        <div className={`relative overflow-hidden rounded-3xl p-6 shadow-xl transition-all ${ativo ? "bg-gradient-to-br from-primary via-primary/90 to-primary/75 shadow-primary/20" : "bg-gradient-to-br from-zinc-800 via-zinc-700 to-zinc-600 shadow-zinc-800/20"}`}>
          {/* decorative blobs */}
          <div className="pointer-events-none absolute -right-10 -top-10 h-40 w-40 rounded-full bg-white/10 blur-3xl" />
          <div className="pointer-events-none absolute -bottom-6 right-20 h-28 w-28 rounded-full bg-white/5 blur-2xl" />

          <div className="relative flex items-start gap-4">
            <div className="flex h-16 w-16 shrink-0 items-center justify-center rounded-2xl bg-white/15 ring-2 ring-white/20 backdrop-blur">
              <Bot className="h-9 w-9 text-white" />
            </div>
            <div className="flex-1 min-w-0 pt-1">
              <h2 className="text-xl font-bold tracking-tight text-white">{agent.nome as string}</h2>
              <p className="mt-0.5 text-sm text-white/70">
                {ativo ? "Pronto para atender seus clientes 24/7." : "Ative o agente para começar a atender."}
              </p>
            </div>
          </div>

          <div className="relative mt-5 flex flex-wrap gap-2">
            <button
              onClick={() => toggleAtivo.mutate(!ativo)}
              disabled={toggleAtivo.isPending}
              className="inline-flex items-center gap-2 rounded-xl bg-white/20 px-4 py-2 text-sm font-semibold text-white ring-1 ring-white/25 backdrop-blur transition-all hover:bg-white/30 active:scale-95 disabled:opacity-60"
            >
              {toggleAtivo.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Power className="h-4 w-4" />}
              {ativo ? "Pausar" : "Ativar assistente"}
            </button>
            <button
              onClick={() => { if (confirm("Isso apagará TODO o histórico de conversas. Continuar?")) doReset.mutate(); }}
              disabled={doReset.isPending}
              className="inline-flex items-center gap-2 rounded-xl bg-white/10 px-4 py-2 text-sm font-semibold text-white ring-1 ring-white/20 backdrop-blur transition-all hover:bg-white/20 active:scale-95 disabled:opacity-60"
            >
              {doReset.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <RotateCcw className="h-4 w-4" />}
              Resetar
            </button>
            <button
              onClick={() => { void navigator.clipboard.writeText(`https://iasarai.vercel.app/api/public/webhook/helena/${accountId}`); toast.success("URL do webhook copiada!"); }}
              className="inline-flex items-center gap-2 rounded-xl bg-white/10 px-4 py-2 text-sm font-semibold text-white ring-1 ring-white/20 backdrop-blur transition-all hover:bg-white/20 active:scale-95"
            >
              <Zap className="h-4 w-4" />
              Webhook URL
            </button>
          </div>
        </div>

        {/* ── Ações Principais ── */}
        <section>
          <SectionTitle>Ações principais</SectionTitle>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <ActionCard
              icon={<GraduationCap className="h-6 w-6" />}
              title="Base de conhecimento"
              subtitle="Prompt, personalidade e instruções avançadas"
              label="Configurar treinamentos"
              onClick={() => setOpenSheet("training")}
              iconClass="bg-gradient-to-br from-blue-500 to-blue-600 text-white shadow-blue-500/30"
              blobClass="bg-blue-400"
            />
            <ActionCard
              icon={<Settings className="h-6 w-6" />}
              title="Personalize seu assistente"
              subtitle="Modelo de IA, voz e debounce"
              label="Configurar"
              onClick={() => setOpenSheet("settings")}
              iconClass="bg-gradient-to-br from-purple-500 to-purple-600 text-white shadow-purple-500/30"
              blobClass="bg-purple-400"
              badge={!data.secrets?.openrouter_last4}
            />
          </div>
        </section>

        {/* ── Automações ── */}
        <section>
          <SectionTitle>Automações</SectionTitle>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <ActionCard
              icon={<Bell className="h-6 w-6" />}
              title="Follow-up"
              subtitle={data.followup?.ativo ? "Ativo · Reengajamento automático" : "Inativo · Reengajamento automático"}
              label="Configurar"
              onClick={() => setOpenSheet("followup")}
              iconClass="bg-gradient-to-br from-orange-400 to-orange-600 text-white shadow-orange-500/30"
              blobClass="bg-orange-400"
            />
            <ActionCard
              icon={<Flame className="h-6 w-6" />}
              title="Warm-up"
              subtitle={data.warmup?.ativo ? "Ativo · Mensagens pré-consulta" : "Inativo · Mensagens pré-consulta"}
              label="Configurar"
              onClick={() => setOpenSheet("warmup")}
              iconClass="bg-gradient-to-br from-red-400 to-rose-600 text-white shadow-rose-500/30"
              blobClass="bg-rose-400"
            />
            <ActionCard
              icon={<UserX className="h-6 w-6" />}
              title="Escalada humana"
              subtitle="Transferência com alerta via Evolution API"
              label="Configurar"
              onClick={() => setOpenSheet("escalation")}
              iconClass="bg-gradient-to-br from-pink-400 to-pink-600 text-white shadow-pink-500/30"
              blobClass="bg-pink-400"
            />
          </div>
        </section>

        {/* ── Mini custo ── */}
        <CostMiniCard accountId={accountId} />

        {/* ── Conexões e Custos ── */}
        <section>
          <button
            onClick={() => setOpenSheet("secrets")}
            className="group w-full overflow-hidden rounded-2xl border border-amber-200/60 bg-gradient-to-r from-amber-50 to-orange-50 p-4 text-left shadow-sm transition-all duration-200 hover:-translate-y-0.5 hover:shadow-lg hover:shadow-amber-500/10"
          >
            <div className="flex items-center gap-3">
              <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-amber-400 to-orange-500 text-white shadow-md shadow-amber-500/30">
                <KeyRound className="h-5 w-5" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-semibold text-foreground">Conexões e custos</p>
                <div className="mt-1 flex flex-wrap gap-2">
                  <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium ${data.secrets?.openrouter_last4 ? "bg-emerald-100 text-emerald-700" : "bg-red-100 text-red-600"}`}>
                    <span className={`h-1 w-1 rounded-full ${data.secrets?.openrouter_last4 ? "bg-emerald-500" : "bg-red-500"}`} />
                    OpenRouter {data.secrets?.openrouter_last4 ? `••${data.secrets.openrouter_last4}` : "não configurado"}
                  </span>
                  <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium ${data.secrets?.elevenlabs_last4 ? "bg-emerald-100 text-emerald-700" : "bg-zinc-100 text-zinc-500"}`}>
                    <span className={`h-1 w-1 rounded-full ${data.secrets?.elevenlabs_last4 ? "bg-emerald-500" : "bg-zinc-400"}`} />
                    ElevenLabs {data.secrets?.elevenlabs_last4 ? `••${data.secrets.elevenlabs_last4}` : "não configurado"}
                  </span>
                </div>
              </div>
              {!data.secrets?.openrouter_last4 && (
                <AlertCircle className="h-5 w-5 shrink-0 text-amber-500" />
              )}
              <ArrowRight className="h-4 w-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-1" />
            </div>
          </button>
        </section>

        <p className="pb-2 text-center text-[10px] text-muted-foreground/60">
          {accountId} · {agentId.slice(0, 8)}
        </p>
      </main>

      {/* SHEETS */}
      <SecretsSheet
        open={openSheet === "secrets"}
        onClose={() => setOpenSheet(null)}
        accountId={accountId}
        last4={{
          openrouter: (data.secrets?.openrouter_last4 as string | null) ?? null,
          elevenlabs: (data.secrets?.elevenlabs_last4 as string | null) ?? null,
          groq: (data.secrets?.groq_last4 as string | null) ?? null,
        }}
      />
    </div>
  );
}

// =================================================================
// Layout helpers
// =================================================================

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="mb-2 px-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
      {children}
    </h3>
  );
}

function ActionCard({
  icon,
  title,
  subtitle,
  label,
  onClick,
  iconClass,
  blobClass,
  badge,
}: {
  icon: React.ReactNode;
  title: string;
  subtitle: string;
  label: string;
  onClick: () => void;
  iconClass: string;
  blobClass: string;
  badge?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      className="group relative overflow-hidden rounded-2xl border border-slate-200/60 bg-white p-5 text-left shadow-sm transition-all duration-200 hover:-translate-y-0.5 hover:shadow-lg"
    >
      <div className={`pointer-events-none absolute -right-4 -top-4 h-20 w-20 rounded-full opacity-10 blur-2xl ${blobClass}`} />
      <div className="relative mb-4 flex items-start justify-between">
        <div className={`flex h-12 w-12 items-center justify-center rounded-xl shadow-md ${iconClass}`}>
          {icon}
        </div>
        {badge && (
          <Badge variant="outline" className="border-amber-400/40 bg-amber-500/10 text-amber-700 text-[10px]">
            Pendente
          </Badge>
        )}
      </div>
      <p className="text-sm font-semibold text-foreground">{title}</p>
      <p className="mb-4 text-xs text-muted-foreground">{subtitle}</p>
      <p className="inline-flex items-center gap-1 text-xs font-semibold text-primary transition-all group-hover:gap-2">
        {label} <ArrowRight className="h-3.5 w-3.5" />
      </p>
    </button>
  );
}

// =================================================================
// Full-screen: Training View
// =================================================================

type TrainingTab = "instrucoes" | "midia" | "neural";

function TrainingView({
  accountId,
  initialPrompt,
  initialNome,
  agentSettings,
  onClose,
}: {
  accountId: string;
  initialPrompt: string;
  initialNome: string;
  agentSettings: Record<string, string>;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const updateFn = useServerFn(updateAgent);
  const autoSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [tab, setTab] = useState<TrainingTab>("instrucoes");
  const [nome, setNome] = useState(initialNome);
  const [promptContent, setPromptContent] = useState(initialPrompt);
  const [charCount, setCharCount] = useState(initialPrompt.length);
  const [saveState, setSaveState] = useState<"saved" | "unsaved" | "saving">("saved");
  const [autosave, setAutosave] = useState(true);
  const [showTemplates, setShowTemplates] = useState(false);

  const doSave = useCallback(async (content?: string) => {
    const text = content ?? promptContent;
    setSaveState("saving");
    try {
      await updateFn({ data: { accountId, system_prompt: text, nome } });
      qc.invalidateQueries({ queryKey: ["agent", accountId] });
      setSaveState("saved");
    } catch {
      setSaveState("unsaved");
      toast.error("Erro ao salvar.");
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [promptContent, nome, accountId]);

  const handleChange = (markdown: string) => {
    setPromptContent(markdown);
    setCharCount(markdown.length);
    setSaveState("unsaved");
    if (autosave) {
      if (autoSaveTimer.current) clearTimeout(autoSaveTimer.current);
      autoSaveTimer.current = setTimeout(() => { void doSave(markdown); }, 2000);
    }
  };

  const applyTemplate = (prompt: string) => {
    setPromptContent(prompt);
    setCharCount(prompt.length);
    setSaveState("unsaved");
    if (autosave) {
      if (autoSaveTimer.current) clearTimeout(autoSaveTimer.current);
      autoSaveTimer.current = setTimeout(() => { void doSave(prompt); }, 2000);
    }
    setShowTemplates(false);
    toast.success("Template aplicado! Revise e salve.");
  };

  const tabs: { id: TrainingTab; label: string; icon: React.ReactNode }[] = [
    {
      id: "instrucoes",
      label: "INSTRUÇÕES",
      icon: <span className="flex h-4 w-4 items-center justify-center rounded-full border border-current text-[9px] font-bold">●</span>,
    },
    {
      id: "midia",
      label: "CONTEÚDOS EM MÍDIA",
      icon: <span className="flex h-4 w-4 items-center justify-center rounded-full border border-current text-[9px] font-bold">●</span>,
    },
    {
      id: "neural",
      label: "NEURAL CHAINS",
      icon: <span className="flex h-4 w-4 items-center justify-center rounded-full border border-current text-[9px] font-bold">●</span>,
    },
  ];

  return (
    <div className="flex min-h-screen flex-col bg-white">

      {/* ── Title bar ── */}
      <div className="flex items-center gap-2 border-b border-slate-100 px-5 py-3">
        <Bot className="h-4 w-4 text-primary" />
        <span className="text-sm font-semibold text-foreground">Treinamento</span>
      </div>

      {/* ── Action bar ── */}
      <div className="flex flex-wrap items-center gap-2 border-b border-slate-100 bg-white px-4 py-2.5">
        <button
          onClick={onClose}
          className="flex items-center gap-1 text-xs font-semibold text-primary hover:text-primary/80"
        >
          ← VOLTAR
        </button>

        <div className="mx-1 h-4 w-px bg-slate-200" />

        <button
          onClick={() => void doSave()}
          disabled={saveState === "saving"}
          className="flex items-center gap-1.5 rounded-full border border-slate-200 px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-slate-50 disabled:opacity-60"
        >
          {saveState === "saving"
            ? <Loader2 className="h-3 w-3 animate-spin" />
            : <RotateCcw className="h-3 w-3" />}
          Atualizar instruções
          <span className="flex h-4 w-4 items-center justify-center rounded-full border border-slate-300 text-[9px]">▶</span>
        </button>

        <button
          className="flex items-center gap-1.5 rounded-full bg-emerald-500 px-3 py-1.5 text-xs font-semibold text-white shadow-sm shadow-emerald-500/30 transition-opacity hover:opacity-90"
          onClick={() => toast.info("Modo Treinador em breve!")}
        >
          <MessageCircle className="h-3 w-3" />
          Modo Treinador
          <span className="flex h-4 w-4 items-center justify-center rounded-full bg-white/20 text-[9px]">▶</span>
        </button>

        <button
          className="flex items-center gap-1.5 rounded-full border border-slate-200 px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-slate-50"
          onClick={() => toast.info("Follow Up em breve!")}
        >
          Follow Up
          <span className="flex h-4 w-4 items-center justify-center rounded-full border border-slate-300 text-[9px]">▶</span>
        </button>

        <button
          className="flex items-center gap-1.5 rounded-full border border-slate-200 px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-slate-50"
          onClick={() => setShowTemplates(true)}
        >
          Templates
          <span className="flex h-4 w-4 items-center justify-center rounded-full border border-slate-300 text-[9px]">▶</span>
        </button>
      </div>

      {/* ── Nav hint ── */}
      <p className="px-5 py-1.5 text-[11px] text-muted-foreground">
        Navegue pelas modalidades de treinamento clicando nos botões abaixo
      </p>

      {/* ── Tabs ── */}
      <div className="flex items-end gap-0 border-b border-slate-200 px-4">
        {tabs.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`flex items-center gap-2 px-4 py-2.5 text-[11px] font-bold tracking-wider transition-colors ${
              tab === t.id
                ? "border-b-[3px] border-primary bg-primary text-white"
                : "border-b-[3px] border-transparent text-muted-foreground hover:text-foreground"
            }`}
          >
            {t.icon}
            {t.label}
            <span className="flex h-4 w-4 items-center justify-center rounded-full border border-current text-[9px]">●</span>
          </button>
        ))}
      </div>

      {/* ── Tab content ── */}
      {tab === "instrucoes" ? (
        <>
          {/* Description banner */}
          <div className="bg-primary px-5 py-2.5 text-xs text-white/90">
            Use essa seção para cadastrar treinamentos gerais para que eu tenha informações suficientes para manter uma conversação adequada com os clientes
          </div>

          {/* Agent name bar */}
          <div className="flex items-center gap-2 border-b border-slate-100 px-5 py-2">
            <Label className="shrink-0 text-xs text-muted-foreground">Nome:</Label>
            <Input
              value={nome}
              onChange={(e) => { setNome(e.target.value); setSaveState("unsaved"); }}
              placeholder="Nome do agente"
              className="h-7 border-0 bg-transparent px-0 text-sm font-medium shadow-none focus-visible:ring-0"
            />
          </div>

          {/* Rich text editor */}
          <PromptEditor
            key={promptContent === initialPrompt ? "init" : undefined}
            initialContent={promptContent}
            onChange={handleChange}
            charCount={charCount}
            saveState={saveState}
            autosave={autosave}
            onAutosaveChange={setAutosave}
            onSave={() => void doSave()}
          />
        </>
      ) : (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 p-12 text-center">
          {tab === "midia" ? (
            <>
              <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-sky-100">
                <GraduationCap className="h-7 w-7 text-sky-500" />
              </div>
              <p className="text-sm font-semibold text-foreground">Conteúdos em Mídia</p>
              <p className="max-w-xs text-xs text-muted-foreground">
                Envie documentos, PDFs e imagens para treinar o agente com conteúdo visual. Em breve!
              </p>
            </>
          ) : (
            <>
              <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-violet-100">
                <Settings className="h-7 w-7 text-violet-500" />
              </div>
              <p className="text-sm font-semibold text-foreground">Neural Chains</p>
              <p className="max-w-xs text-xs text-muted-foreground">
                Crie fluxos de raciocínio encadeados para guiar o agente em situações complexas. Em breve!
              </p>
            </>
          )}
          <span className="mt-2 rounded-full bg-slate-100 px-3 py-1 text-[11px] font-medium text-slate-500">
            Em breve
          </span>
        </div>
      )}

      {/* Templates modal */}
      {showTemplates && (
        <TemplatesModal
          accountId={accountId}
          onClose={() => setShowTemplates(false)}
          onApply={applyTemplate}
          agentSettings={agentSettings}
        />
      )}
    </div>
  );
}

// =================================================================
// Prompt Editor (TipTap WYSIWYG with Markdown I/O)
// =================================================================

// Color palettes
const TEXT_COLORS = [
  { label: "Padrão", color: null },
  { label: "Vermelho", color: "#dc2626" },
  { label: "Laranja", color: "#ea580c" },
  { label: "Amarelo", color: "#ca8a04" },
  { label: "Verde", color: "#16a34a" },
  { label: "Azul", color: "#2563eb" },
  { label: "Roxo", color: "#9333ea" },
  { label: "Cinza", color: "#64748b" },
];

const HIGHLIGHT_COLORS = [
  { label: "Sem destaque", color: null },
  { label: "🔴 Atenção", color: "#fee2e2" },
  { label: "🟡 Aviso", color: "#fef9c3" },
  { label: "🟢 Sucesso", color: "#dcfce7" },
  { label: "🔵 Info", color: "#dbeafe" },
  { label: "🟣 Especial", color: "#f3e8ff" },
];

function PromptEditor({
  initialContent,
  onChange,
  charCount,
  saveState,
  autosave,
  onAutosaveChange,
  onSave,
}: {
  initialContent: string;
  onChange: (md: string) => void;
  charCount: number;
  saveState: "saved" | "unsaved" | "saving";
  autosave: boolean;
  onAutosaveChange: (v: boolean) => void;
  onSave: () => void;
}) {
  const [showColorPicker, setShowColorPicker] = useState<"text" | "highlight" | null>(null);

  const editor = useEditor({
    extensions: [
      StarterKit.configure({ heading: { levels: [1, 2, 3] } }),
      TextStyle,
      Color,
      Highlight.configure({ multicolor: true }),
      Placeholder.configure({
        placeholder: "Você é um assistente virtual especializado em… Descreva aqui a personalidade, tom, objetivos e regras do agente.",
      }),
      Markdown.configure({ html: false, tightLists: true }),
    ],
    content: initialContent,
    onUpdate: ({ editor }) => {
      const mdStorage = editor.storage as { markdown?: { getMarkdown: () => string } };
      const md = mdStorage.markdown?.getMarkdown() ?? editor.getText();
      onChange(md);
    },
    editorProps: {
      attributes: {
        class: "p-5 cursor-text",
        style: "min-height: calc(100vh - 320px)",
      },
    },
  });

  // When initialContent changes externally (template applied), sync editor
  const prevContent = useRef(initialContent);
  useEffect(() => {
    if (editor && initialContent !== prevContent.current) {
      prevContent.current = initialContent;
      editor.commands.setContent(initialContent);
    }
  }, [initialContent, editor]);

  const isActive = (name: string, attrs?: Record<string, unknown>) =>
    editor?.isActive(name, attrs) ?? false;

  const btn = (active: boolean) =>
    `rounded p-1.5 text-sm font-medium transition-colors ${
      active
        ? "bg-primary/10 text-primary"
        : "text-slate-600 hover:bg-slate-100"
    }`;

  if (!editor) return null;

  return (
    <div className="flex flex-1 flex-col">
      {/* ── Toolbar ── */}
      <div className="sticky top-0 z-10 flex flex-wrap items-center gap-0.5 border-b border-slate-100 bg-white px-3 py-1.5 shadow-sm">

        {/* Undo / Redo */}
        <button
          onClick={() => editor.chain().focus().undo().run()}
          title="Desfazer (Ctrl+Z)"
          className="rounded p-1.5 text-slate-500 hover:bg-slate-100 disabled:opacity-30"
          disabled={!editor.can().undo()}
        >
          <svg viewBox="0 0 24 24" className="h-4 w-4 fill-none stroke-current stroke-[1.75]"><path d="M3 7h10a5 5 0 0 1 0 10H3m0-10 4-4M3 7l4 4" strokeLinecap="round" strokeLinejoin="round"/></svg>
        </button>
        <button
          onClick={() => editor.chain().focus().redo().run()}
          title="Refazer (Ctrl+Y)"
          className="rounded p-1.5 text-slate-500 hover:bg-slate-100 disabled:opacity-30"
          disabled={!editor.can().redo()}
        >
          <svg viewBox="0 0 24 24" className="h-4 w-4 fill-none stroke-current stroke-[1.75]"><path d="M21 7H11a5 5 0 0 0 0 10h10m0-10-4-4m4 4-4 4" strokeLinecap="round" strokeLinejoin="round"/></svg>
        </button>
        <div className="mx-1 h-4 w-px bg-slate-200" />

        {/* Headings */}
        <button onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()} title="Título 1" className={btn(isActive("heading", { level: 1 }))}>
          <span className="text-xs font-bold">H1</span>
        </button>
        <button onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()} title="Título 2" className={btn(isActive("heading", { level: 2 }))}>
          <span className="text-xs font-bold">H2</span>
        </button>
        <button onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()} title="Título 3" className={btn(isActive("heading", { level: 3 }))}>
          <span className="text-xs font-bold">H3</span>
        </button>
        <div className="mx-1 h-4 w-px bg-slate-200" />

        {/* Inline formatting */}
        <button onClick={() => editor.chain().focus().toggleBold().run()} title="Negrito (Ctrl+B)" className={btn(isActive("bold"))}>
          <span className="font-bold">B</span>
        </button>
        <button onClick={() => editor.chain().focus().toggleItalic().run()} title="Itálico (Ctrl+I)" className={btn(isActive("italic"))}>
          <span className="italic">I</span>
        </button>
        <button onClick={() => editor.chain().focus().toggleStrike().run()} title="Tachado" className={btn(isActive("strike"))}>
          <span className="line-through">S</span>
        </button>
        <button onClick={() => editor.chain().focus().toggleCode().run()} title="Código inline" className={btn(isActive("code"))}>
          <span className="font-mono text-xs">{"`"}</span>
        </button>
        <div className="mx-1 h-4 w-px bg-slate-200" />

        {/* Text color */}
        <div className="relative">
          <button
            title="Cor do texto"
            onClick={() => setShowColorPicker(showColorPicker === "text" ? null : "text")}
            className={`flex items-center gap-1 rounded p-1.5 text-xs font-medium transition-colors hover:bg-slate-100 ${showColorPicker === "text" ? "bg-slate-100" : ""}`}
          >
            <span style={{ color: editor.getAttributes("textStyle").color || "#1e293b" }} className="font-bold text-sm">A</span>
            <span className="text-slate-400">▾</span>
          </button>
          {showColorPicker === "text" && (
            <div className="absolute left-0 top-full z-20 mt-1 rounded-lg border bg-white p-2 shadow-xl">
              <p className="mb-1.5 text-[10px] font-semibold text-slate-500 uppercase tracking-wide">Cor do texto</p>
              <div className="flex flex-col gap-1">
                {TEXT_COLORS.map((c) => (
                  <button
                    key={c.label}
                    onClick={() => {
                      if (c.color) {
                        editor.chain().focus().setColor(c.color).run();
                      } else {
                        editor.chain().focus().unsetColor().run();
                      }
                      setShowColorPicker(null);
                    }}
                    className="flex items-center gap-2 rounded px-2 py-1 text-xs hover:bg-slate-50"
                  >
                    <span
                      className="h-4 w-4 rounded-full border border-slate-200 flex-shrink-0"
                      style={{ background: c.color ?? "#fff", borderColor: c.color ? "transparent" : "#cbd5e1" }}
                    />
                    <span style={{ color: c.color ?? undefined }}>{c.label}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Highlight (background color) */}
        <div className="relative">
          <button
            title="Destaque de área"
            onClick={() => setShowColorPicker(showColorPicker === "highlight" ? null : "highlight")}
            className={`flex items-center gap-1 rounded p-1.5 text-xs font-medium transition-colors hover:bg-slate-100 ${showColorPicker === "highlight" ? "bg-slate-100" : ""}`}
          >
            <span className="flex h-4 w-4 items-center justify-center rounded-sm text-[11px]" style={{ background: "#fef9c3" }}>
              ▮
            </span>
            <span className="text-slate-400">▾</span>
          </button>
          {showColorPicker === "highlight" && (
            <div className="absolute left-0 top-full z-20 mt-1 rounded-lg border bg-white p-2 shadow-xl">
              <p className="mb-1.5 text-[10px] font-semibold text-slate-500 uppercase tracking-wide">Área de destaque</p>
              <div className="flex flex-col gap-1">
                {HIGHLIGHT_COLORS.map((c) => (
                  <button
                    key={c.label}
                    onClick={() => {
                      if (c.color) {
                        editor.chain().focus().setHighlight({ color: c.color }).run();
                      } else {
                        editor.chain().focus().unsetHighlight().run();
                      }
                      setShowColorPicker(null);
                    }}
                    className="flex items-center gap-2 rounded px-2 py-1 text-xs hover:bg-slate-50"
                  >
                    <span
                      className="h-4 w-4 rounded flex-shrink-0 border border-slate-200"
                      style={{ background: c.color ?? "#fff" }}
                    />
                    {c.label}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
        <div className="mx-1 h-4 w-px bg-slate-200" />

        {/* Lists */}
        <button onClick={() => editor.chain().focus().toggleBulletList().run()} title="Lista com marcadores" className={btn(isActive("bulletList"))}>
          <svg viewBox="0 0 24 24" className="h-4 w-4 fill-none stroke-current stroke-[1.75]"><path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" strokeLinecap="round"/></svg>
        </button>
        <button onClick={() => editor.chain().focus().toggleOrderedList().run()} title="Lista numerada" className={btn(isActive("orderedList"))}>
          <svg viewBox="0 0 24 24" className="h-4 w-4 fill-none stroke-current stroke-[1.75]"><path d="M10 6h11M10 12h11M10 18h11M4 6h.01M4 12h.01M4 18h.01" strokeLinecap="round"/><path d="M3 8V6l1.5-1" strokeLinecap="round" strokeLinejoin="round"/></svg>
        </button>

        {/* Blockquote */}
        <button onClick={() => editor.chain().focus().toggleBlockquote().run()} title="Citação / bloco de atenção" className={btn(isActive("blockquote"))}>
          <svg viewBox="0 0 24 24" className="h-4 w-4 fill-none stroke-current stroke-[1.75]"><path d="M3 21c3 0 7-1 7-8V5c0-1.25-.756-2.017-2-2H4c-1.25 0-2 .75-2 1.972V11c0 1.25.75 2 2 2 1 0 1 0 1 1v1c0 1-1 2-2 2s-1 .008-1 1.031V20c0 1 0 1 1 1zm12 0c3 0 7-1 7-8V5c0-1.25-.757-2.017-2-2h-4c-1.25 0-2 .75-2 1.972V11c0 1.25.75 2 2 2h.75c0 2.25.25 4-2.75 4v3c0 1 0 1 1 1z" strokeLinecap="round"/></svg>
        </button>

        {/* Code block */}
        <button onClick={() => editor.chain().focus().toggleCodeBlock().run()} title="Bloco de código" className={btn(isActive("codeBlock"))}>
          <svg viewBox="0 0 24 24" className="h-4 w-4 fill-none stroke-current stroke-[1.75]"><path d="M16 18l6-6-6-6M8 6l-6 6 6 6" strokeLinecap="round" strokeLinejoin="round"/></svg>
        </button>

        {/* Divider */}
        <button onClick={() => editor.chain().focus().setHorizontalRule().run()} title="Linha divisória" className="rounded p-1.5 text-slate-500 hover:bg-slate-100">
          <svg viewBox="0 0 24 24" className="h-4 w-4 fill-none stroke-current stroke-[1.75]"><path d="M3 12h18" strokeLinecap="round"/></svg>
        </button>

        <div className="mx-1 h-4 w-px bg-slate-200" />

        {/* AI Magic */}
        <button
          onClick={() => toast.info("AI Magic em breve!")}
          className="flex items-center gap-1.5 rounded-full bg-primary px-3 py-1 text-xs font-semibold text-white shadow-sm shadow-primary/30 hover:bg-primary/90"
        >
          <Zap className="h-3 w-3" /> AI Magic
        </button>

        <div className="flex-1" />

        {/* Char counter */}
        <span className="text-xs text-muted-foreground">{charCount.toLocaleString()} / 50.000</span>
        <button
          onClick={onSave}
          title="Salvar"
          className="ml-1 flex h-6 w-6 items-center justify-center rounded-full bg-primary/10 text-primary hover:bg-primary/20"
        >
          <Play className="h-3.5 w-3.5 fill-current" />
        </button>

        {/* Save status */}
        <span
          className={`ml-2 flex items-center gap-1.5 text-xs font-medium ${
            saveState === "saved" ? "text-emerald-600" : saveState === "saving" ? "text-amber-500" : "text-slate-400"
          }`}
        >
          <span className={`h-2 w-2 rounded-full ${
            saveState === "saved" ? "bg-emerald-500" : saveState === "saving" ? "bg-amber-400 animate-pulse" : "bg-slate-300"
          }`} />
          {saveState === "saved" ? "Salvo" : saveState === "saving" ? "Salvando…" : "Não salvo"}
        </span>

        {/* Autosave */}
        <span className="ml-3 mr-1.5 text-xs text-muted-foreground">Autosave</span>
        <Switch checked={autosave} onCheckedChange={onAutosaveChange} />
      </div>

      {/* Click outside color picker to close */}
      {showColorPicker && (
        <div className="fixed inset-0 z-10" onClick={() => setShowColorPicker(null)} />
      )}

      {/* Editor area */}
      <div className="flex-1 overflow-y-auto">
        <EditorContent editor={editor} />
      </div>
    </div>
  );
}

// =================================================================
// Templates Modal
// =================================================================

type TemplateVariable = {
  key: string;
  label: string;
  placeholder?: string;
  type: "text" | "textarea";
  required: boolean;
  settings_key?: string;
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
  variables?: TemplateVariable[];
};

type TemplateStep =
  | "list"
  | "variables"
  | "detail"
  | "integration-clinicorp"
  | "integration-gcal"
  | "integration-clinup";

const INTEGRATION_LABELS: Record<string, string> = {
  clinicorp: "Clinicorp",
  google_calendar: "Google Calendar",
  clinup: "Clinup",
};

const INTEGRATION_COLORS: Record<string, string> = {
  clinicorp: "bg-teal-100 text-teal-700",
  google_calendar: "bg-blue-100 text-blue-700",
  clinup: "bg-violet-100 text-violet-700",
};

function TemplatesModal({
  accountId,
  onClose,
  onApply,
  agentSettings,
}: {
  accountId: string;
  onClose: () => void;
  onApply: (prompt: string) => void;
  agentSettings: Record<string, string>;
}) {
  const qc = useQueryClient();
  const listFn = useServerFn(listTemplates);
  const saveClinFn = useServerFn(saveClinicorpConfig);
  const testClinFn = useServerFn(testClinicorpConnection);
  const saveClinupFn = useServerFn(saveClinupConfig);
  const testClinupFn = useServerFn(testClinupConnection);
  const getAuthUrlFn = useServerFn(getGoogleAuthUrl);
  const updateAgentFn = useServerFn(updateAgent);

  const [step, setStep] = useState<TemplateStep>("list");
  const [selected, setSelected] = useState<TemplateRow | null>(null);
  const [varValues, setVarValues] = useState<Record<string, string>>({});
  const [search, setSearch] = useState("");
  const [activeCategory, setActiveCategory] = useState("todos");

  const { data, isLoading } = useQuery({
    queryKey: ["templates"],
    queryFn: () => listFn(),
  });

  const templates: TemplateRow[] = (data?.templates ?? []) as TemplateRow[];

  // Categories from data
  const categories = ["todos", ...Array.from(new Set(templates.map((t) => t.categoria)))];

  const filtered = templates.filter((t) => {
    const matchSearch =
      !search ||
      t.nome.toLowerCase().includes(search.toLowerCase()) ||
      t.descricao.toLowerCase().includes(search.toLowerCase());
    const matchCat = activeCategory === "todos" || t.categoria === activeCategory;
    return matchSearch && matchCat;
  });

  function handleSelect(t: TemplateRow) {
    setSelected(t);
    // Pre-fill variable values from agentSettings when settings_key is defined
    const initVals: Record<string, string> = {};
    (t.variables ?? []).forEach((v) => {
      if (v.settings_key && agentSettings[v.settings_key]) {
        initVals[v.key] = agentSettings[v.settings_key];
      } else {
        initVals[v.key] = "";
      }
    });
    setVarValues(initVals);

    const hasVars = (t.variables ?? []).length > 0;
    if (hasVars) {
      setStep("variables");
    } else if (!t.integration_type) {
      setStep("detail");
    } else if (t.integration_type === "clinicorp") {
      setStep("integration-clinicorp");
    } else if (t.integration_type === "google_calendar") {
      setStep("integration-gcal");
    } else if (t.integration_type === "clinup") {
      setStep("integration-clinup");
    } else {
      setStep("detail");
    }
  }

  function applyVariables(prompt: string, values: Record<string, string>): string {
    let result = prompt;
    Object.entries(values).forEach(([key, val]) => {
      if (val.trim()) {
        result = result.replaceAll(`[${key}]`, val.trim());
      }
    });
    return result;
  }

  async function goToIntegrationOrApply() {
    if (!selected) return;
    const prompt = applyVariables(selected.system_prompt, varValues);
    const tempSelected = { ...selected, system_prompt: prompt };
    // Store the resolved prompt in selection
    setSelected(tempSelected);

    // Persist settings_key-linked values to agent profile
    const settingsToSave: Record<string, string> = {};
    (selected.variables ?? []).forEach((v) => {
      if (v.settings_key && varValues[v.key]?.trim()) {
        settingsToSave[v.settings_key] = varValues[v.key].trim();
      }
    });
    if (Object.keys(settingsToSave).length > 0) {
      try {
        const merged = { ...agentSettings, ...settingsToSave };
        await updateAgentFn({ data: { accountId, settings: merged } });
        qc.invalidateQueries({ queryKey: ["agent", accountId] });
      } catch {
        // Non-fatal: settings save failure doesn't block template application
      }
    }

    if (!selected.integration_type) {
      setStep("detail");
    } else if (selected.integration_type === "clinicorp") {
      setStep("integration-clinicorp");
    } else if (selected.integration_type === "google_calendar") {
      setStep("integration-gcal");
    } else if (selected.integration_type === "clinup") {
      setStep("integration-clinup");
    } else {
      onApply(prompt);
    }
  }

  function handleApply() {
    if (selected?.system_prompt) onApply(selected.system_prompt);
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/60 p-4 pt-8 backdrop-blur-sm">
      <div className="w-full max-w-3xl rounded-2xl bg-white shadow-2xl">

        {/* Header */}
        <div className="flex items-center gap-3 border-b px-6 py-4">
          {step !== "list" && (
            <button
              onClick={() => {
                if (step === "variables" || step === "detail") {
                  setStep("list");
                } else if (step.startsWith("integration-")) {
                  // If had variables, go back to variables; otherwise list
                  if ((selected?.variables ?? []).length > 0) setStep("variables");
                  else setStep("list");
                } else {
                  setStep("list");
                }
              }}
              className="flex items-center gap-1 text-sm text-primary hover:text-primary/80"
            >
              ← Templates
            </button>
          )}
          {step === "list" && (
            <>
              <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/10">
                <GraduationCap className="h-4 w-4 text-primary" />
              </div>
              <div className="flex-1">
                <p className="font-semibold">Templates</p>
                <p className="text-xs text-muted-foreground">
                  Use modelos de treinamentos feitos por especialistas para potencializar seu assistente!
                </p>
              </div>
            </>
          )}
          {step !== "list" && selected && (
            <p className="flex-1 font-semibold">{selected.nome}</p>
          )}
          <button onClick={onClose} className="rounded p-1 hover:bg-slate-100">
            <AlertCircle className="h-4 w-4 rotate-45 text-slate-400" />
          </button>
        </div>

        {/* ── STEP: LIST ── */}
        {step === "list" && (
          <div className="p-5">
            {/* Search */}
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Buscar templates…"
              className="w-full rounded-xl border border-slate-200 bg-slate-50 px-4 py-2.5 text-sm outline-none focus:border-primary focus:bg-white"
            />

            {/* Category tabs */}
            <div className="mt-3 flex flex-wrap gap-2">
              {categories.map((cat) => (
                <button
                  key={cat}
                  onClick={() => setActiveCategory(cat)}
                  className={`rounded-full px-3 py-1 text-xs font-medium capitalize transition-colors ${
                    activeCategory === cat
                      ? "bg-primary text-white"
                      : "bg-slate-100 text-slate-600 hover:bg-slate-200"
                  }`}
                >
                  {cat === "todos" ? "⭐ Todos" : cat}
                </button>
              ))}
            </div>

            {/* Grid */}
            {isLoading ? (
              <div className="flex justify-center py-12">
                <Loader2 className="h-6 w-6 animate-spin text-primary" />
              </div>
            ) : filtered.length === 0 ? (
              <p className="py-12 text-center text-sm text-muted-foreground">
                {search ? "Nenhum template encontrado." : "Nenhum template cadastrado ainda."}
              </p>
            ) : (
              <div className="mt-4 grid max-h-[60vh] gap-4 overflow-y-auto pb-2 sm:grid-cols-3">
                {filtered.map((t) => (
                  <button
                    key={t.id}
                    onClick={() => handleSelect(t)}
                    className="group overflow-hidden rounded-xl border border-slate-200 text-left transition-all hover:-translate-y-0.5 hover:shadow-lg"
                  >
                    {/* Cover */}
                    <div
                      className="h-28 w-full bg-gradient-to-br from-primary/30 to-primary/10 bg-cover bg-center"
                      style={t.cover_url ? { backgroundImage: `url(${t.cover_url})` } : {}}
                    />
                    <div className="p-3 space-y-1">
                      <p className="text-sm font-semibold text-primary leading-tight line-clamp-2">
                        {t.nome}
                      </p>
                      <p className="text-xs text-muted-foreground line-clamp-2">{t.descricao}</p>
                      {t.integration_type && (
                        <span
                          className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium ${INTEGRATION_COLORS[t.integration_type] ?? "bg-slate-100 text-slate-600"}`}
                        >
                          <span className="h-1.5 w-1.5 rounded-full bg-current" />
                          {INTEGRATION_LABELS[t.integration_type]}
                        </span>
                      )}
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {/* ── STEP: VARIABLES ── */}
        {step === "variables" && selected && (
          <div className="p-6 space-y-5">
            {/* Template header */}
            <div className="flex items-center gap-3 rounded-xl border bg-slate-50 p-3">
              {selected.cover_url ? (
                <img src={selected.cover_url} alt={selected.nome} className="h-12 w-12 rounded-lg object-cover" />
              ) : (
                <div className="flex h-12 w-12 items-center justify-center rounded-lg bg-primary/10">
                  <GraduationCap className="h-5 w-5 text-primary" />
                </div>
              )}
              <div>
                <p className="font-semibold text-sm">{selected.nome}</p>
                <p className="text-xs text-muted-foreground">{selected.descricao}</p>
              </div>
            </div>

            <div>
              <p className="text-sm font-semibold mb-0.5">Configure seu assistente</p>
              <p className="text-xs text-muted-foreground">
                Preencha as informações abaixo. Campos marcados com{" "}
                <span className="inline-flex items-center gap-0.5 rounded-full bg-emerald-100 px-1.5 text-[10px] font-medium text-emerald-700">✓ perfil</span>{" "}
                foram carregados das suas configurações e serão salvos automaticamente.
              </p>
            </div>

            {/* Two-column grid for variables */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-3">
              {(selected.variables ?? []).map((v) => {
                const prefilled = !!(v.settings_key && agentSettings[v.settings_key]);
                return (
                  <div key={v.key} className={v.type === "textarea" ? "sm:col-span-2" : ""}>
                    <label className="flex items-center gap-1.5 text-xs font-medium text-slate-700 mb-1">
                      {v.label}
                      {v.required && <span className="text-destructive">*</span>}
                      {prefilled && (
                        <span className="ml-auto inline-flex items-center gap-0.5 rounded-full bg-emerald-100 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700">
                          ✓ perfil
                        </span>
                      )}
                    </label>
                    {v.type === "textarea" ? (
                      <textarea
                        rows={3}
                        value={varValues[v.key] ?? ""}
                        onChange={(e) => setVarValues((p) => ({ ...p, [v.key]: e.target.value }))}
                        placeholder={v.placeholder ?? ""}
                        className={`w-full rounded-lg border px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-primary/20 resize-none transition-colors ${
                          prefilled
                            ? "border-emerald-200 bg-emerald-50/40 focus:border-emerald-400"
                            : "border-slate-200 bg-white focus:border-primary"
                        }`}
                      />
                    ) : (
                      <input
                        type="text"
                        value={varValues[v.key] ?? ""}
                        onChange={(e) => setVarValues((p) => ({ ...p, [v.key]: e.target.value }))}
                        placeholder={v.placeholder ?? ""}
                        className={`w-full rounded-lg border px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-primary/20 transition-colors ${
                          prefilled
                            ? "border-emerald-200 bg-emerald-50/40 focus:border-emerald-400"
                            : "border-slate-200 bg-white focus:border-primary"
                        }`}
                      />
                    )}
                  </div>
                );
              })}
            </div>

            {/* Info: values will be saved */}
            {(selected.variables ?? []).some((v) => v.settings_key) && (
              <div className="flex items-start gap-2 rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-xs text-emerald-700">
                <Check className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                Os valores preenchidos serão salvos no seu perfil e carregados automaticamente nos próximos templates.
              </div>
            )}

            <div className="flex gap-3 pt-2">
              <Button
                onClick={() => void goToIntegrationOrApply()}
                disabled={(selected.variables ?? []).filter((v) => v.required).some((v) => !varValues[v.key]?.trim())}
                className="flex-1"
              >
                {selected.integration_type ? "Configurar integração →" : "Aplicar template"}
              </Button>
            </div>
          </div>
        )}

        {/* ── STEP: DETAIL (no integration) ── */}
        {step === "detail" && selected && (
          <div className="p-6 space-y-4">
            {selected.cover_url && (
              <img
                src={selected.cover_url}
                alt={selected.nome}
                className="h-32 w-full rounded-xl object-cover"
              />
            )}
            <p className="text-sm text-muted-foreground">{selected.descricao}</p>
            <div className="rounded-xl border bg-slate-50 p-4">
              <p className="mb-2 text-xs font-semibold uppercase text-muted-foreground">Preview do prompt</p>
              <p className="line-clamp-6 whitespace-pre-wrap text-xs leading-relaxed text-foreground">
                {selected.system_prompt || "(sem prompt)"}
              </p>
            </div>
            <Button onClick={handleApply} className="w-full">
              Aplicar este template
            </Button>
          </div>
        )}

        {/* ── STEP: CLINICORP SETUP ── */}
        {step === "integration-clinicorp" && selected && (
          <TemplateClinicorpSetup
            accountId={accountId}
            saveFn={saveClinFn}
            testFn={testClinFn}
            onSuccess={() => { void (async () => { handleApply(); })(); }}
            onSkip={handleApply}
          />
        )}

        {/* ── STEP: GOOGLE CALENDAR SETUP ── */}
        {step === "integration-gcal" && selected && (
          <TemplateGCalSetup
            accountId={accountId}
            getAuthUrlFn={getAuthUrlFn}
            qc={qc}
            onSuccess={handleApply}
            onSkip={handleApply}
          />
        )}

        {/* ── STEP: CLINUP SETUP ── */}
        {step === "integration-clinup" && selected && (
          <TemplateClinupSetup
            accountId={accountId}
            saveFn={saveClinupFn}
            testFn={testClinupFn}
            onSuccess={handleApply}
            onSkip={handleApply}
          />
        )}
      </div>
    </div>
  );
}

// ── Integration setup panels ──

function TemplateClinicorpSetup({
  accountId,
  saveFn,
  testFn,
  onSuccess,
  onSkip,
}: {
  accountId: string;
  saveFn: ReturnType<typeof useServerFn<typeof saveClinicorpConfig>>;
  testFn: ReturnType<typeof useServerFn<typeof testClinicorpConnection>>;
  onSuccess: () => void;
  onSkip: () => void;
}) {
  const [token, setToken] = useState("");
  const [subscriberId, setSubscriberId] = useState("");
  const [businessId, setBusinessId] = useState("");
  const [agendaId, setAgendaId] = useState("");
  const [duracao, setDuracao] = useState("40");
  const [saving, setSaving] = useState(false);
  const [testResult, setTestResult] = useState<string | null>(null);

  async function handleSave() {
    setSaving(true);
    try {
      await saveFn({
        data: {
          accountId,
          ...(token ? { api_token: token } : {}),
          subscriber_id: subscriberId,
          business_id: businessId ? Number(businessId) : undefined,
          agenda_id: agendaId ? Number(agendaId) : undefined,
          duracao_consulta: Number(duracao),
          ativo: true,
        },
      });
      toast.success("Clinicorp configurado!");
      onSuccess();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Erro ao salvar.");
    } finally {
      setSaving(false);
    }
  }

  async function handleTest() {
    setTestResult(null);
    const r = await testFn({ data: { accountId } });
    setTestResult(r.ok ? "✅ Conexão OK" : `❌ ${r.error}`);
  }

  return (
    <div className="p-6 space-y-4">
      <div className="rounded-xl border border-teal-200 bg-teal-50 p-4">
        <p className="text-sm font-semibold text-teal-800">Este template requer o Clinicorp</p>
        <p className="mt-1 text-xs text-teal-700">
          Preencha as credenciais abaixo para que o agente possa consultar e agendar no Clinicorp.
        </p>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div className="col-span-2">
          <Label className="text-xs">Token API (Basic auth base64)</Label>
          <Input type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder="cole o token aqui" className="mt-1" />
        </div>
        <div>
          <Label className="text-xs">Subscriber ID</Label>
          <Input value={subscriberId} onChange={(e) => setSubscriberId(e.target.value)} className="mt-1" />
        </div>
        <div>
          <Label className="text-xs">Business ID</Label>
          <Input type="number" value={businessId} onChange={(e) => setBusinessId(e.target.value)} className="mt-1" />
        </div>
        <div>
          <Label className="text-xs">Agenda ID</Label>
          <Input type="number" value={agendaId} onChange={(e) => setAgendaId(e.target.value)} className="mt-1" />
        </div>
        <div>
          <Label className="text-xs">Duração (min)</Label>
          <Input type="number" value={duracao} onChange={(e) => setDuracao(e.target.value)} className="mt-1" />
        </div>
      </div>
      {testResult && <p className="text-xs">{testResult}</p>}
      <div className="flex gap-2">
        <Button onClick={handleSave} disabled={saving} className="flex-1 bg-teal-600 hover:bg-teal-700">
          {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          Salvar e aplicar template
        </Button>
        <Button variant="outline" size="sm" onClick={handleTest}>Testar</Button>
      </div>
      <button onClick={onSkip} className="w-full text-center text-xs text-muted-foreground hover:text-foreground">
        Pular configuração e aplicar mesmo assim
      </button>
    </div>
  );
}

function TemplateGCalSetup({
  accountId,
  getAuthUrlFn,
  qc,
  onSuccess,
  onSkip,
}: {
  accountId: string;
  getAuthUrlFn: ReturnType<typeof useServerFn<typeof getGoogleAuthUrl>>;
  qc: ReturnType<typeof useQueryClient>;
  onSuccess: () => void;
  onSkip: () => void;
}) {
  const [connecting, setConnecting] = useState(false);

  async function connect() {
    setConnecting(true);
    try {
      const { url } = await getAuthUrlFn({ data: { accountId } });
      const popup = window.open(url, "gcal-oauth", "width=500,height=650,popup=true");
      if (!popup) { toast.error("Pop-up bloqueado."); return; }
      const check = setInterval(() => {
        if (popup.closed) {
          clearInterval(check);
          setConnecting(false);
          qc.invalidateQueries({ queryKey: ["gcal-status", accountId] });
          onSuccess();
        }
      }, 500);
    } catch {
      toast.error("Erro ao gerar URL de autenticação.");
      setConnecting(false);
    }
  }

  return (
    <div className="p-6 space-y-4">
      <div className="rounded-xl border border-blue-200 bg-blue-50 p-4">
        <p className="text-sm font-semibold text-blue-800">Este template requer o Google Calendar</p>
        <p className="mt-1 text-xs text-blue-700">
          Conecte sua conta Google para que o agente possa verificar disponibilidade e criar agendamentos.
        </p>
      </div>
      <Button onClick={connect} disabled={connecting} className="w-full bg-blue-600 hover:bg-blue-700">
        {connecting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <ExternalLink className="mr-2 h-4 w-4" />}
        Conectar com Google e aplicar template
      </Button>
      <button onClick={onSkip} className="w-full text-center text-xs text-muted-foreground hover:text-foreground">
        Pular configuração e aplicar mesmo assim
      </button>
    </div>
  );
}

function TemplateClinupSetup({
  accountId,
  saveFn,
  testFn,
  onSuccess,
  onSkip,
}: {
  accountId: string;
  saveFn: ReturnType<typeof useServerFn<typeof saveClinupConfig>>;
  testFn: ReturnType<typeof useServerFn<typeof testClinupConnection>>;
  onSuccess: () => void;
  onSkip: () => void;
}) {
  const [token, setToken] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [clinicId, setClinicId] = useState("");
  const [agendaId, setAgendaId] = useState("");
  const [duracao, setDuracao] = useState("40");
  const [saving, setSaving] = useState(false);
  const [testResult, setTestResult] = useState<string | null>(null);

  async function handleSave() {
    setSaving(true);
    try {
      await saveFn({
        data: {
          accountId,
          ...(token ? { api_token: token } : {}),
          base_url: baseUrl || undefined,
          clinic_id: clinicId || undefined,
          agenda_id: agendaId || undefined,
          duracao_consulta: Number(duracao),
          ativo: true,
        },
      });
      toast.success("Clinup configurado!");
      onSuccess();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Erro ao salvar.");
    } finally {
      setSaving(false);
    }
  }

  async function handleTest() {
    setTestResult(null);
    const r = await testFn({ data: { accountId } });
    setTestResult(r.ok ? "✅ Conexão OK" : `❌ ${r.error}`);
  }

  return (
    <div className="p-6 space-y-4">
      <div className="rounded-xl border border-violet-200 bg-violet-50 p-4">
        <p className="text-sm font-semibold text-violet-800">Este template requer o Clinup</p>
        <p className="mt-1 text-xs text-violet-700">
          Configure as credenciais para que o agente possa agendar no Clinup.
        </p>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div className="col-span-2">
          <Label className="text-xs">URL base (ex: https://app.clinup.com.br)</Label>
          <Input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} className="mt-1" />
        </div>
        <div className="col-span-2">
          <Label className="text-xs">Token API</Label>
          <Input type="password" value={token} onChange={(e) => setToken(e.target.value)} className="mt-1" />
        </div>
        <div>
          <Label className="text-xs">Clinic ID</Label>
          <Input value={clinicId} onChange={(e) => setClinicId(e.target.value)} className="mt-1" />
        </div>
        <div>
          <Label className="text-xs">Agenda ID</Label>
          <Input value={agendaId} onChange={(e) => setAgendaId(e.target.value)} className="mt-1" />
        </div>
        <div>
          <Label className="text-xs">Duração (min)</Label>
          <Input type="number" value={duracao} onChange={(e) => setDuracao(e.target.value)} className="mt-1" />
        </div>
      </div>
      {testResult && <p className="text-xs">{testResult}</p>}
      <div className="flex gap-2">
        <Button onClick={handleSave} disabled={saving} className="flex-1 bg-violet-600 hover:bg-violet-700">
          {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          Salvar e aplicar template
        </Button>
        <Button variant="outline" size="sm" onClick={handleTest}>Testar</Button>
      </div>
      <button onClick={onSkip} className="w-full text-center text-xs text-muted-foreground hover:text-foreground">
        Pular configuração e aplicar mesmo assim
      </button>
    </div>
  );
}

// =================================================================
// Sheet: Settings
// =================================================================

// Standard settings fields definition
const SETTINGS_FIELDS: { key: string; label: string; placeholder: string; required?: boolean; type?: "text" | "textarea" }[] = [
  { key: "company_name",       label: "Nome da empresa / clínica",              placeholder: "Ex: Clínica Odontológica Magnum",          required: true  },
  { key: "assistant_name",     label: "Nome do assistente",                     placeholder: "Ex: Joana do bolo, Robô de atendimento, Enzo", required: true },
  { key: "company_type",       label: "O que sua empresa faz?",                 placeholder: "Ex: Clínica de odontologia estética"              },
  { key: "assistant_role",     label: "Função do assistente",                   placeholder: "Ex: Atendente, Atendente Vendedor, Recepcionista" },
  { key: "doctor_name",        label: "Médico / responsável principal",         placeholder: "Ex: Dr. Carlos, Dra. Ana"                         },
  { key: "company_address",    label: "Endereço",                               placeholder: "Ex: Rua das Flores, 123 — Centro, SP"             },
  { key: "business_hours",     label: "Horário de funcionamento",               placeholder: "Ex: Seg–Sex 8h–18h, Sáb 8h–13h"                  },
  { key: "payment_methods",    label: "Formas de pagamento",                    placeholder: "Ex: cartão, PIX, parcelamento em até 18x"         },
  { key: "featured_services",  label: "Serviços / produtos em destaque",        placeholder: "Ex: lentes de contato dental, clareamento"        },
  { key: "notification_phone", label: "Telefone WhatsApp para notificações",    placeholder: "Ex: 5511999999999"                                },
];

function AgentSettingsView({
  accountId,
  agentId,
  agentSettings,
  currentModel,
  currentVoice,
  debounceSegundos,
  hasOpenRouter,
  hasElevenLabs,
  audioHabilitado,
  audioTranscrever,
  audioResponder,
  onClose,
}: {
  accountId: string;
  agentId: string;
  agentSettings: Record<string, string>;
  currentModel: string;
  currentVoice: string | null;
  debounceSegundos: number;
  hasOpenRouter: boolean;
  hasElevenLabs: boolean;
  audioHabilitado: boolean;
  audioTranscrever: boolean;
  audioResponder: boolean;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const updateLlm = useServerFn(updateLlmConfig);
  const updateVoice = useServerFn(updateVoiceConfig);
  const updateAgentFn = useServerFn(updateAgent);
  const listModels = useServerFn(listOpenRouterModels);
  const listVoices = useServerFn(listElevenLabsVoices);

  const [model, setModel] = useState(currentModel);
  const [voiceId, setVoiceId] = useState(currentVoice ?? "");
  const [debounce, setDebounce] = useState(debounceSegundos);
  const [settings, setSettings] = useState<Record<string, string>>(agentSettings);
  const [activeSection, setActiveSection] = useState<"profile" | "ai" | "integrations">("profile");

  const models = useQuery({
    queryKey: ["openrouter-models", accountId],
    queryFn: () => listModels({ data: { accountId } }),
    enabled: hasOpenRouter,
  });
  const voices = useQuery({
    queryKey: ["eleven-voices", accountId],
    queryFn: () => listVoices({ data: { accountId } }),
    enabled: hasElevenLabs,
  });

  const setSetting = (key: string, val: string) =>
    setSettings((p) => ({ ...p, [key]: val }));

  const save = useMutation({
    mutationFn: async () => {
      await updateLlm({ data: { accountId, default_model: model } });
      await updateVoice({ data: { accountId, elevenlabs_voice_id: voiceId || null } });
      await updateAgentFn({ data: { accountId, debounce_segundos: debounce, settings } });
    },
    onSuccess: () => {
      toast.success("Configurações salvas.");
      qc.invalidateQueries({ queryKey: ["agent", accountId] });
      onClose();
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Erro ao salvar."),
  });

  const missingRequired = SETTINGS_FIELDS.filter((f) => f.required && !settings[f.key]?.trim()).length;

  const SECTIONS = [
    { id: "profile" as const, label: "Perfil do assistente", icon: "🏢" },
    { id: "ai" as const, label: "IA, Voz e Debounce", icon: "🤖" },
    { id: "integrations" as const, label: "Integrações", icon: "🔗" },
  ];

  return (
    <div className="flex min-h-screen flex-col bg-slate-50">

      {/* ── Title bar ── */}
      <div className="flex items-center gap-3 border-b border-slate-200 bg-white px-5 py-3">
        <button
          onClick={onClose}
          className="flex items-center gap-1 text-xs font-semibold text-primary hover:text-primary/80"
        >
          ← VOLTAR
        </button>
        <div className="mx-1 h-4 w-px bg-slate-200" />
        <div className="flex items-center gap-2">
          <span className="flex h-7 w-7 items-center justify-center rounded-xl bg-violet-100">
            <Settings className="h-3.5 w-3.5 text-violet-600" />
          </span>
          <span className="text-sm font-semibold text-foreground">Personalizar assistente</span>
        </div>
        {missingRequired > 0 && (
          <span className="ml-2 flex items-center gap-1 rounded-full bg-amber-100 px-2.5 py-1 text-[11px] font-medium text-amber-700">
            <AlertCircle className="h-3 w-3" />
            {missingRequired} campo{missingRequired > 1 ? "s" : ""} obrigatório{missingRequired > 1 ? "s" : ""}
          </span>
        )}
        <div className="flex-1" />
        <button
          onClick={() => save.mutate()}
          disabled={save.isPending}
          className="flex items-center gap-1.5 rounded-full bg-primary px-4 py-1.5 text-xs font-semibold text-white shadow-sm shadow-primary/30 transition-opacity hover:opacity-90 disabled:opacity-60"
        >
          {save.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
          Salvar configurações
        </button>
      </div>

      {/* ── Section tabs ── */}
      <div className="flex items-end gap-0 border-b border-slate-200 bg-white px-4">
        {SECTIONS.map((sec) => (
          <button
            key={sec.id}
            onClick={() => setActiveSection(sec.id)}
            className={`flex items-center gap-2 px-5 py-3 text-xs font-semibold tracking-wide transition-colors ${
              activeSection === sec.id
                ? "border-b-[3px] border-primary text-primary"
                : "border-b-[3px] border-transparent text-muted-foreground hover:text-foreground"
            }`}
          >
            <span>{sec.icon}</span>
            {sec.label}
          </button>
        ))}
      </div>

      {/* ── Content ── */}
      <div className="flex-1 overflow-y-auto">
        {activeSection === "profile" ? (
          <div className="mx-auto max-w-3xl px-6 py-8 space-y-8">

            {/* Info banner */}
            <div className="rounded-xl border border-primary/20 bg-primary/5 px-5 py-3.5">
              <p className="text-xs text-primary/80 leading-relaxed">
                <strong className="text-primary">Dica:</strong> Estas informações são compartilhadas automaticamente com os templates de IA. Quando você aplicar um template, os campos pré-cadastrados aqui serão carregados automaticamente e salvos para as próximas vezes.
              </p>
            </div>

            {/* ── Seção: Empresa ── */}
            <div>
              <div className="mb-4 flex items-center gap-2">
                <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-blue-100 text-sm">🏢</div>
                <div>
                  <p className="text-sm font-semibold">Sobre a empresa</p>
                  <p className="text-xs text-muted-foreground">Informações institucionais da sua empresa ou clínica</p>
                </div>
              </div>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                {["company_name", "company_type", "company_address", "business_hours", "payment_methods", "featured_services"].map((key) => {
                  const f = SETTINGS_FIELDS.find((x) => x.key === key)!;
                  return (
                    <div key={key}>
                      <label className="block text-xs font-semibold text-slate-700 mb-1.5">
                        {f.label}
                        {f.required && <span className="text-destructive ml-0.5">*</span>}
                      </label>
                      <input
                        type="text"
                        value={settings[key] ?? ""}
                        onChange={(e) => setSetting(key, e.target.value)}
                        placeholder={f.placeholder}
                        className={`w-full rounded-xl border bg-white px-4 py-2.5 text-sm outline-none transition-all focus:ring-2 focus:ring-primary/20 focus:border-primary ${
                          f.required && !settings[key]?.trim()
                            ? "border-amber-300 bg-amber-50/50"
                            : "border-slate-200 hover:border-slate-300"
                        }`}
                      />
                    </div>
                  );
                })}
              </div>
            </div>

            <div className="border-t border-slate-200" />

            {/* ── Seção: Assistente ── */}
            <div>
              <div className="mb-4 flex items-center gap-2">
                <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-violet-100 text-sm">🤖</div>
                <div>
                  <p className="text-sm font-semibold">Sobre o assistente</p>
                  <p className="text-xs text-muted-foreground">Como o assistente virtual se apresenta</p>
                </div>
              </div>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                {["assistant_name", "assistant_role", "doctor_name", "notification_phone"].map((key) => {
                  const f = SETTINGS_FIELDS.find((x) => x.key === key)!;
                  return (
                    <div key={key}>
                      <label className="block text-xs font-semibold text-slate-700 mb-1.5">
                        {f.label}
                        {f.required && <span className="text-destructive ml-0.5">*</span>}
                      </label>
                      <input
                        type="text"
                        value={settings[key] ?? ""}
                        onChange={(e) => setSetting(key, e.target.value)}
                        placeholder={f.placeholder}
                        className={`w-full rounded-xl border bg-white px-4 py-2.5 text-sm outline-none transition-all focus:ring-2 focus:ring-primary/20 focus:border-primary ${
                          f.required && !settings[key]?.trim()
                            ? "border-amber-300 bg-amber-50/50"
                            : "border-slate-200 hover:border-slate-300"
                        }`}
                      />
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Save button at bottom */}
            <div className="flex gap-3 pt-4">
              <button
                onClick={onClose}
                className="flex-1 rounded-xl border border-slate-200 bg-white py-3 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-50"
              >
                Cancelar
              </button>
              <button
                onClick={() => save.mutate()}
                disabled={save.isPending}
                className="flex-1 rounded-xl bg-primary py-3 text-sm font-semibold text-white shadow-sm shadow-primary/30 transition-opacity hover:opacity-90 disabled:opacity-60"
              >
                {save.isPending ? "Salvando…" : "Salvar configurações"}
              </button>
            </div>
          </div>
        ) : activeSection === "ai" ? (
          <div className="mx-auto max-w-xl px-6 py-8 space-y-6">
            <div className="rounded-xl border border-slate-200 bg-white p-6 space-y-5">

              {/* Model */}
              <div>
                <Label className="text-sm font-semibold">Modelo de IA (OpenRouter)</Label>
                <p className="mb-2 text-xs text-muted-foreground">Modelo utilizado para processar as conversas.</p>
                {!hasOpenRouter ? (
                  <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-700">
                    Cadastre sua chave OpenRouter em "Conexões e custos" para listar os modelos.
                  </div>
                ) : models.isLoading ? (
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <Loader2 className="h-4 w-4 animate-spin" /> Carregando modelos…
                  </div>
                ) : (
                  <select
                    className="w-full rounded-xl border border-slate-200 bg-background px-4 py-2.5 text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
                    value={model}
                    onChange={(e) => setModel(e.target.value)}
                  >
                    <option value="">— escolher modelo —</option>
                    {(models.data?.models ?? []).map((m) => (
                      <option key={m.id} value={m.id}>{m.name}</option>
                    ))}
                  </select>
                )}
              </div>

              <div className="border-t border-slate-100" />

              {/* Voice */}
              <div>
                <Label className="text-sm font-semibold">Voz do assistente (ElevenLabs)</Label>
                <p className="mb-2 text-xs text-muted-foreground">Voz utilizada quando o modo áudio está ativado.</p>
                {!hasElevenLabs ? (
                  <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-700">
                    Cadastre sua chave ElevenLabs em "Conexões e custos" para escolher uma voz.
                  </div>
                ) : voices.isLoading ? (
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <Loader2 className="h-4 w-4 animate-spin" /> Carregando vozes…
                  </div>
                ) : (
                  <select
                    className="w-full rounded-xl border border-slate-200 bg-background px-4 py-2.5 text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
                    value={voiceId}
                    onChange={(e) => setVoiceId(e.target.value)}
                  >
                    <option value="">— escolher voz —</option>
                    {(voices.data?.voices ?? []).map((v) => (
                      <option key={v.voice_id} value={v.voice_id}>{v.name}</option>
                    ))}
                  </select>
                )}
              </div>

              <div className="border-t border-slate-100" />

              {/* Debounce */}
              <div>
                <Label className="text-sm font-semibold">Debounce (segundos)</Label>
                <p className="mb-2 text-xs text-muted-foreground">
                  Aguarda este tempo antes de processar, agrupando mensagens enviadas em sequência rápida. Use 0 para desativar.
                </p>
                <div className="flex items-center gap-4">
                  <input
                    type="range"
                    min={0}
                    max={120}
                    value={debounce}
                    onChange={(e) => setDebounce(Number(e.target.value))}
                    className="flex-1 accent-primary"
                  />
                  <div className="flex w-16 items-center justify-center rounded-xl border border-slate-200 bg-slate-50 py-1.5 text-sm font-semibold tabular-nums">
                    {debounce}s
                  </div>
                </div>
              </div>
            </div>

            {/* Save button */}
            <div className="flex gap-3">
              <button
                onClick={onClose}
                className="flex-1 rounded-xl border border-slate-200 bg-white py-3 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-50"
              >
                Cancelar
              </button>
              <button
                onClick={() => save.mutate()}
                disabled={save.isPending}
                className="flex-1 rounded-xl bg-primary py-3 text-sm font-semibold text-white shadow-sm shadow-primary/30 transition-opacity hover:opacity-90 disabled:opacity-60"
              >
                {save.isPending ? "Salvando…" : "Salvar configurações"}
              </button>
            </div>
          </div>
        ) : (
          <IntegrationsTab
            accountId={accountId}
            agentId={agentId}
            audioHabilitado={audioHabilitado}
            audioTranscrever={audioTranscrever}
            audioResponder={audioResponder}
          />
        )}
      </div>
    </div>
  );
}

// =================================================================
// Integrations Tab (inside AgentSettingsView)
// =================================================================

function IntegrationsTab({
  accountId,
  agentId: _agentId,
  audioHabilitado,
  audioTranscrever,
  audioResponder,
}: {
  accountId: string;
  agentId: string;
  audioHabilitado: boolean;
  audioTranscrever: boolean;
  audioResponder: boolean;
}) {
  return (
    <div className="mx-auto max-w-2xl px-6 py-8 space-y-4">
      <div className="rounded-xl border border-primary/20 bg-primary/5 px-5 py-3.5">
        <p className="text-xs text-primary/80 leading-relaxed">
          <strong className="text-primary">Dica:</strong> Configure aqui os canais e ferramentas que seu assistente usa. Ative apenas o que seu negócio precisa.
        </p>
      </div>
      <HelenaConfigPanel accountId={accountId} />
      <AudioPanel
        accountId={accountId}
        initialHabilitado={audioHabilitado}
        initialTranscrever={audioTranscrever}
        initialResponder={audioResponder}
      />
      <GoogleCalendarPanel accountId={accountId} />
      <ClinicorpPanel accountId={accountId} />
      <ClinupPanel accountId={accountId} />
    </div>
  );
}

// ── Helena Config Panel ─────────────────────────────────────────────

function HelenaConfigPanel({ accountId }: { accountId: string }) {
  const qc = useQueryClient();
  const getFn = useServerFn(getHelenaConfig);
  const setFn = useServerFn(setHelenaConfig);

  const [open, setOpen] = useState(false);
  const [baseUrl, setBaseUrl] = useState("");
  const [token, setToken] = useState("");
  const [saving, setSaving] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ["helena-config", accountId],
    queryFn: () => getFn({ data: { accountId } }),
  });

  // Pre-fill base_url when data loads
  useEffect(() => {
    if (data?.base_url) setBaseUrl(data.base_url);
  }, [data?.base_url]);

  const configured = !!data?.token_configured;

  async function handleSave() {
    if (!baseUrl && !token) return;
    setSaving(true);
    try {
      const payload: { accountId: string; base_url?: string; token?: string } = { accountId };
      if (baseUrl) payload.base_url = baseUrl;
      if (token) payload.token = token;
      await setFn({ data: payload });
      toast.success("Configuração Helena salva.");
      setToken("");
      qc.invalidateQueries({ queryKey: ["helena-config", accountId] });
      setOpen(false);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Erro ao salvar.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white">
      <button
        className="flex w-full items-center gap-4 px-5 py-4 text-left transition-colors hover:bg-slate-50"
        onClick={() => setOpen(!open)}
      >
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-cyan-500 to-blue-600 text-white shadow-md shadow-cyan-500/30">
          <MessageCircle className="h-5 w-5" />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold text-foreground">Helena CRM</p>
          <p className="text-xs text-muted-foreground">Token de envio de mensagens</p>
        </div>
        <div className="flex items-center gap-2">
          {isLoading ? (
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
          ) : (
            <span className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[10px] font-semibold ${
              configured
                ? "bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200"
                : "bg-amber-50 text-amber-700 ring-1 ring-amber-200"
            }`}>
              <span className={`h-1.5 w-1.5 rounded-full ${configured ? "bg-emerald-500" : "bg-amber-500"}`} />
              {configured ? "Configurado" : "Pendente"}
            </span>
          )}
          <span className={`text-muted-foreground transition-transform ${open ? "rotate-90" : ""}`}>›</span>
        </div>
      </button>

      {open && (
        <div className="border-t border-slate-100 px-5 py-4 space-y-4">
          {!configured && (
            <div className="rounded-xl border border-amber-200 bg-amber-50 p-3">
              <p className="text-xs font-semibold text-amber-800">⚠ Token não configurado</p>
              <p className="mt-0.5 text-xs text-amber-700">
                Sem o token Helena o agente não consegue enviar respostas. Insira o Bearer token da API Helena abaixo.
              </p>
            </div>
          )}
          <div>
            <Label className="text-xs font-semibold">URL base da API</Label>
            <p className="mb-1 text-[11px] text-muted-foreground">Ex: https://api.crmmentoriae7.com.br</p>
            <Input
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder="https://api.crmmentoriae7.com.br"
              className="mt-1"
            />
          </div>
          <div>
            <Label className="text-xs font-semibold">Bearer Token (API Helena)</Label>
            <p className="mb-1 text-[11px] text-muted-foreground">
              {configured ? "Token já salvo — preencha apenas para alterar" : "Cole aqui o token da sua conta Helena"}
            </p>
            <Input
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder={configured ? "••••••••• (manter atual)" : "Cole o token aqui"}
              className="mt-1"
            />
          </div>
          <Button
            onClick={handleSave}
            disabled={saving || (!baseUrl && !token)}
            className="w-full bg-cyan-600 hover:bg-cyan-700"
          >
            {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Salvar configuração Helena
          </Button>
        </div>
      )}
    </div>
  );
}

// ── Audio Panel ─────────────────────────────────────────────────────

function AudioPanel({
  accountId,
  initialHabilitado,
  initialTranscrever,
  initialResponder,
}: {
  accountId: string;
  initialHabilitado: boolean;
  initialTranscrever: boolean;
  initialResponder: boolean;
}) {
  const qc = useQueryClient();
  const update = useServerFn(updateAudio);
  const [expanded, setExpanded] = useState(initialHabilitado);
  const [h, setH] = useState(initialHabilitado);
  const [t, setT] = useState(initialTranscrever);
  const [r, setR] = useState(initialResponder);

  const m = useMutation({
    mutationFn: () => update({ data: { accountId, habilitado: h, transcrever_in: t, responder_out: r } }),
    onSuccess: () => {
      toast.success("Áudio atualizado.");
      qc.invalidateQueries({ queryKey: ["agent", accountId] });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Erro ao salvar."),
  });

  return (
    <div className="rounded-2xl border border-slate-200 bg-white overflow-hidden shadow-sm">
      <button onClick={() => setExpanded(!expanded)} className="flex w-full items-center gap-3 p-5 text-left">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-sky-400 to-blue-600 text-white shadow-sm shadow-blue-500/30">
          <Headphones className="h-5 w-5" />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold">Áudio</p>
          <p className="text-xs text-muted-foreground">Transcrição de voz e respostas em áudio</p>
        </div>
        <span className={`mr-2 inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[10px] font-semibold ${h ? "bg-emerald-100 text-emerald-700" : "bg-zinc-100 text-zinc-500"}`}>
          <span className={`h-1.5 w-1.5 rounded-full ${h ? "bg-emerald-500" : "bg-zinc-400"}`} />
          {h ? "Ativo" : "Inativo"}
        </span>
        <svg className={`h-4 w-4 shrink-0 text-muted-foreground transition-transform ${expanded ? "rotate-180" : ""}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="m6 9 6 6 6-6"/></svg>
      </button>
      {expanded && (
        <div className="border-t border-slate-100 px-5 pb-5 pt-4 space-y-3">
          <ToggleRow label="Habilitado" value={h} onChange={setH} />
          <ToggleRow label="Transcrever áudios recebidos (Groq Whisper)" value={t} onChange={setT} disabled={!h} />
          <ToggleRow label="Responder com voz (ElevenLabs TTS)" value={r} onChange={setR} disabled={!h} />
          <Button onClick={() => m.mutate()} disabled={m.isPending} className="w-full">
            {m.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Salvar
          </Button>
        </div>
      )}
    </div>
  );
}

// ── Google Calendar Panel ───────────────────────────────────────────

function GoogleCalendarPanel({ accountId }: { accountId: string }) {
  const qc = useQueryClient();
  const getStatus = useServerFn(getGoogleCalendarStatusFn);
  const getAuthUrl = useServerFn(getGoogleAuthUrl);
  const disconnect = useServerFn(disconnectGoogleCalendar);

  const { data } = useQuery({
    queryKey: ["gcal-status", accountId],
    queryFn: () => getStatus({ data: { accountId } }),
  });

  const [expanded, setExpanded] = useState(false);
  const [connecting, setConnecting] = useState(false);

  async function connect() {
    setConnecting(true);
    try {
      const { url } = await getAuthUrl({ data: { accountId } });
      const popup = window.open(url, "gcal-oauth", "width=500,height=650,popup=true");
      if (!popup) { toast.error("Pop-up bloqueado."); return; }
      const check = setInterval(() => {
        if (popup.closed) {
          clearInterval(check);
          setConnecting(false);
          qc.invalidateQueries({ queryKey: ["gcal-status", accountId] });
        }
      }, 500);
    } catch {
      toast.error("Erro ao gerar URL de autenticação.");
      setConnecting(false);
    }
  }

  const disconnectM = useMutation({
    mutationFn: () => disconnect({ data: { accountId } }),
    onSuccess: () => {
      toast.success("Google Calendar desconectado.");
      qc.invalidateQueries({ queryKey: ["gcal-status", accountId] });
    },
  });

  return (
    <div className="rounded-2xl border border-slate-200 bg-white overflow-hidden shadow-sm">
      <button onClick={() => setExpanded(!expanded)} className="flex w-full items-center gap-3 p-5 text-left">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-blue-400 to-indigo-600 text-white shadow-sm shadow-blue-500/30">
          <Calendar className="h-5 w-5" />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold">Google Calendar</p>
          <p className="text-xs text-muted-foreground">Agendamentos via Google</p>
        </div>
        <span className={`mr-2 inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[10px] font-semibold ${data?.connected ? "bg-emerald-100 text-emerald-700" : "bg-zinc-100 text-zinc-500"}`}>
          <span className={`h-1.5 w-1.5 rounded-full ${data?.connected ? "bg-emerald-500" : "bg-zinc-400"}`} />
          {data?.connected ? "Conectado" : "Desconectado"}
        </span>
        <svg className={`h-4 w-4 shrink-0 text-muted-foreground transition-transform ${expanded ? "rotate-180" : ""}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="m6 9 6 6 6-6"/></svg>
      </button>
      {expanded && (
        <div className="border-t border-slate-100 px-5 pb-5 pt-4 space-y-3">
          {data?.connected ? (
            <>
              <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-3">
                <div className="flex items-center gap-2">
                  <Check className="h-4 w-4 text-emerald-600" />
                  <p className="text-sm font-medium text-emerald-800">Conectado</p>
                </div>
                {data.email && <p className="mt-1 text-xs text-muted-foreground">Conta: {data.email}</p>}
                {data.calendarName && <p className="text-xs text-muted-foreground">Calendário: {data.calendarName}</p>}
              </div>
              <Button variant="outline" className="w-full" onClick={() => disconnectM.mutate()} disabled={disconnectM.isPending}>
                {disconnectM.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Desconectar Google Calendar
              </Button>
            </>
          ) : (
            <>
              <p className="text-xs text-muted-foreground">Conecte sua conta Google para que o agente possa verificar disponibilidade e criar agendamentos.</p>
              <Button onClick={connect} disabled={connecting} className="w-full">
                {connecting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <ExternalLink className="mr-2 h-4 w-4" />}
                Conectar com Google
              </Button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ── Clinicorp Panel ─────────────────────────────────────────────────

function ClinicorpPanel({ accountId }: { accountId: string }) {
  const qc = useQueryClient();
  const getCfg = useServerFn(getClinicorpConfig);
  const saveCfg = useServerFn(saveClinicorpConfig);
  const testConn = useServerFn(testClinicorpConnection);
  const listProfs = useServerFn(listClinicorpProfessionalsFn);

  const { data } = useQuery({
    queryKey: ["clinicorp-config", accountId],
    queryFn: () => getCfg({ data: { accountId } }),
  });

  const [expanded, setExpanded] = useState(false);
  const [token, setToken] = useState("");
  const [subscriberId, setSubscriberId] = useState("");
  const [businessId, setBusinessId] = useState("");
  const [profissionalId, setProfissionalId] = useState<string>("");
  const [ativo, setAtivo] = useState(false);
  const [testResult, setTestResult] = useState<string | null>(null);
  const [professionals, setProfessionals] = useState<{ id: number; name: string }[]>([]);
  const [loadingProfs, setLoadingProfs] = useState(false);

  useEffect(() => {
    if (data) {
      setSubscriberId(data.subscriber_id ?? "");
      setBusinessId(data.business_id ? String(data.business_id) : "");
      setProfissionalId(data.profissional_id ? String(data.profissional_id) : "");
      setAtivo(data.ativo ?? false);
    }
  }, [data]);

  // Carrega profissionais quando as credenciais básicas estão preenchidas e a config já existe
  useEffect(() => {
    if (!data?.token_configured) return;
    if (!subscriberId || !businessId) return;
    setLoadingProfs(true);
    listProfs({ data: { accountId } })
      .then((r) => { if (r.ok) setProfessionals(r.professionals); })
      .finally(() => setLoadingProfs(false));
  }, [data?.token_configured, subscriberId, businessId, accountId]);

  const save = useMutation({
    mutationFn: () =>
      saveCfg({
        data: {
          accountId,
          ...(token ? { api_token: token } : {}),
          subscriber_id: subscriberId || undefined,
          business_id: businessId ? Number(businessId) : undefined,
          profissional_id: profissionalId ? Number(profissionalId) : null,
          ativo,
        },
      }),
    onSuccess: () => {
      toast.success("Clinicorp salvo.");
      setToken("");
      qc.invalidateQueries({ queryKey: ["clinicorp-config", accountId] });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Erro ao salvar."),
  });

  async function doTest() {
    setTestResult(null);
    const r = await testConn({ data: { accountId } });
    setTestResult(r.ok ? "✅ Conexão OK" : `❌ ${r.error}`);
  }

  async function doLoadProfs() {
    setLoadingProfs(true);
    setProfessionals([]);
    const r = await listProfs({ data: { accountId } });
    if (r.ok) setProfessionals(r.professionals);
    else toast.error(r.error ?? "Erro ao carregar profissionais.");
    setLoadingProfs(false);
  }

  return (
    <div className="rounded-2xl border border-slate-200 bg-white overflow-hidden shadow-sm">
      <button onClick={() => setExpanded(!expanded)} className="flex w-full items-center gap-3 p-5 text-left">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-teal-400 to-cyan-600 text-white shadow-sm shadow-teal-500/30">
          <Stethoscope className="h-5 w-5" />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold">Clinicorp</p>
          <p className="text-xs text-muted-foreground">Consultar e agendar no Clinicorp</p>
        </div>
        <span className={`mr-2 inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[10px] font-semibold ${data?.ativo ? "bg-emerald-100 text-emerald-700" : "bg-zinc-100 text-zinc-500"}`}>
          <span className={`h-1.5 w-1.5 rounded-full ${data?.ativo ? "bg-emerald-500" : "bg-zinc-400"}`} />
          {data?.ativo ? "Ativo" : "Inativo"}
        </span>
        <svg className={`h-4 w-4 shrink-0 text-muted-foreground transition-transform ${expanded ? "rotate-180" : ""}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="m6 9 6 6 6-6"/></svg>
      </button>
      {expanded && (
        <div className="border-t border-slate-100 px-5 pb-5 pt-4 space-y-3">
          <ToggleRow label="Ativar integração Clinicorp" value={ativo} onChange={setAtivo} />
          <div>
            <Label className="text-xs font-semibold">Token API (Basic auth base64)</Label>
            {data?.token_configured && !token && (
              <p className="text-xs text-muted-foreground mb-1">Token configurado ✓</p>
            )}
            <Input
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="cole o token Basic auth aqui"
              className="mt-1"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label className="text-xs font-semibold">Subscriber ID</Label>
              <Input value={subscriberId} onChange={(e) => setSubscriberId(e.target.value)} className="mt-1" />
            </div>
            <div>
              <Label className="text-xs font-semibold">Business ID</Label>
              <Input type="number" value={businessId} onChange={(e) => setBusinessId(e.target.value)} className="mt-1" />
            </div>
          </div>

          {/* Profissional — opcional */}
          <div>
            <div className="flex items-center justify-between mb-1">
              <Label className="text-xs font-semibold">Profissional <span className="font-normal text-muted-foreground">(opcional)</span></Label>
              {data?.token_configured && (
                <button
                  type="button"
                  onClick={doLoadProfs}
                  disabled={loadingProfs}
                  className="text-[10px] text-blue-600 hover:underline disabled:opacity-50"
                >
                  {loadingProfs ? "Carregando..." : "↻ Recarregar"}
                </button>
              )}
            </div>
            <select
              value={profissionalId}
              onChange={(e) => setProfissionalId(e.target.value)}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus:outline-none focus:ring-2 focus:ring-ring"
            >
              <option value="">— Qualquer profissional —</option>
              {professionals.map((p) => (
                <option key={p.id} value={String(p.id)}>
                  {p.name}
                </option>
              ))}
              {/* mantém o ID salvo caso a lista ainda não tenha carregado */}
              {profissionalId && !professionals.find((p) => String(p.id) === profissionalId) && (
                <option value={profissionalId}>ID {profissionalId}</option>
              )}
            </select>
            {!data?.token_configured && (
              <p className="text-[10px] text-muted-foreground mt-1">
                Salve o token primeiro para carregar a lista de profissionais.
              </p>
            )}
          </div>

          {testResult && <p className="text-xs">{testResult}</p>}
          <div className="flex gap-2">
            <Button onClick={() => save.mutate()} disabled={save.isPending} className="flex-1">
              {save.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Salvar
            </Button>
            <Button variant="outline" onClick={doTest}>Testar</Button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Clinup Panel ────────────────────────────────────────────────────

function ClinupPanel({ accountId }: { accountId: string }) {
  const qc = useQueryClient();
  const getCfg = useServerFn(getClinupConfig);
  const saveCfg = useServerFn(saveClinupConfig);
  const testConn = useServerFn(testClinupConnection);

  const { data } = useQuery({
    queryKey: ["clinup-config", accountId],
    queryFn: () => getCfg({ data: { accountId } }),
  });

  const [expanded, setExpanded] = useState(false);
  const [token, setToken] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [clinicId, setClinicId] = useState("");
  const [agendaId, setAgendaId] = useState("");
  const [duracao, setDuracao] = useState("40");
  const [ativo, setAtivo] = useState(false);
  const [testResult, setTestResult] = useState<string | null>(null);

  useEffect(() => {
    if (data) {
      setBaseUrl(data.base_url ?? "");
      setClinicId(data.clinic_id ?? "");
      setAgendaId(data.agenda_id ?? "");
      setDuracao(String(data.duracao_consulta ?? 40));
      setAtivo(data.ativo ?? false);
    }
  }, [data]);

  const save = useMutation({
    mutationFn: () =>
      saveCfg({ data: { accountId, ...(token ? { api_token: token } : {}), base_url: baseUrl || undefined, clinic_id: clinicId || undefined, agenda_id: agendaId || undefined, duracao_consulta: Number(duracao), ativo } }),
    onSuccess: () => {
      toast.success("Clinup salvo.");
      setToken("");
      qc.invalidateQueries({ queryKey: ["clinup-config", accountId] });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Erro ao salvar."),
  });

  async function doTest() {
    setTestResult(null);
    const r = await testConn({ data: { accountId } });
    setTestResult(r.ok ? "✅ Conexão OK" : `❌ ${r.error}`);
  }

  return (
    <div className="rounded-2xl border border-slate-200 bg-white overflow-hidden shadow-sm">
      <button onClick={() => setExpanded(!expanded)} className="flex w-full items-center gap-3 p-5 text-left">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-violet-400 to-purple-600 text-white shadow-sm shadow-violet-500/30">
          <ClipboardList className="h-5 w-5" />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold">Clinup</p>
          <p className="text-xs text-muted-foreground">Consultar e agendar no Clinup</p>
        </div>
        <span className={`mr-2 inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[10px] font-semibold ${data?.ativo ? "bg-emerald-100 text-emerald-700" : "bg-zinc-100 text-zinc-500"}`}>
          <span className={`h-1.5 w-1.5 rounded-full ${data?.ativo ? "bg-emerald-500" : "bg-zinc-400"}`} />
          {data?.ativo ? "Ativo" : "Inativo"}
        </span>
        <svg className={`h-4 w-4 shrink-0 text-muted-foreground transition-transform ${expanded ? "rotate-180" : ""}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="m6 9 6 6 6-6"/></svg>
      </button>
      {expanded && (
        <div className="border-t border-slate-100 px-5 pb-5 pt-4 space-y-3">
          <ToggleRow label="Ativar integração Clinup" value={ativo} onChange={setAtivo} />
          <div>
            <Label className="text-xs font-semibold">URL base da instância Clinup</Label>
            <Input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://app.clinup.com.br" className="mt-1" />
          </div>
          <div>
            <Label className="text-xs font-semibold">Token API</Label>
            {data?.token_last4 && !token && <p className="text-xs text-muted-foreground mb-1">Atual: ••••{data.token_last4}</p>}
            <Input type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder="cole o token aqui" className="mt-1" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label className="text-xs font-semibold">Clinic ID</Label>
              <Input value={clinicId} onChange={(e) => setClinicId(e.target.value)} className="mt-1" />
            </div>
            <div>
              <Label className="text-xs font-semibold">Agenda ID</Label>
              <Input value={agendaId} onChange={(e) => setAgendaId(e.target.value)} className="mt-1" />
            </div>
            <div>
              <Label className="text-xs font-semibold">Duração (min)</Label>
              <Input type="number" min={5} max={480} value={duracao} onChange={(e) => setDuracao(e.target.value)} className="mt-1" />
            </div>
          </div>
          {testResult && <p className="text-xs">{testResult}</p>}
          <div className="flex gap-2">
            <Button onClick={() => save.mutate()} disabled={save.isPending} className="flex-1">
              {save.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Salvar
            </Button>
            <Button variant="outline" onClick={doTest}>Testar</Button>
          </div>
        </div>
      )}
    </div>
  );
}

// =================================================================
// Sheet: Secrets
// =================================================================

function SecretsSheet({
  open,
  onClose,
  accountId,
  last4,
}: {
  open: boolean;
  onClose: () => void;
  accountId: string;
  last4: { openrouter: string | null; elevenlabs: string | null; groq: string | null };
}) {
  const qc = useQueryClient();
  const setOR = useServerFn(setOpenRouterKey);
  const setEL = useServerFn(setElevenLabsKey);
  const setGroq = useServerFn(setGroqKey);
  const test = useServerFn(testOpenRouterKey);
  const usage = useServerFn(getUsageSummary);

  const [orKey, setOrKey] = useState("");
  const [elKey, setElKey] = useState("");
  const [grKey, setGrKey] = useState("");
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<string | null>(null);

  const usageQuery = useQuery({
    queryKey: ["usage", accountId],
    queryFn: () => usage({ data: { accountId } }),
    enabled: open,
  });

  const totalUsd = (usageQuery.data?.rows ?? []).reduce(
    (s: number, r: { cost_usd?: unknown }) => s + Number(r.cost_usd ?? 0),
    0,
  );

  async function saveKey(key: string, fn: (d: { data: { accountId: string; apiKey: string } }) => Promise<unknown>, label: string, clear: () => void) {
    if (!key) return;
    await fn({ data: { accountId, apiKey: key } });
    toast.success(`Chave ${label} salva.`);
    clear();
    qc.invalidateQueries({ queryKey: ["agent", accountId] });
  }

  async function doTest() {
    setTesting(true);
    setTestResult(null);
    try {
      const r = await test({ data: { accountId } });
      setTestResult(r.ok ? `✅ OK${r.label ? ` · ${r.label}` : ""} · $${(r.usage ?? 0).toFixed(4)}` : `❌ ${r.error}`);
    } finally {
      setTesting(false);
    }
  }

  return (
    <Sheet open={open} onOpenChange={(v) => !v && onClose()}>
      <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-xl">
        <SheetHeader>
          <SheetTitle>Conexões e custos</SheetTitle>
        </SheetHeader>
        <div className="space-y-5 py-4">
          <KeyBlock
            label="OpenRouter"
            help={<a className="text-primary underline" href="https://openrouter.ai/keys" target="_blank" rel="noreferrer">openrouter.ai/keys</a>}
            current={last4.openrouter}
            value={orKey}
            onChange={setOrKey}
            onSave={() => saveKey(orKey, setOR, "OpenRouter", () => setOrKey(""))}
            extra={last4.openrouter ? (
              <Button variant="outline" size="sm" onClick={doTest} disabled={testing}>
                {testing ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : <Check className="mr-1 h-3 w-3" />}
                Testar
              </Button>
            ) : null}
            note={testResult}
          />
          <KeyBlock
            label="ElevenLabs"
            help={<a className="text-primary underline" href="https://elevenlabs.io/app/settings/api-keys" target="_blank" rel="noreferrer">elevenlabs.io/app/settings/api-keys</a>}
            current={last4.elevenlabs}
            value={elKey}
            onChange={setElKey}
            onSave={() => saveKey(elKey, setEL, "ElevenLabs", () => setElKey(""))}
          />
          <KeyBlock
            label="Groq (transcrição de áudio)"
            help={<a className="text-primary underline" href="https://console.groq.com/keys" target="_blank" rel="noreferrer">console.groq.com/keys</a>}
            current={last4.groq}
            value={grKey}
            onChange={setGrKey}
            onSave={() => saveKey(grKey, setGroq, "Groq", () => setGrKey(""))}
          />
          <div className="rounded-md border p-3">
            <p className="text-xs uppercase text-muted-foreground">Custo estimado (30 dias)</p>
            <p className="mt-1 text-2xl font-semibold">${totalUsd.toFixed(4)}</p>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}

// =================================================================
// Full-screen: Follow-up View
// =================================================================

function FollowupView({ agentId, onClose }: { agentId: string; onClose: () => void }) {
  const qc = useQueryClient();
  const getCfg = useServerFn(getFollowupConfig);
  const saveCfg = useServerFn(saveFollowupConfig);

  const { data, isLoading } = useQuery({
    queryKey: ["followup-config", agentId],
    queryFn: () => getCfg({ data: { agentId } }),
  });

  const [ativo, setAtivo] = useState(false);
  const [maxTent, setMaxTent] = useState("2");
  const [delay1, setDelay1] = useState("1");
  const [delay2, setDelay2] = useState("5");
  const [prompt1, setPrompt1] = useState("");
  const [prompt2, setPrompt2] = useState("");

  useEffect(() => {
    if (data) {
      setAtivo(data.ativo ?? false);
      setMaxTent(String(data.max_tentativas ?? 2));
      const delays = data.delay_horas ?? [1, 5];
      setDelay1(String(delays[0] ?? 1));
      setDelay2(String(delays[1] ?? 5));
      setPrompt1(data.prompt_fu1 ?? "");
      setPrompt2(data.prompt_fu2 ?? "");
    }
  }, [data]);

  const save = useMutation({
    mutationFn: () =>
      saveCfg({
        data: {
          agentId,
          ativo,
          max_tentativas: Number(maxTent),
          delay_horas: [Number(delay1), Number(delay2)],
          prompt_fu1: prompt1,
          prompt_fu2: prompt2,
        },
      }),
    onSuccess: () => {
      toast.success("Follow-up salvo.");
      qc.invalidateQueries({ queryKey: ["followup-config", agentId] });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Erro ao salvar."),
  });

  return (
    <div className="flex min-h-screen flex-col bg-slate-50">
      {/* Title bar */}
      <div className="flex items-center gap-3 border-b border-slate-200 bg-white px-5 py-3">
        <button onClick={onClose} className="flex items-center gap-1 text-xs font-semibold text-primary hover:text-primary/80">
          ← VOLTAR
        </button>
        <div className="mx-1 h-4 w-px bg-slate-200" />
        <div className="flex items-center gap-2">
          <span className="flex h-7 w-7 items-center justify-center rounded-xl bg-orange-100">
            <Bell className="h-3.5 w-3.5 text-orange-600" />
          </span>
          <span className="text-sm font-semibold text-foreground">Follow-up automático</span>
        </div>
        <div className="flex-1" />
        <button
          onClick={() => save.mutate()}
          disabled={save.isPending}
          className="flex items-center gap-1.5 rounded-full bg-primary px-4 py-1.5 text-xs font-semibold text-white shadow-sm shadow-primary/30 transition-opacity hover:opacity-90 disabled:opacity-60"
        >
          {save.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
          Salvar
        </button>
      </div>

      {isLoading ? (
        <div className="flex flex-1 items-center justify-center">
          <Loader2 className="h-6 w-6 animate-spin text-primary" />
        </div>
      ) : (
        <div className="mx-auto w-full max-w-2xl px-6 py-8 space-y-5">
          {/* Info banner */}
          <div className="rounded-xl border border-orange-200 bg-orange-50 p-4">
            <p className="text-sm font-semibold text-orange-800">Reengajamento automático</p>
            <p className="mt-1 text-xs text-orange-700">
              Envia mensagens automáticas para leads que não responderam após um determinado tempo. Recupere oportunidades perdidas sem esforço manual.
            </p>
          </div>

          {/* Toggle */}
          <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
            <ToggleRow label="Ativar follow-up automático" value={ativo} onChange={setAtivo} />
          </div>

          {/* Timings */}
          <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm space-y-4">
            <p className="text-sm font-semibold text-foreground">Configurações de tempo</p>
            <div className="grid grid-cols-3 gap-4">
              <div>
                <Label className="text-xs font-semibold text-slate-700">Máx. tentativas</Label>
                <Input type="number" min={1} max={5} value={maxTent} onChange={(e) => setMaxTent(e.target.value)} className="mt-1.5" />
              </div>
              <div>
                <Label className="text-xs font-semibold text-slate-700">Delay FU1 (horas)</Label>
                <Input type="number" min={0} value={delay1} onChange={(e) => setDelay1(e.target.value)} className="mt-1.5" />
              </div>
              <div>
                <Label className="text-xs font-semibold text-slate-700">Delay FU2 (horas)</Label>
                <Input type="number" min={0} value={delay2} onChange={(e) => setDelay2(e.target.value)} className="mt-1.5" />
              </div>
            </div>
          </div>

          {/* Messages */}
          <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm space-y-4">
            <p className="text-sm font-semibold text-foreground">Mensagens de follow-up</p>
            <div>
              <Label className="text-xs font-semibold text-slate-700">Mensagem FU1</Label>
              <p className="mb-1.5 text-[11px] text-muted-foreground">Enviada após {delay1}h sem resposta</p>
              <Textarea rows={4} value={prompt1} onChange={(e) => setPrompt1(e.target.value)} placeholder="Oi! Tudo bem? Vi que você se interessou em nossos serviços..." className="resize-none" />
            </div>
            <div>
              <Label className="text-xs font-semibold text-slate-700">Mensagem FU2</Label>
              <p className="mb-1.5 text-[11px] text-muted-foreground">Enviada após {delay2}h sem resposta</p>
              <Textarea rows={4} value={prompt2} onChange={(e) => setPrompt2(e.target.value)} placeholder="Olá! Ainda posso ajudar com mais informações ou agendamento..." className="resize-none" />
            </div>
          </div>

          <Button onClick={() => save.mutate()} disabled={save.isPending} className="w-full py-3">
            {save.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Salvar configurações
          </Button>
        </div>
      )}
    </div>
  );
}

// =================================================================
// Full-screen: Warm-up View
// =================================================================

function WarmupView({ agentId, onClose }: { agentId: string; onClose: () => void }) {
  const qc = useQueryClient();
  const getCfg = useServerFn(getWarmupConfig);
  const saveCfg = useServerFn(saveWarmupConfig);

  const { data, isLoading } = useQuery({
    queryKey: ["warmup-config", agentId],
    queryFn: () => getCfg({ data: { agentId } }),
  });

  const [ativo, setAtivo] = useState(false);
  const [wu, setWu] = useState({ h1: "96", h2: "72", h3: "48", h4: "24", h5: "2" });
  const [prompts, setPrompts] = useState({ p1: "", p2: "", p3: "", p4: "", p5: "" });

  useEffect(() => {
    if (data) {
      setAtivo(data.ativo ?? false);
      setWu({
        h1: String(data.tempo_wu1_h ?? 96),
        h2: String(data.tempo_wu2_h ?? 72),
        h3: String(data.tempo_wu3_h ?? 48),
        h4: String(data.tempo_wu4_h ?? 24),
        h5: String(data.tempo_wu5_h ?? 2),
      });
      setPrompts({
        p1: data.prompt_wu1 ?? "",
        p2: data.prompt_wu2 ?? "",
        p3: data.prompt_wu3 ?? "",
        p4: data.prompt_wu4 ?? "",
        p5: data.prompt_wu5 ?? "",
      });
    }
  }, [data]);

  const save = useMutation({
    mutationFn: () =>
      saveCfg({
        data: {
          agentId,
          ativo,
          tempo_wu1_h: Number(wu.h1),
          tempo_wu2_h: Number(wu.h2),
          tempo_wu3_h: Number(wu.h3),
          tempo_wu4_h: Number(wu.h4),
          tempo_wu5_h: Number(wu.h5),
          prompt_wu1: prompts.p1,
          prompt_wu2: prompts.p2,
          prompt_wu3: prompts.p3,
          prompt_wu4: prompts.p4,
          prompt_wu5: prompts.p5,
        },
      }),
    onSuccess: () => {
      toast.success("Warm-up salvo.");
      qc.invalidateQueries({ queryKey: ["warmup-config", agentId] });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Erro ao salvar."),
  });

  const wuLevels = [
    { key: "1" as const, hKey: "h1" as const, pKey: "p1" as const },
    { key: "2" as const, hKey: "h2" as const, pKey: "p2" as const },
    { key: "3" as const, hKey: "h3" as const, pKey: "p3" as const },
    { key: "4" as const, hKey: "h4" as const, pKey: "p4" as const },
    { key: "5" as const, hKey: "h5" as const, pKey: "p5" as const },
  ];

  return (
    <div className="flex min-h-screen flex-col bg-slate-50">
      {/* Title bar */}
      <div className="flex items-center gap-3 border-b border-slate-200 bg-white px-5 py-3">
        <button onClick={onClose} className="flex items-center gap-1 text-xs font-semibold text-primary hover:text-primary/80">
          ← VOLTAR
        </button>
        <div className="mx-1 h-4 w-px bg-slate-200" />
        <div className="flex items-center gap-2">
          <span className="flex h-7 w-7 items-center justify-center rounded-xl bg-rose-100">
            <Flame className="h-3.5 w-3.5 text-rose-600" />
          </span>
          <span className="text-sm font-semibold text-foreground">Warm-up de consultas</span>
        </div>
        <div className="flex-1" />
        <button
          onClick={() => save.mutate()}
          disabled={save.isPending}
          className="flex items-center gap-1.5 rounded-full bg-primary px-4 py-1.5 text-xs font-semibold text-white shadow-sm shadow-primary/30 transition-opacity hover:opacity-90 disabled:opacity-60"
        >
          {save.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
          Salvar
        </button>
      </div>

      {isLoading ? (
        <div className="flex flex-1 items-center justify-center">
          <Loader2 className="h-6 w-6 animate-spin text-primary" />
        </div>
      ) : (
        <div className="mx-auto w-full max-w-2xl px-6 py-8 space-y-5">
          {/* Info banner */}
          <div className="rounded-xl border border-rose-200 bg-rose-50 p-4">
            <p className="text-sm font-semibold text-rose-800">Mensagens pré-consulta</p>
            <p className="mt-1 text-xs text-rose-700">
              Envia mensagens automáticas antes de consultas agendadas no Clinicorp. Use{" "}
              <code className="rounded bg-rose-100 px-1">{"{{nome}}"}</code>,{" "}
              <code className="rounded bg-rose-100 px-1">{"{{data_consulta}}"}</code> e{" "}
              <code className="rounded bg-rose-100 px-1">{"{{hora_consulta}}"}</code> nos templates.
            </p>
          </div>

          {/* Toggle */}
          <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
            <ToggleRow label="Ativar warm-up automático" value={ativo} onChange={setAtivo} />
          </div>

          {/* WU levels */}
          <div className="space-y-3">
            {wuLevels.map((l) => (
              <div key={l.key} className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm space-y-3">
                <div className="flex items-center gap-3">
                  <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-rose-100 text-xs font-bold text-rose-700">
                    WU{l.key}
                  </span>
                  <Label className="flex-1 text-sm font-semibold">Horas antes da consulta</Label>
                  <Input
                    type="number"
                    min={1}
                    value={wu[l.hKey]}
                    onChange={(e) => setWu((p) => ({ ...p, [l.hKey]: e.target.value }))}
                    className="w-24 text-center"
                  />
                </div>
                <Textarea
                  rows={3}
                  value={prompts[l.pKey]}
                  onChange={(e) => setPrompts((p) => ({ ...p, [l.pKey]: e.target.value }))}
                  placeholder={`Mensagem WU${l.key} — ${wu[l.hKey]}h antes da consulta…`}
                  className="resize-none"
                />
              </div>
            ))}
          </div>

          <Button onClick={() => save.mutate()} disabled={save.isPending} className="w-full py-3">
            {save.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Salvar configurações
          </Button>
        </div>
      )}
    </div>
  );
}

// =================================================================
// Full-screen: Escalation View
// =================================================================

function EscalationView({ agentId, onClose }: { agentId: string; onClose: () => void }) {
  const qc = useQueryClient();
  const getCfg = useServerFn(getAgentEscalation);
  const saveCfg = useServerFn(saveAgentEscalation);

  const { data, isLoading } = useQuery({
    queryKey: ["escalation-config", agentId],
    queryFn: () => getCfg({ data: { agentId } }),
  });

  const [ativo, setAtivo] = useState(false);
  const [evUrl, setEvUrl] = useState("");
  const [evInstance, setEvInstance] = useState("");
  const [evKey, setEvKey] = useState("");
  const [grupo, setGrupo] = useState("");

  useEffect(() => {
    if (data) {
      setAtivo(data.ativo ?? false);
      setEvUrl(data.evolution_url ?? "");
      setEvInstance(data.evolution_instance ?? "");
      setGrupo(data.grupo_alerta ?? "");
    }
  }, [data]);

  const save = useMutation({
    mutationFn: () =>
      saveCfg({
        data: {
          agentId,
          ativo,
          evolution_url: evUrl || undefined,
          evolution_instance: evInstance || undefined,
          ...(evKey ? { evolution_key: evKey } : {}),
          grupo_alerta: grupo || undefined,
        },
      }),
    onSuccess: () => {
      toast.success("Escalação salva.");
      setEvKey("");
      qc.invalidateQueries({ queryKey: ["escalation-config", agentId] });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Erro ao salvar."),
  });

  return (
    <div className="flex min-h-screen flex-col bg-slate-50">
      {/* Title bar */}
      <div className="flex items-center gap-3 border-b border-slate-200 bg-white px-5 py-3">
        <button onClick={onClose} className="flex items-center gap-1 text-xs font-semibold text-primary hover:text-primary/80">
          ← VOLTAR
        </button>
        <div className="mx-1 h-4 w-px bg-slate-200" />
        <div className="flex items-center gap-2">
          <span className="flex h-7 w-7 items-center justify-center rounded-xl bg-pink-100">
            <UserX className="h-3.5 w-3.5 text-pink-600" />
          </span>
          <span className="text-sm font-semibold text-foreground">Escalada humana</span>
        </div>
        <div className="flex-1" />
        <button
          onClick={() => save.mutate()}
          disabled={save.isPending}
          className="flex items-center gap-1.5 rounded-full bg-primary px-4 py-1.5 text-xs font-semibold text-white shadow-sm shadow-primary/30 transition-opacity hover:opacity-90 disabled:opacity-60"
        >
          {save.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
          Salvar
        </button>
      </div>

      {isLoading ? (
        <div className="flex flex-1 items-center justify-center">
          <Loader2 className="h-6 w-6 animate-spin text-primary" />
        </div>
      ) : (
        <div className="mx-auto w-full max-w-2xl px-6 py-8 space-y-5">
          {/* Info banner */}
          <div className="rounded-xl border border-pink-200 bg-pink-50 p-4">
            <p className="text-sm font-semibold text-pink-800">Transferência para atendente humano</p>
            <p className="mt-1 text-xs text-pink-700">
              Quando o agente escalar para humano, a tag <strong>"IA Desligada"</strong> é adicionada ao contato no Helena e um alerta é enviado ao grupo Evolution configurado abaixo.
            </p>
          </div>

          {/* Toggle */}
          <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
            <ToggleRow label="Ativar escalada humana" value={ativo} onChange={setAtivo} />
          </div>

          {/* Evolution config */}
          <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm space-y-4">
            <p className="text-sm font-semibold text-foreground">Configuração Evolution API</p>
            <div>
              <Label className="text-xs font-semibold text-slate-700">URL Evolution API</Label>
              <Input value={evUrl} onChange={(e) => setEvUrl(e.target.value)} placeholder="https://evolution.meudominio.com.br" className="mt-1.5" />
            </div>
            <div>
              <Label className="text-xs font-semibold text-slate-700">Instância Evolution</Label>
              <Input value={evInstance} onChange={(e) => setEvInstance(e.target.value)} placeholder="minha-instancia" className="mt-1.5" />
            </div>
            <div>
              <Label className="text-xs font-semibold text-slate-700">API Key Evolution</Label>
              {data?.key_last4 && !evKey && (
                <p className="text-xs text-muted-foreground mb-1">Atual: ••••{data.key_last4}</p>
              )}
              <Input type="password" value={evKey} onChange={(e) => setEvKey(e.target.value)} placeholder="cole a API key" className="mt-1.5" />
            </div>
            <div>
              <Label className="text-xs font-semibold text-slate-700">JID do grupo de alerta</Label>
              <Input value={grupo} onChange={(e) => setGrupo(e.target.value)} placeholder="120363123456789@g.us" className="mt-1.5" />
              <p className="mt-1.5 text-[11px] text-muted-foreground">
                Copie o JID do grupo no painel Evolution (formato: 120363…@g.us)
              </p>
            </div>
          </div>

          <Button onClick={() => save.mutate()} disabled={save.isPending} className="w-full py-3">
            {save.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Salvar configurações
          </Button>
        </div>
      )}
    </div>
  );
}

// =================================================================
// Shared components
// =================================================================

function ToggleRow({
  label,
  value,
  onChange,
  disabled,
}: {
  label: string;
  value: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex items-center justify-between rounded-md border p-3">
      <span className="text-sm">{label}</span>
      <Switch checked={value} onCheckedChange={onChange} disabled={disabled} />
    </div>
  );
}

function KeyBlock({
  label,
  help,
  current,
  value,
  onChange,
  onSave,
  extra,
  note,
}: {
  label: string;
  help: React.ReactNode;
  current: string | null;
  value: string;
  onChange: (v: string) => void;
  onSave: () => void;
  extra?: React.ReactNode;
  note?: string | null;
}) {
  return (
    <div className="space-y-2 rounded-md border p-3">
      <div className="flex items-center justify-between">
        <Label className="text-sm font-semibold">{label}</Label>
        {current ? (
          <Badge variant="outline" className="border-emerald-500/40 text-emerald-700">••{current}</Badge>
        ) : (
          <Badge variant="outline">não configurado</Badge>
        )}
      </div>
      <p className="text-[11px] text-muted-foreground">Obter em: {help}</p>
      <div className="flex gap-2">
        <Input type="password" value={value} onChange={(e) => onChange(e.target.value)} placeholder="cole a chave aqui" />
        <Button onClick={onSave} disabled={!value}>Salvar</Button>
        {extra}
      </div>
      {note && <p className="text-xs">{note}</p>}
    </div>
  );
}

// =================================================================
// Mini cost dashboard card
// =================================================================

function CostMiniCard({ accountId }: { accountId: string }) {
  const usageFn = useServerFn(getUsageSummary);
  const { data, isLoading } = useQuery({
    queryKey: ["usage-mini", accountId],
    queryFn: () => usageFn({ data: { accountId } }),
    staleTime: 5 * 60 * 1000,
  });

  const rows = (data?.rows ?? []) as { cost_usd?: unknown; requests?: unknown; tokens_in?: unknown; tokens_out?: unknown }[];
  const totalCost = rows.reduce((s, r) => s + Number(r.cost_usd ?? 0), 0);
  const totalReq = rows.reduce((s, r) => s + Number(r.requests ?? 0), 0);
  const totalTokens = rows.reduce((s, r) => s + Number(r.tokens_in ?? 0) + Number(r.tokens_out ?? 0), 0);

  return (
    <section>
      <SectionTitle>Custo de IA — últimos 30 dias</SectionTitle>
      <div className="grid grid-cols-3 gap-3">
        {[
          { label: "Custo total", value: isLoading ? "…" : `$${totalCost.toFixed(4)}`, color: "text-amber-600", bg: "bg-amber-50 border-amber-200" },
          { label: "Requisições", value: isLoading ? "…" : totalReq.toLocaleString(), color: "text-blue-600", bg: "bg-blue-50 border-blue-200" },
          { label: "Tokens", value: isLoading ? "…" : totalTokens >= 1000 ? `${(totalTokens / 1000).toFixed(1)}K` : String(totalTokens), color: "text-violet-600", bg: "bg-violet-50 border-violet-200" },
        ].map((item) => (
          <div key={item.label} className={`rounded-2xl border ${item.bg} p-4 text-center shadow-sm`}>
            {isLoading ? (
              <Loader2 className="h-4 w-4 animate-spin mx-auto text-muted-foreground" />
            ) : (
              <p className={`text-lg font-bold tabular-nums ${item.color}`}>{item.value}</p>
            )}
            <p className="mt-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{item.label}</p>
          </div>
        ))}
      </div>
    </section>
  );
}
