import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState, useEffect, useRef } from "react";
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
} from "@/lib/secrets.functions";
import {
  getGoogleCalendarStatusFn,
  getGoogleAuthUrl,
  disconnectGoogleCalendar,
  getClinicorpConfig,
  saveClinicorpConfig,
  testClinicorpConnection,
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

export const Route = createFileRoute("/embed/account/$accountId/")({
  component: EmbedHome,
});

type SheetKey =
  | null
  | "training"
  | "settings"
  | "whatsapp"
  | "audio"
  | "secrets"
  | "google-calendar"
  | "clinicorp"
  | "clinup"
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
        onClose={() => setOpenSheet(null)}
      />
    );
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

        {/* ── Canais e Integrações ── */}
        <section>
          <SectionTitle>Canais e integrações</SectionTitle>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <IntegrationCard
              icon={<MessageCircle className="h-5 w-5" />}
              title="WhatsApp"
              status="Helena CRM"
              active
              iconClass="bg-gradient-to-br from-emerald-400 to-emerald-600 text-white shadow-emerald-500/30"
              onClick={() => setOpenSheet("whatsapp")}
            />
            <IntegrationCard
              icon={<Headphones className="h-5 w-5" />}
              title="Áudio"
              status={data.audio?.habilitado ? "Ativo" : "Inativo"}
              active={!!(data.audio?.habilitado)}
              iconClass="bg-gradient-to-br from-sky-400 to-blue-600 text-white shadow-blue-500/30"
              onClick={() => setOpenSheet("audio")}
            />
            <GoogleCalendarCard accountId={accountId} onClick={() => setOpenSheet("google-calendar")} />
            <ClinicorpCard accountId={accountId} onClick={() => setOpenSheet("clinicorp")} />
            <ClinupCard accountId={accountId} onClick={() => setOpenSheet("clinup")} />
            <IntegrationCard
              icon={<Bell className="h-5 w-5" />}
              title="Follow-up"
              status="Automático"
              active={false}
              iconClass="bg-gradient-to-br from-orange-400 to-orange-600 text-white shadow-orange-500/30"
              onClick={() => setOpenSheet("followup")}
            />
            <IntegrationCard
              icon={<Flame className="h-5 w-5" />}
              title="Warm-up"
              status="Consultas"
              active={false}
              iconClass="bg-gradient-to-br from-red-400 to-rose-600 text-white shadow-rose-500/30"
              onClick={() => setOpenSheet("warmup")}
            />
            <IntegrationCard
              icon={<UserX className="h-5 w-5" />}
              title="Escalada humana"
              status="Evolution"
              active={false}
              iconClass="bg-gradient-to-br from-pink-400 to-pink-600 text-white shadow-pink-500/30"
              onClick={() => setOpenSheet("escalation")}
            />
          </div>
        </section>

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
      <SettingsSheet
        open={openSheet === "settings"}
        onClose={() => setOpenSheet(null)}
        accountId={accountId}
        currentModel={(agent.llm_model_override as string | null) ?? (data.llm?.default_model as string | null) ?? ""}
        currentVoice={(data.voice?.elevenlabs_voice_id as string | null) ?? null}
        debounceSegundos={(agent.debounce_segundos as number | null) ?? 20}
        hasOpenRouter={!!data.secrets?.openrouter_last4}
        hasElevenLabs={!!data.secrets?.elevenlabs_last4}
      />
      <AudioSheet
        open={openSheet === "audio"}
        onClose={() => setOpenSheet(null)}
        accountId={accountId}
        habilitado={!!(data.audio?.habilitado)}
        transcrever={!!(data.audio?.transcrever_in)}
        responder={!!(data.audio?.responder_out)}
      />
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
      <GoogleCalendarSheet
        open={openSheet === "google-calendar"}
        onClose={() => setOpenSheet(null)}
        accountId={accountId}
      />
      <ClinicorpSheet
        open={openSheet === "clinicorp"}
        onClose={() => setOpenSheet(null)}
        accountId={accountId}
      />
      <ClinupSheet
        open={openSheet === "clinup"}
        onClose={() => setOpenSheet(null)}
        accountId={accountId}
      />
      <FollowupSheet
        open={openSheet === "followup"}
        onClose={() => setOpenSheet(null)}
        agentId={agentId}
      />
      <WarmupSheet
        open={openSheet === "warmup"}
        onClose={() => setOpenSheet(null)}
        agentId={agentId}
      />
      <EscalationSheet
        open={openSheet === "escalation"}
        onClose={() => setOpenSheet(null)}
        agentId={agentId}
      />
      <PlaceholderSheet
        open={openSheet === "whatsapp"}
        onClose={() => setOpenSheet(null)}
        title="WhatsApp (Helena CRM)"
        body="O WhatsApp é recebido diretamente pelo webhook do Helena. Copie a URL do webhook na tela principal e configure no seu fluxo do CRM Helena."
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

function IntegrationCard({
  icon,
  title,
  status,
  active,
  iconClass,
  onClick,
}: {
  icon: React.ReactNode;
  title: string;
  status: string;
  active: boolean;
  iconClass: string;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className="group relative overflow-hidden rounded-2xl border border-slate-200/60 bg-white p-4 text-left shadow-sm transition-all duration-200 hover:-translate-y-0.5 hover:shadow-md"
    >
      <div className={`mb-3 flex h-10 w-10 items-center justify-center rounded-xl shadow-sm ${iconClass}`}>
        {icon}
      </div>
      <p className="text-xs font-semibold leading-tight text-foreground">{title}</p>
      <span className={`mt-1.5 inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium ${active ? "bg-emerald-100 text-emerald-700" : "bg-zinc-100 text-zinc-500"}`}>
        <span className={`h-1.5 w-1.5 rounded-full ${active ? "bg-emerald-500" : "bg-zinc-400"}`} />
        {status}
      </span>
    </button>
  );
}

function GoogleCalendarCard({
  accountId,
  onClick,
}: {
  accountId: string;
  onClick: () => void;
}) {
  const getStatus = useServerFn(getGoogleCalendarStatusFn);
  const { data } = useQuery({
    queryKey: ["gcal-status", accountId],
    queryFn: () => getStatus({ data: { accountId } }),
  });

  return (
    <button
      onClick={onClick}
      className="group relative overflow-hidden rounded-2xl border border-slate-200/60 bg-white p-4 text-left shadow-sm transition-all duration-200 hover:-translate-y-0.5 hover:shadow-md"
    >
      <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-blue-400 to-indigo-600 text-white shadow-sm shadow-blue-500/30">
        <Calendar className="h-5 w-5" />
      </div>
      <p className="text-xs font-semibold leading-tight text-foreground">Google Calendar</p>
      <span className={`mt-1.5 inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium ${data?.connected ? "bg-emerald-100 text-emerald-700" : "bg-zinc-100 text-zinc-500"}`}>
        <span className={`h-1.5 w-1.5 rounded-full ${data?.connected ? "bg-emerald-500" : "bg-zinc-400"}`} />
        {data?.connected ? "Conectado" : "Desconectado"}
      </span>
    </button>
  );
}

function ClinicorpCard({
  accountId,
  onClick,
}: {
  accountId: string;
  onClick: () => void;
}) {
  const getCfg = useServerFn(getClinicorpConfig);
  const { data } = useQuery({
    queryKey: ["clinicorp-config", accountId],
    queryFn: () => getCfg({ data: { accountId } }),
  });

  return (
    <button
      onClick={onClick}
      className="group relative overflow-hidden rounded-2xl border border-slate-200/60 bg-white p-4 text-left shadow-sm transition-all duration-200 hover:-translate-y-0.5 hover:shadow-md"
    >
      <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-teal-400 to-cyan-600 text-white shadow-sm shadow-teal-500/30">
        <Stethoscope className="h-5 w-5" />
      </div>
      <p className="text-xs font-semibold leading-tight text-foreground">Clinicorp</p>
      <span className={`mt-1.5 inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium ${data?.ativo ? "bg-emerald-100 text-emerald-700" : "bg-zinc-100 text-zinc-500"}`}>
        <span className={`h-1.5 w-1.5 rounded-full ${data?.ativo ? "bg-emerald-500" : "bg-zinc-400"}`} />
        {data?.ativo ? "Ativo" : "Inativo"}
      </span>
    </button>
  );
}

function ClinupCard({
  accountId,
  onClick,
}: {
  accountId: string;
  onClick: () => void;
}) {
  const getCfg = useServerFn(getClinupConfig);
  const { data } = useQuery({
    queryKey: ["clinup-config", accountId],
    queryFn: () => getCfg({ data: { accountId } }),
  });

  return (
    <button
      onClick={onClick}
      className="group relative overflow-hidden rounded-2xl border border-slate-200/60 bg-white p-4 text-left shadow-sm transition-all duration-200 hover:-translate-y-0.5 hover:shadow-md"
    >
      <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-violet-400 to-purple-600 text-white shadow-sm shadow-violet-500/30">
        <ClipboardList className="h-5 w-5" />
      </div>
      <p className="text-xs font-semibold leading-tight text-foreground">Clinup</p>
      <span className={`mt-1.5 inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium ${data?.ativo ? "bg-emerald-100 text-emerald-700" : "bg-zinc-100 text-zinc-500"}`}>
        <span className={`h-1.5 w-1.5 rounded-full ${data?.ativo ? "bg-emerald-500" : "bg-zinc-400"}`} />
        {data?.ativo ? "Ativo" : "Inativo"}
      </span>
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
  onClose,
}: {
  accountId: string;
  initialPrompt: string;
  initialNome: string;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const updateFn = useServerFn(updateAgent);

  const editorRef = useRef<HTMLDivElement>(null);
  const autoSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [tab, setTab] = useState<TrainingTab>("instrucoes");
  const [nome, setNome] = useState(initialNome);
  const [charCount, setCharCount] = useState(initialPrompt.length);
  const [saveState, setSaveState] = useState<"saved" | "unsaved" | "saving">("saved");
  const [autosave, setAutosave] = useState(true);

  // Seed the contentEditable once on mount
  useEffect(() => {
    if (editorRef.current) {
      editorRef.current.innerText = initialPrompt;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const doSave = async () => {
    if (!editorRef.current) return;
    const text = editorRef.current.innerText;
    setSaveState("saving");
    try {
      await updateFn({ data: { accountId, system_prompt: text, nome } });
      qc.invalidateQueries({ queryKey: ["agent", accountId] });
      setSaveState("saved");
    } catch {
      setSaveState("unsaved");
      toast.error("Erro ao salvar.");
    }
  };

  const handleInput = () => {
    const len = editorRef.current?.innerText.length ?? 0;
    setCharCount(len);
    setSaveState("unsaved");
    if (autosave) {
      if (autoSaveTimer.current) clearTimeout(autoSaveTimer.current);
      autoSaveTimer.current = setTimeout(() => { void doSave(); }, 2000);
    }
  };

  const fmt = (cmd: string, val?: string) => {
    document.execCommand(cmd, false, val);
    editorRef.current?.focus();
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
          onClick={() => toast.info("Templates em breve!")}
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

          {/* Toolbar */}
          <div className="flex flex-wrap items-center gap-1 border-b border-slate-100 bg-white px-3 py-2">
            {/* Undo / Redo */}
            <button onClick={() => fmt("undo")} title="Desfazer" className="rounded p-1.5 text-slate-600 hover:bg-slate-100">
              <svg viewBox="0 0 24 24" className="h-4 w-4 fill-none stroke-current stroke-2"><path d="M3 7h10a5 5 0 0 1 0 10H3m0-10 4-4M3 7l4 4" strokeLinecap="round" strokeLinejoin="round"/></svg>
            </button>
            <button onClick={() => fmt("redo")} title="Refazer" className="rounded p-1.5 text-slate-600 hover:bg-slate-100">
              <svg viewBox="0 0 24 24" className="h-4 w-4 fill-none stroke-current stroke-2"><path d="M21 7H11a5 5 0 0 0 0 10h10m0-10-4-4m4 4-4 4" strokeLinecap="round" strokeLinejoin="round"/></svg>
            </button>
            <div className="mx-1 h-4 w-px bg-slate-200" />

            {/* Format buttons */}
            <button onClick={() => fmt("bold")} title="Negrito" className="rounded p-1.5 text-sm font-bold text-slate-700 hover:bg-slate-100">B</button>
            <button onClick={() => fmt("italic")} title="Itálico" className="rounded p-1.5 text-sm italic text-slate-700 hover:bg-slate-100">I</button>
            <button onClick={() => fmt("underline")} title="Sublinhado" className="rounded p-1.5 text-sm underline text-slate-700 hover:bg-slate-100">U</button>
            <button onClick={() => fmt("strikeThrough")} title="Tachado" className="rounded p-1.5 text-sm line-through text-slate-700 hover:bg-slate-100">S</button>
            <div className="mx-1 h-4 w-px bg-slate-200" />

            {/* Font size */}
            <select
              onChange={(e) => { fmt("fontSize", e.target.value); e.target.value = ""; }}
              defaultValue=""
              className="rounded border border-slate-200 px-2 py-1 text-xs text-slate-700 focus:outline-none"
            >
              <option value="" disabled>T Tamanho ▾</option>
              <option value="1">Pequeno</option>
              <option value="3">Normal</option>
              <option value="5">Grande</option>
              <option value="7">Enorme</option>
            </select>
            <div className="mx-1 h-4 w-px bg-slate-200" />

            {/* Emoji placeholder */}
            <button
              title="Emoji"
              className="rounded p-1.5 text-base leading-none hover:bg-slate-100"
              onClick={() => toast.info("Emoji picker em breve!")}
            >☺</button>

            {/* AI Magic */}
            <button
              onClick={() => toast.info("AI Magic em breve!")}
              className="flex items-center gap-1.5 rounded-full bg-primary px-3 py-1 text-xs font-semibold text-white shadow-sm shadow-primary/30 hover:bg-primary/90"
            >
              <Zap className="h-3 w-3" /> AI Magic
            </button>

            {/* Mic placeholder */}
            <button
              title="Áudio"
              className="rounded p-1.5 text-slate-600 hover:bg-slate-100"
              onClick={() => toast.info("Gravação de áudio em breve!")}
            >
              <svg viewBox="0 0 24 24" className="h-4 w-4 fill-none stroke-current stroke-2"><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10a7 7 0 0 0 14 0M12 19v3m-3 0h6" strokeLinecap="round"/></svg>
            </button>
            <div className="mx-1 h-4 w-px bg-slate-200" />

            {/* Char counter + save */}
            <span className="text-xs text-muted-foreground">{charCount.toLocaleString()} / 22.500</span>
            <button
              onClick={() => void doSave()}
              title="Salvar"
              className="ml-1 flex h-6 w-6 items-center justify-center rounded-full bg-primary/10 text-primary hover:bg-primary/20"
            >
              <Play className="h-3.5 w-3.5 fill-current" />
            </button>

            <div className="flex-1" />

            {/* Save status */}
            <span
              className={`mr-3 flex items-center gap-1.5 text-xs font-medium ${
                saveState === "saved"
                  ? "text-emerald-600"
                  : saveState === "saving"
                  ? "text-amber-500"
                  : "text-slate-400"
              }`}
            >
              <span
                className={`h-2 w-2 rounded-full ${
                  saveState === "saved"
                    ? "bg-emerald-500"
                    : saveState === "saving"
                    ? "bg-amber-400 animate-pulse"
                    : "bg-slate-300"
                }`}
              />
              {saveState === "saved" ? "Salvo" : saveState === "saving" ? "Salvando…" : "Não salvo"}
            </span>

            {/* Autosave toggle */}
            <span className="mr-1.5 text-xs text-muted-foreground">Autosave</span>
            <Switch checked={autosave} onCheckedChange={setAutosave} />
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

          {/* ContentEditable editor area */}
          <div
            ref={editorRef}
            contentEditable
            onInput={handleInput}
            suppressContentEditableWarning
            data-placeholder="Você é um assistente virtual especializado em… Descreva aqui a personalidade, tom, objetivos e regras do agente."
            className="min-h-0 flex-1 cursor-text p-5 text-sm leading-relaxed text-foreground outline-none empty:before:text-muted-foreground/50 empty:before:content-[attr(data-placeholder)]"
            style={{ minHeight: "calc(100vh - 260px)" }}
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
    </div>
  );
}

// =================================================================
// Sheet: Settings
// =================================================================

function SettingsSheet({
  open,
  onClose,
  accountId,
  currentModel,
  currentVoice,
  debounceSegundos,
  hasOpenRouter,
  hasElevenLabs,
}: {
  open: boolean;
  onClose: () => void;
  accountId: string;
  currentModel: string;
  currentVoice: string | null;
  debounceSegundos: number;
  hasOpenRouter: boolean;
  hasElevenLabs: boolean;
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

  useEffect(() => {
    if (open) {
      setModel(currentModel);
      setVoiceId(currentVoice ?? "");
      setDebounce(debounceSegundos);
    }
  }, [open, currentModel, currentVoice, debounceSegundos]);

  const models = useQuery({
    queryKey: ["openrouter-models", accountId],
    queryFn: () => listModels({ data: { accountId } }),
    enabled: open && hasOpenRouter,
  });
  const voices = useQuery({
    queryKey: ["eleven-voices", accountId],
    queryFn: () => listVoices({ data: { accountId } }),
    enabled: open && hasElevenLabs,
  });

  const save = useMutation({
    mutationFn: async () => {
      await updateLlm({ data: { accountId, default_model: model } });
      await updateVoice({ data: { accountId, elevenlabs_voice_id: voiceId || null } });
      await updateAgentFn({ data: { accountId, debounce_segundos: debounce } });
    },
    onSuccess: () => {
      toast.success("Configurações salvas.");
      qc.invalidateQueries({ queryKey: ["agent", accountId] });
      onClose();
    },
  });

  return (
    <Sheet open={open} onOpenChange={(v) => !v && onClose()}>
      <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-xl">
        <SheetHeader>
          <SheetTitle>Configurações do assistente</SheetTitle>
        </SheetHeader>
        <div className="space-y-5 py-4">
          <div>
            <Label>Modelo de IA (OpenRouter)</Label>
            {!hasOpenRouter ? (
              <p className="mt-1 rounded-md border bg-muted/40 p-3 text-xs text-muted-foreground">
                Cadastre sua chave OpenRouter em "Conexões e custos" para listar os modelos.
              </p>
            ) : models.isLoading ? (
              <Loader2 className="mt-1 h-4 w-4 animate-spin" />
            ) : (
              <select
                className="mt-1 w-full rounded-md border bg-background p-2 text-sm"
                value={model}
                onChange={(e) => setModel(e.target.value)}
              >
                <option value="">— escolher —</option>
                {(models.data?.models ?? []).map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </select>
            )}
          </div>

          <div>
            <Label>Voz (ElevenLabs)</Label>
            {!hasElevenLabs ? (
              <p className="mt-1 rounded-md border bg-muted/40 p-3 text-xs text-muted-foreground">
                Cadastre sua chave ElevenLabs em "Conexões e custos" para escolher uma voz.
              </p>
            ) : voices.isLoading ? (
              <Loader2 className="mt-1 h-4 w-4 animate-spin" />
            ) : (
              <select
                className="mt-1 w-full rounded-md border bg-background p-2 text-sm"
                value={voiceId}
                onChange={(e) => setVoiceId(e.target.value)}
              >
                <option value="">— escolher —</option>
                {(voices.data?.voices ?? []).map((v) => (
                  <option key={v.voice_id} value={v.voice_id}>
                    {v.name}
                  </option>
                ))}
              </select>
            )}
          </div>

          <div>
            <Label htmlFor="debounce">Debounce (segundos)</Label>
            <p className="mb-1 text-xs text-muted-foreground">
              Aguarda este tempo antes de processar, agrupando mensagens rápidas. 0 = desativado.
            </p>
            <Input
              id="debounce"
              type="number"
              min={0}
              max={120}
              value={debounce}
              onChange={(e) => setDebounce(Number(e.target.value))}
            />
          </div>

          <Button onClick={() => save.mutate()} disabled={save.isPending} className="w-full">
            {save.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Salvar
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  );
}

// =================================================================
// Sheet: Audio
// =================================================================

function AudioSheet({
  open,
  onClose,
  accountId,
  habilitado,
  transcrever,
  responder,
}: {
  open: boolean;
  onClose: () => void;
  accountId: string;
  habilitado: boolean;
  transcrever: boolean;
  responder: boolean;
}) {
  const qc = useQueryClient();
  const update = useServerFn(updateAudio);
  const [h, setH] = useState(habilitado);
  const [t, setT] = useState(transcrever);
  const [r, setR] = useState(responder);

  useEffect(() => {
    if (open) {
      setH(habilitado);
      setT(transcrever);
      setR(responder);
    }
  }, [open, habilitado, transcrever, responder]);

  const m = useMutation({
    mutationFn: () =>
      update({ data: { accountId, habilitado: h, transcrever_in: t, responder_out: r } }),
    onSuccess: () => {
      toast.success("Áudio atualizado.");
      qc.invalidateQueries({ queryKey: ["agent", accountId] });
      onClose();
    },
  });

  return (
    <Sheet open={open} onOpenChange={(v) => !v && onClose()}>
      <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-md">
        <SheetHeader>
          <SheetTitle>Áudio</SheetTitle>
        </SheetHeader>
        <div className="space-y-4 py-4">
          <ToggleRow label="Habilitado" value={h} onChange={setH} />
          <ToggleRow label="Transcrever áudios recebidos (Groq Whisper)" value={t} onChange={setT} disabled={!h} />
          <ToggleRow label="Responder com voz (ElevenLabs TTS)" value={r} onChange={setR} disabled={!h} />
          <Button onClick={() => m.mutate()} disabled={m.isPending} className="w-full">
            {m.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Salvar
          </Button>
        </div>
      </SheetContent>
    </Sheet>
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
// Sheet: Google Calendar
// =================================================================

function GoogleCalendarSheet({
  open,
  onClose,
  accountId,
}: {
  open: boolean;
  onClose: () => void;
  accountId: string;
}) {
  const qc = useQueryClient();
  const getStatus = useServerFn(getGoogleCalendarStatusFn);
  const getAuthUrl = useServerFn(getGoogleAuthUrl);
  const disconnect = useServerFn(disconnectGoogleCalendar);

  const { data, isLoading } = useQuery({
    queryKey: ["gcal-status", accountId],
    queryFn: () => getStatus({ data: { accountId } }),
    enabled: open,
  });

  const [connecting, setConnecting] = useState(false);

  async function connect() {
    setConnecting(true);
    try {
      const { url } = await getAuthUrl({ data: { accountId } });
      const popup = window.open(url, "gcal-oauth", "width=500,height=650,popup=true");
      if (!popup) {
        toast.error("Pop-up bloqueado. Permita pop-ups para esta página.");
        return;
      }
      const check = setInterval(() => {
        if (popup.closed) {
          clearInterval(check);
          qc.invalidateQueries({ queryKey: ["gcal-status", accountId] });
          setConnecting(false);
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
    <Sheet open={open} onOpenChange={(v) => !v && onClose()}>
      <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-md">
        <SheetHeader>
          <SheetTitle>Google Calendar</SheetTitle>
        </SheetHeader>
        <div className="space-y-4 py-4">
          {isLoading ? (
            <Loader2 className="h-5 w-5 animate-spin" />
          ) : data?.connected ? (
            <>
              <div className="rounded-md border bg-emerald-500/5 p-4">
                <div className="flex items-center gap-2">
                  <Check className="h-5 w-5 text-emerald-500" />
                  <p className="text-sm font-medium">Conectado</p>
                </div>
                {data.email && <p className="mt-1 text-xs text-muted-foreground">Conta: {data.email}</p>}
                {data.calendarName && <p className="text-xs text-muted-foreground">Calendário: {data.calendarName}</p>}
              </div>
              <Button
                variant="outline"
                className="w-full"
                onClick={() => disconnectM.mutate()}
                disabled={disconnectM.isPending}
              >
                {disconnectM.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                Desconectar Google Calendar
              </Button>
            </>
          ) : (
            <>
              <p className="text-sm text-muted-foreground">
                Conecte sua conta Google para que o agente possa verificar disponibilidade e criar agendamentos no seu calendário.
              </p>
              <Button onClick={connect} disabled={connecting} className="w-full">
                {connecting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <ExternalLink className="mr-2 h-4 w-4" />}
                Conectar com Google
              </Button>
            </>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

// =================================================================
// Sheet: Clinicorp
// =================================================================

function ClinicorpSheet({
  open,
  onClose,
  accountId,
}: {
  open: boolean;
  onClose: () => void;
  accountId: string;
}) {
  const qc = useQueryClient();
  const getCfg = useServerFn(getClinicorpConfig);
  const saveCfg = useServerFn(saveClinicorpConfig);
  const testConn = useServerFn(testClinicorpConnection);

  const { data, isLoading } = useQuery({
    queryKey: ["clinicorp-config", accountId],
    queryFn: () => getCfg({ data: { accountId } }),
    enabled: open,
  });

  const [token, setToken] = useState("");
  const [subscriberId, setSubscriberId] = useState("");
  const [businessId, setBusinessId] = useState("");
  const [agendaId, setAgendaId] = useState("");
  const [duracao, setDuracao] = useState("40");
  const [ativo, setAtivo] = useState(false);
  const [testResult, setTestResult] = useState<string | null>(null);

  useEffect(() => {
    if (open && data) {
      setSubscriberId(data.subscriber_id ?? "");
      setBusinessId(data.business_id ? String(data.business_id) : "");
      setAgendaId(data.agenda_id ? String(data.agenda_id) : "");
      setDuracao(String(data.duracao_consulta ?? 40));
      setAtivo(data.ativo ?? false);
    }
  }, [open, data]);

  const save = useMutation({
    mutationFn: () =>
      saveCfg({
        data: {
          accountId,
          ...(token ? { api_token: token } : {}),
          subscriber_id: subscriberId,
          business_id: businessId ? Number(businessId) : undefined,
          agenda_id: agendaId ? Number(agendaId) : undefined,
          duracao_consulta: Number(duracao),
          ativo,
        },
      }),
    onSuccess: () => {
      toast.success("Clinicorp salvo.");
      setToken("");
      qc.invalidateQueries({ queryKey: ["clinicorp-config", accountId] });
    },
  });

  async function doTest() {
    setTestResult(null);
    const r = await testConn({ data: { accountId } });
    setTestResult(r.ok ? "✅ Conexão OK" : `❌ ${r.error}`);
  }

  if (isLoading) {
    return (
      <Sheet open={open} onOpenChange={(v) => !v && onClose()}>
        <SheetContent side="right" className="w-full sm:max-w-md">
          <SheetHeader><SheetTitle>Clinicorp</SheetTitle></SheetHeader>
          <div className="py-4"><Loader2 className="h-5 w-5 animate-spin" /></div>
        </SheetContent>
      </Sheet>
    );
  }

  return (
    <Sheet open={open} onOpenChange={(v) => !v && onClose()}>
      <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-md">
        <SheetHeader>
          <SheetTitle>Clinicorp</SheetTitle>
        </SheetHeader>
        <div className="space-y-4 py-4">
          <ToggleRow label="Ativar integração Clinicorp" value={ativo} onChange={setAtivo} />

          <div>
            <Label>Token API (Basic auth base64)</Label>
            {data?.token_last4 && !token && (
              <p className="text-xs text-muted-foreground mb-1">Atual: ••••{data.token_last4}</p>
            )}
            <Input
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="cole o token Basic auth aqui"
              className="mt-1"
            />
          </div>
          <div>
            <Label>Subscriber ID</Label>
            <Input value={subscriberId} onChange={(e) => setSubscriberId(e.target.value)} className="mt-1" />
          </div>
          <div>
            <Label>Business ID</Label>
            <Input type="number" value={businessId} onChange={(e) => setBusinessId(e.target.value)} className="mt-1" />
          </div>
          <div>
            <Label>Agenda ID (Dentist_PersonId)</Label>
            <Input type="number" value={agendaId} onChange={(e) => setAgendaId(e.target.value)} className="mt-1" />
          </div>
          <div>
            <Label>Duração da consulta (minutos)</Label>
            <Input type="number" min={5} max={480} value={duracao} onChange={(e) => setDuracao(e.target.value)} className="mt-1" />
          </div>
          {testResult && <p className="text-xs">{testResult}</p>}
          <div className="flex gap-2">
            <Button onClick={() => save.mutate()} disabled={save.isPending} className="flex-1">
              {save.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Salvar
            </Button>
            <Button variant="outline" onClick={doTest}>
              Testar
            </Button>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}

// =================================================================
// Sheet: Clinup
// =================================================================

function ClinupSheet({
  open,
  onClose,
  accountId,
}: {
  open: boolean;
  onClose: () => void;
  accountId: string;
}) {
  const qc = useQueryClient();
  const getCfg = useServerFn(getClinupConfig);
  const saveCfg = useServerFn(saveClinupConfig);
  const testConn = useServerFn(testClinupConnection);

  const { data, isLoading } = useQuery({
    queryKey: ["clinup-config", accountId],
    queryFn: () => getCfg({ data: { accountId } }),
    enabled: open,
  });

  const [token, setToken] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [clinicId, setClinicId] = useState("");
  const [agendaId, setAgendaId] = useState("");
  const [duracao, setDuracao] = useState("40");
  const [ativo, setAtivo] = useState(false);
  const [testResult, setTestResult] = useState<string | null>(null);

  useEffect(() => {
    if (open && data) {
      setBaseUrl(data.base_url ?? "");
      setClinicId(data.clinic_id ?? "");
      setAgendaId(data.agenda_id ?? "");
      setDuracao(String(data.duracao_consulta ?? 40));
      setAtivo(data.ativo ?? false);
    }
  }, [open, data]);

  const save = useMutation({
    mutationFn: () =>
      saveCfg({
        data: {
          accountId,
          ...(token ? { api_token: token } : {}),
          base_url: baseUrl || undefined,
          clinic_id: clinicId || undefined,
          agenda_id: agendaId || undefined,
          duracao_consulta: Number(duracao),
          ativo,
        },
      }),
    onSuccess: () => {
      toast.success("Clinup salvo.");
      setToken("");
      qc.invalidateQueries({ queryKey: ["clinup-config", accountId] });
    },
  });

  async function doTest() {
    setTestResult(null);
    const r = await testConn({ data: { accountId } });
    setTestResult(r.ok ? "✅ Conexão OK" : `❌ ${r.error}`);
  }

  if (isLoading) {
    return (
      <Sheet open={open} onOpenChange={(v) => !v && onClose()}>
        <SheetContent side="right" className="w-full sm:max-w-md">
          <SheetHeader><SheetTitle>Clinup</SheetTitle></SheetHeader>
          <div className="py-4"><Loader2 className="h-5 w-5 animate-spin" /></div>
        </SheetContent>
      </Sheet>
    );
  }

  return (
    <Sheet open={open} onOpenChange={(v) => !v && onClose()}>
      <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-md">
        <SheetHeader>
          <SheetTitle>Clinup</SheetTitle>
        </SheetHeader>
        <div className="space-y-4 py-4">
          <ToggleRow label="Ativar integração Clinup" value={ativo} onChange={setAtivo} />
          <div>
            <Label>URL base da instância Clinup</Label>
            <Input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://app.clinup.com.br" className="mt-1" />
          </div>
          <div>
            <Label>Token API</Label>
            {data?.token_last4 && !token && (
              <p className="text-xs text-muted-foreground mb-1">Atual: ••••{data.token_last4}</p>
            )}
            <Input type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder="cole o token aqui" className="mt-1" />
          </div>
          <div>
            <Label>Clinic ID</Label>
            <Input value={clinicId} onChange={(e) => setClinicId(e.target.value)} className="mt-1" />
          </div>
          <div>
            <Label>Agenda ID</Label>
            <Input value={agendaId} onChange={(e) => setAgendaId(e.target.value)} className="mt-1" />
          </div>
          <div>
            <Label>Duração da consulta (minutos)</Label>
            <Input type="number" min={5} max={480} value={duracao} onChange={(e) => setDuracao(e.target.value)} className="mt-1" />
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
      </SheetContent>
    </Sheet>
  );
}

// =================================================================
// Sheet: Follow-up
// =================================================================

function FollowupSheet({
  open,
  onClose,
  agentId,
}: {
  open: boolean;
  onClose: () => void;
  agentId: string;
}) {
  const qc = useQueryClient();
  const getCfg = useServerFn(getFollowupConfig);
  const saveCfg = useServerFn(saveFollowupConfig);

  const { data, isLoading } = useQuery({
    queryKey: ["followup-config", agentId],
    queryFn: () => getCfg({ data: { agentId } }),
    enabled: open,
  });

  const [ativo, setAtivo] = useState(false);
  const [maxTent, setMaxTent] = useState("2");
  const [delay1, setDelay1] = useState("1");
  const [delay2, setDelay2] = useState("5");
  const [prompt1, setPrompt1] = useState("");
  const [prompt2, setPrompt2] = useState("");

  useEffect(() => {
    if (open && data) {
      setAtivo(data.ativo ?? false);
      setMaxTent(String(data.max_tentativas ?? 2));
      const delays = data.delay_horas ?? [1, 5];
      setDelay1(String(delays[0] ?? 1));
      setDelay2(String(delays[1] ?? 5));
      setPrompt1(data.prompt_fu1 ?? "");
      setPrompt2(data.prompt_fu2 ?? "");
    }
  }, [open, data]);

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
      onClose();
    },
  });

  return (
    <Sheet open={open} onOpenChange={(v) => !v && onClose()}>
      <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-xl">
        <SheetHeader>
          <SheetTitle>Follow-up automático</SheetTitle>
        </SheetHeader>
        {isLoading ? (
          <div className="py-4"><Loader2 className="h-5 w-5 animate-spin" /></div>
        ) : (
          <div className="space-y-4 py-4">
            <ToggleRow label="Ativar follow-up automático" value={ativo} onChange={setAtivo} />
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>Máximo de tentativas</Label>
                <Input type="number" min={1} max={5} value={maxTent} onChange={(e) => setMaxTent(e.target.value)} className="mt-1" />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>Delay FU1 (horas)</Label>
                <Input type="number" min={0} value={delay1} onChange={(e) => setDelay1(e.target.value)} className="mt-1" />
              </div>
              <div>
                <Label>Delay FU2 (horas)</Label>
                <Input type="number" min={0} value={delay2} onChange={(e) => setDelay2(e.target.value)} className="mt-1" />
              </div>
            </div>
            <div>
              <Label>Mensagem FU1</Label>
              <p className="mb-1 text-xs text-muted-foreground">Enviado após {delay1}h sem resposta</p>
              <Textarea rows={4} value={prompt1} onChange={(e) => setPrompt1(e.target.value)} placeholder="Oi! Tudo bem? Vi que você se interessou..." className="mt-1" />
            </div>
            <div>
              <Label>Mensagem FU2</Label>
              <p className="mb-1 text-xs text-muted-foreground">Enviado após {delay2}h sem resposta</p>
              <Textarea rows={4} value={prompt2} onChange={(e) => setPrompt2(e.target.value)} placeholder="Olá! Ainda posso ajudar com o agendamento..." className="mt-1" />
            </div>
            <Button onClick={() => save.mutate()} disabled={save.isPending} className="w-full">
              {save.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Salvar
            </Button>
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}

// =================================================================
// Sheet: Warm-up
// =================================================================

function WarmupSheet({
  open,
  onClose,
  agentId,
}: {
  open: boolean;
  onClose: () => void;
  agentId: string;
}) {
  const qc = useQueryClient();
  const getCfg = useServerFn(getWarmupConfig);
  const saveCfg = useServerFn(saveWarmupConfig);

  const { data, isLoading } = useQuery({
    queryKey: ["warmup-config", agentId],
    queryFn: () => getCfg({ data: { agentId } }),
    enabled: open,
  });

  const [ativo, setAtivo] = useState(false);
  const [wu, setWu] = useState({ h1: "96", h2: "72", h3: "48", h4: "24", h5: "2" });
  const [prompts, setPrompts] = useState({ p1: "", p2: "", p3: "", p4: "", p5: "" });

  useEffect(() => {
    if (open && data) {
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
  }, [open, data]);

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
      onClose();
    },
  });

  const wuLevels = [
    { key: "1" as const, hKey: "h1" as const, pKey: "p1" as const },
    { key: "2" as const, hKey: "h2" as const, pKey: "p2" as const },
    { key: "3" as const, hKey: "h3" as const, pKey: "p3" as const },
    { key: "4" as const, hKey: "h4" as const, pKey: "p4" as const },
    { key: "5" as const, hKey: "h5" as const, pKey: "p5" as const },
  ];

  return (
    <Sheet open={open} onOpenChange={(v) => !v && onClose()}>
      <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-xl">
        <SheetHeader>
          <SheetTitle>Warm-up de consultas</SheetTitle>
        </SheetHeader>
        {isLoading ? (
          <div className="py-4"><Loader2 className="h-5 w-5 animate-spin" /></div>
        ) : (
          <div className="space-y-4 py-4">
            <p className="text-xs text-muted-foreground">
              Envia mensagens automáticas antes de consultas agendadas no Clinicorp.
              Use {"{{nome}}"}, {"{{data_consulta}}"} e {"{{hora_consulta}}"} nos templates.
            </p>
            <ToggleRow label="Ativar warm-up automático" value={ativo} onChange={setAtivo} />
            {wuLevels.map((l) => (
              <div key={l.key} className="rounded-md border p-3 space-y-2">
                <div className="flex items-center gap-3">
                  <Badge variant="outline">WU{l.key}</Badge>
                  <Label className="flex-1">Horas antes da consulta</Label>
                  <Input
                    type="number"
                    min={1}
                    value={wu[l.hKey]}
                    onChange={(e) => setWu((p) => ({ ...p, [l.hKey]: e.target.value }))}
                    className="w-20"
                  />
                </div>
                <Textarea
                  rows={3}
                  value={prompts[l.pKey]}
                  onChange={(e) => setPrompts((p) => ({ ...p, [l.pKey]: e.target.value }))}
                  placeholder={`Mensagem WU${l.key}...`}
                />
              </div>
            ))}
            <Button onClick={() => save.mutate()} disabled={save.isPending} className="w-full">
              {save.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Salvar
            </Button>
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}

// =================================================================
// Sheet: Escalação Humana
// =================================================================

function EscalationSheet({
  open,
  onClose,
  agentId,
}: {
  open: boolean;
  onClose: () => void;
  agentId: string;
}) {
  const qc = useQueryClient();
  const getCfg = useServerFn(getAgentEscalation);
  const saveCfg = useServerFn(saveAgentEscalation);

  const { data, isLoading } = useQuery({
    queryKey: ["escalation-config", agentId],
    queryFn: () => getCfg({ data: { agentId } }),
    enabled: open,
  });

  const [ativo, setAtivo] = useState(false);
  const [evUrl, setEvUrl] = useState("");
  const [evInstance, setEvInstance] = useState("");
  const [evKey, setEvKey] = useState("");
  const [grupo, setGrupo] = useState("");

  useEffect(() => {
    if (open && data) {
      setAtivo(data.ativo ?? false);
      setEvUrl(data.evolution_url ?? "");
      setEvInstance(data.evolution_instance ?? "");
      setGrupo(data.grupo_alerta ?? "");
    }
  }, [open, data]);

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
      onClose();
    },
  });

  return (
    <Sheet open={open} onOpenChange={(v) => !v && onClose()}>
      <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-md">
        <SheetHeader>
          <SheetTitle>Escalada Humana</SheetTitle>
        </SheetHeader>
        {isLoading ? (
          <div className="py-4"><Loader2 className="h-5 w-5 animate-spin" /></div>
        ) : (
          <div className="space-y-4 py-4">
            <p className="text-xs text-muted-foreground">
              Quando o agente escalar para humano, adiciona a tag "IA Desligada" no Helena e envia alerta no grupo Evolution.
            </p>
            <ToggleRow label="Ativar escalada humana" value={ativo} onChange={setAtivo} />
            <div>
              <Label>URL Evolution API</Label>
              <Input value={evUrl} onChange={(e) => setEvUrl(e.target.value)} placeholder="https://evolution.meudominio.com.br" className="mt-1" />
            </div>
            <div>
              <Label>Instância Evolution</Label>
              <Input value={evInstance} onChange={(e) => setEvInstance(e.target.value)} placeholder="minha-instancia" className="mt-1" />
            </div>
            <div>
              <Label>API Key Evolution</Label>
              {data?.key_last4 && !evKey && (
                <p className="text-xs text-muted-foreground mb-1">Atual: ••••{data.key_last4}</p>
              )}
              <Input type="password" value={evKey} onChange={(e) => setEvKey(e.target.value)} placeholder="cole a API key" className="mt-1" />
            </div>
            <div>
              <Label>JID do grupo de alerta</Label>
              <Input value={grupo} onChange={(e) => setGrupo(e.target.value)} placeholder="120363...@g.us" className="mt-1" />
              <p className="mt-1 text-[11px] text-muted-foreground">
                Copie o JID do grupo no Evolution (ex: 120363123456789@g.us)
              </p>
            </div>
            <Button onClick={() => save.mutate()} disabled={save.isPending} className="w-full">
              {save.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Salvar
            </Button>
          </div>
        )}
      </SheetContent>
    </Sheet>
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

function PlaceholderSheet({
  open,
  onClose,
  title,
  body,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  body: string;
}) {
  return (
    <Sheet open={open} onOpenChange={(v) => !v && onClose()}>
      <SheetContent side="right" className="w-full sm:max-w-md">
        <SheetHeader>
          <SheetTitle>{title}</SheetTitle>
        </SheetHeader>
        <div className="py-4">
          <p className="text-sm text-muted-foreground">{body}</p>
        </div>
      </SheetContent>
    </Sheet>
  );
}
