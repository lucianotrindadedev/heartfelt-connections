import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState, useEffect } from "react";
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
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
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
      <div className="flex min-h-screen items-center justify-center bg-muted/30">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const agent = data.agent;
  const ativo = agent.ativo as boolean;
  const agentId = agent.id as string;

  return (
    <div className="min-h-screen bg-muted/30">
      {/* Top bar */}
      <header className="sticky top-0 z-10 border-b bg-background/95 backdrop-blur">
        <div className="mx-auto flex max-w-3xl items-center justify-between gap-3 px-4 py-3">
          <div className="flex items-center gap-2">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary text-primary-foreground">
              <Bot className="h-5 w-5" />
            </div>
            <div className="leading-tight">
              <p className="text-sm font-semibold">Assistente Virtual</p>
              <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                <span
                  className={`inline-block h-1.5 w-1.5 rounded-full ${ativo ? "bg-emerald-500" : "bg-zinc-400"}`}
                />
                {ativo ? "Online" : "Inativo"}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Badge
              variant="outline"
              className={
                ativo
                  ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
                  : "border-zinc-400/40 bg-zinc-500/10 text-zinc-600"
              }
            >
              {ativo ? "ASSISTENTE: ATIVO" : "ASSISTENTE: PAUSADO"}
            </Badge>
            <Switch
              checked={ativo}
              onCheckedChange={(v) => toggleAtivo.mutate(v)}
            />
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-3xl space-y-5 px-4 py-5">
        {/* Status Card */}
        <Card className="overflow-hidden border-0 bg-gradient-to-br from-primary/10 via-primary/5 to-background p-5">
          <div className="flex items-start gap-3">
            <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-primary text-primary-foreground">
              <Bot className="h-7 w-7" />
            </div>
            <div className="flex-1 min-w-0">
              <h2 className="text-base font-semibold truncate">{agent.nome as string}</h2>
              <p className="text-sm text-muted-foreground">
                {ativo
                  ? "Pronto para atender seus clientes 24/7."
                  : "Ative o agente para começar a atender."}
              </p>
            </div>
          </div>
          <div className="mt-4 flex flex-wrap gap-2">
            <Button
              variant={ativo ? "outline" : "default"}
              size="sm"
              onClick={() => toggleAtivo.mutate(!ativo)}
              disabled={toggleAtivo.isPending}
            >
              <Power className="mr-1.5 h-3.5 w-3.5" />
              {ativo ? "Pausar assistente" : "Ativar assistente"}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                if (confirm("Isso apagará TODO o histórico de conversas. Continuar?")) {
                  doReset.mutate();
                }
              }}
              disabled={doReset.isPending}
            >
              {doReset.isPending ? (
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
              ) : (
                <RotateCcw className="mr-1.5 h-3.5 w-3.5" />
              )}
              Resetar assistente
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                const url = `/api/public/webhook/helena/${accountId}`;
                void navigator.clipboard.writeText(url);
                toast.success("URL do webhook copiada!");
              }}
            >
              <Play className="mr-1.5 h-3.5 w-3.5" />
              Webhook URL
            </Button>
          </div>
        </Card>

        {/* AÇÕES PRINCIPAIS */}
        <section>
          <SectionTitle>Ações principais</SectionTitle>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <ActionCard
              icon={<GraduationCap className="h-5 w-5" />}
              title="Base de conhecimento"
              subtitle="Prompt, personalidade e instruções"
              label="Configurar treinamentos"
              onClick={() => setOpenSheet("training")}
              accent="bg-blue-500/10 text-blue-600 dark:text-blue-400"
            />
            <ActionCard
              icon={<Settings className="h-5 w-5" />}
              title="Personalize seu assistente"
              subtitle="Modelo de IA, voz, debounce"
              label="Configurar"
              onClick={() => setOpenSheet("settings")}
              accent="bg-purple-500/10 text-purple-600 dark:text-purple-400"
              badge={!data.secrets?.openrouter_last4 ? "⚠ Pendente" : undefined}
            />
          </div>
        </section>

        {/* CANAIS E INTEGRAÇÕES */}
        <section>
          <SectionTitle>Canais e integrações</SectionTitle>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <IntegrationCard
              icon={<MessageCircle className="h-5 w-5" />}
              title="WhatsApp"
              status="Helena CRM"
              statusColor="emerald"
              onClick={() => setOpenSheet("whatsapp")}
              accountId={accountId}
            />
            <IntegrationCard
              icon={<Headphones className="h-5 w-5" />}
              title="Áudio"
              status={data.audio?.habilitado ? "Ativo" : "Inativo"}
              statusColor={data.audio?.habilitado ? "emerald" : "zinc"}
              onClick={() => setOpenSheet("audio")}
              accountId={accountId}
            />
            <GoogleCalendarCard
              accountId={accountId}
              onClick={() => setOpenSheet("google-calendar")}
            />
            <ClinicorpCard
              accountId={accountId}
              onClick={() => setOpenSheet("clinicorp")}
            />
            <ClinupCard
              accountId={accountId}
              onClick={() => setOpenSheet("clinup")}
            />
            <IntegrationCard
              icon={<Bell className="h-5 w-5" />}
              title="Follow-up"
              status="Automático"
              statusColor="zinc"
              onClick={() => setOpenSheet("followup")}
              accountId={accountId}
            />
            <IntegrationCard
              icon={<Flame className="h-5 w-5" />}
              title="Warm-up"
              status="Consultas"
              statusColor="zinc"
              onClick={() => setOpenSheet("warmup")}
              accountId={accountId}
            />
            <IntegrationCard
              icon={<UserX className="h-5 w-5" />}
              title="Escalada humana"
              status="Evolution"
              statusColor="zinc"
              onClick={() => setOpenSheet("escalation")}
              accountId={accountId}
            />
          </div>
        </section>

        {/* CONEXÕES E CUSTOS */}
        <section>
          <Card
            className="cursor-pointer p-4 transition-colors hover:bg-accent/50"
            onClick={() => setOpenSheet("secrets")}
          >
            <div className="flex items-center gap-3">
              <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-amber-500/10 text-amber-600">
                <KeyRound className="h-4 w-4" />
              </div>
              <div className="flex-1">
                <p className="text-sm font-medium">Conexões e custos</p>
                <p className="text-xs text-muted-foreground">
                  OpenRouter
                  {data.secrets?.openrouter_last4 ? ` ••${data.secrets.openrouter_last4}` : " — não configurado"}
                  {" · "}
                  ElevenLabs
                  {data.secrets?.elevenlabs_last4 ? ` ••${data.secrets.elevenlabs_last4}` : " — não configurado"}
                </p>
              </div>
              {!data.secrets?.openrouter_last4 && (
                <AlertCircle className="h-4 w-4 text-amber-500 shrink-0" />
              )}
            </div>
          </Card>
        </section>

        <p className="pt-2 text-center text-[10px] text-muted-foreground">
          Conta {accountId} · agente {agentId.slice(0, 8)}
        </p>
      </main>

      {/* SHEETS */}
      <TrainingSheet
        open={openSheet === "training"}
        onClose={() => setOpenSheet(null)}
        accountId={accountId}
        initialPrompt={(agent.system_prompt as string | null) ?? ""}
        initialNome={(agent.nome as string) ?? ""}
      />
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
  accent,
  badge,
}: {
  icon: React.ReactNode;
  title: string;
  subtitle: string;
  label: string;
  onClick: () => void;
  accent: string;
  badge?: string;
}) {
  return (
    <button
      onClick={onClick}
      className="group rounded-xl border bg-card p-4 text-left transition-all hover:-translate-y-0.5 hover:shadow-md"
    >
      <div className="mb-3 flex items-start justify-between">
        <div className={`inline-flex h-10 w-10 items-center justify-center rounded-lg ${accent}`}>
          {icon}
        </div>
        {badge && (
          <Badge variant="outline" className="border-amber-400/40 bg-amber-500/10 text-amber-700 text-[10px]">
            {badge}
          </Badge>
        )}
      </div>
      <p className="text-sm font-semibold">{title}</p>
      <p className="mb-3 text-xs text-muted-foreground">{subtitle}</p>
      <p className="text-xs font-medium text-primary group-hover:underline">
        {label} →
      </p>
    </button>
  );
}

function IntegrationCard({
  icon,
  title,
  status,
  statusColor,
  onClick,
}: {
  icon: React.ReactNode;
  title: string;
  status: string;
  statusColor: "emerald" | "zinc" | "amber" | "blue";
  onClick: () => void;
  accountId: string;
}) {
  const colors: Record<string, string> = {
    emerald: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400",
    zinc: "bg-zinc-500/15 text-zinc-600 dark:text-zinc-400",
    amber: "bg-amber-500/15 text-amber-700 dark:text-amber-400",
    blue: "bg-blue-500/15 text-blue-700 dark:text-blue-400",
  };
  return (
    <button
      onClick={onClick}
      className="rounded-xl border bg-card p-4 text-left transition-all hover:-translate-y-0.5 hover:shadow-md"
    >
      <div className="mb-3 inline-flex h-9 w-9 items-center justify-center rounded-lg bg-muted">
        {icon}
      </div>
      <p className="text-sm font-semibold">{title}</p>
      <Badge variant="outline" className={`mt-1 border-0 text-[10px] ${colors[statusColor]}`}>
        {status}
      </Badge>
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
      className="rounded-xl border bg-card p-4 text-left transition-all hover:-translate-y-0.5 hover:shadow-md"
    >
      <div className="mb-3 inline-flex h-9 w-9 items-center justify-center rounded-lg bg-muted">
        <Calendar className="h-5 w-5" />
      </div>
      <p className="text-sm font-semibold">Google Calendar</p>
      <Badge
        variant="outline"
        className={`mt-1 border-0 text-[10px] ${data?.connected ? "bg-emerald-500/15 text-emerald-700" : "bg-zinc-500/15 text-zinc-600"}`}
      >
        {data?.connected ? "Conectado" : "Desconectado"}
      </Badge>
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
      className="rounded-xl border bg-card p-4 text-left transition-all hover:-translate-y-0.5 hover:shadow-md"
    >
      <div className="mb-3 inline-flex h-9 w-9 items-center justify-center rounded-lg bg-muted">
        <Stethoscope className="h-5 w-5" />
      </div>
      <p className="text-sm font-semibold">Clinicorp</p>
      <Badge
        variant="outline"
        className={`mt-1 border-0 text-[10px] ${data?.ativo ? "bg-emerald-500/15 text-emerald-700" : "bg-zinc-500/15 text-zinc-600"}`}
      >
        {data?.ativo ? "Ativo" : "Inativo"}
      </Badge>
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
      className="rounded-xl border bg-card p-4 text-left transition-all hover:-translate-y-0.5 hover:shadow-md"
    >
      <div className="mb-3 inline-flex h-9 w-9 items-center justify-center rounded-lg bg-muted">
        <ClipboardList className="h-5 w-5" />
      </div>
      <p className="text-sm font-semibold">Clinup</p>
      <Badge
        variant="outline"
        className={`mt-1 border-0 text-[10px] ${data?.ativo ? "bg-emerald-500/15 text-emerald-700" : "bg-zinc-500/15 text-zinc-600"}`}
      >
        {data?.ativo ? "Ativo" : "Inativo"}
      </Badge>
    </button>
  );
}

// =================================================================
// Sheet: Training
// =================================================================

function TrainingSheet({
  open,
  onClose,
  accountId,
  initialPrompt,
  initialNome,
}: {
  open: boolean;
  onClose: () => void;
  accountId: string;
  initialPrompt: string;
  initialNome: string;
}) {
  const qc = useQueryClient();
  const update = useServerFn(updateAgent);
  const [prompt, setPrompt] = useState(initialPrompt);
  const [nome, setNome] = useState(initialNome);

  useEffect(() => {
    if (open) {
      setPrompt(initialPrompt);
      setNome(initialNome);
    }
  }, [open, initialPrompt, initialNome]);

  const m = useMutation({
    mutationFn: () => update({ data: { accountId, system_prompt: prompt, nome } }),
    onSuccess: () => {
      toast.success("Treinamento salvo.");
      qc.invalidateQueries({ queryKey: ["agent", accountId] });
      onClose();
    },
  });

  return (
    <Sheet open={open} onOpenChange={(v) => !v && onClose()}>
      <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-xl">
        <SheetHeader>
          <SheetTitle>Base de conhecimento</SheetTitle>
        </SheetHeader>
        <div className="space-y-4 py-4">
          <div>
            <Label htmlFor="nome">Nome do agente</Label>
            <Input id="nome" value={nome} onChange={(e) => setNome(e.target.value)} className="mt-1" />
          </div>
          <div>
            <Label htmlFor="prompt">Prompt do agente</Label>
            <Textarea
              id="prompt"
              rows={20}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="Você é um assistente virtual para uma clínica odontológica..."
              className="mt-1 font-mono text-xs"
            />
          </div>
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
