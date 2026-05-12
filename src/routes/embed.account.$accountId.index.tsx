import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import {
  Bot,
  Power,
  RotateCcw,
  Play,
  GraduationCap,
  Settings,
  MessageCircle,
  Headphones,
  Users,
  Globe,
  KeyRound,
  Loader2,
  Check,
  Copy,
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

export const Route = createFileRoute("/embed/account/$accountId/")({
  component: EmbedHome,
});

type SheetKey =
  | null
  | "training"
  | "settings"
  | "whatsapp"
  | "audio"
  | "queues"
  | "webchat"
  | "secrets";

function EmbedHome() {
  const { accountId } = Route.useParams();
  const navigate = useNavigate();
  void navigate;
  const qc = useQueryClient();
  const fetchAgent = useServerFn(getAgent);
  const updateAgentFn = useServerFn(updateAgent);

  const [openSheet, setOpenSheet] = useState<SheetKey>(null);

  const { data, isLoading } = useQuery({
    queryKey: ["agent", accountId],
    queryFn: () => fetchAgent({ data: { accountId } }),
  });

  const toggleAtivo = useMutation({
    mutationFn: (ativo: boolean) =>
      updateAgentFn({ data: { accountId, ativo } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["agent", accountId] }),
  });

  if (isLoading || !data?.agent) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-muted/30">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const agent = data.agent;
  const ativo = agent.ativo;

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
            <span className="text-xs text-muted-foreground">{ativo ? "ATIVO" : "INATIVO"}</span>
            <Switch
              checked={ativo}
              onCheckedChange={(v) => toggleAtivo.mutate(v)}
            />
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-3xl space-y-4 px-4 py-4">
        {/* Card boas-vindas */}
        <Card className="overflow-hidden border-0 bg-gradient-to-br from-primary/10 via-primary/5 to-background p-5">
          <div className="flex items-start gap-3">
            <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-primary text-primary-foreground">
              <Bot className="h-6 w-6" />
            </div>
            <div className="flex-1">
              <h2 className="text-base font-semibold">{agent.nome}</h2>
              <p className="text-sm text-muted-foreground">
                {ativo
                  ? "Pronto para atender seus clientes 24/7."
                  : "Ative o agente para começar a atender."}
              </p>
            </div>
          </div>
          <div className="mt-4 flex flex-wrap gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => toggleAtivo.mutate(!ativo)}
            >
              <Power className="mr-1.5 h-3.5 w-3.5" />
              {ativo ? "Desativar" : "Ativar"}
            </Button>
            <Button variant="outline" size="sm" disabled>
              <RotateCcw className="mr-1.5 h-3.5 w-3.5" />
              Resetar
            </Button>
            <Button size="sm" disabled>
              <Play className="mr-1.5 h-3.5 w-3.5" />
              Testar
            </Button>
          </div>
        </Card>

        {/* AÇÕES PRINCIPAIS */}
        <section>
          <h3 className="mb-2 px-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            Ações principais
          </h3>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <ActionCard
              icon={<GraduationCap className="h-5 w-5" />}
              title="Treinamentos avançados"
              subtitle="Prompt, base de conhecimento, mídias"
              onClick={() => setOpenSheet("training")}
              accent="bg-blue-500/10 text-blue-600 dark:text-blue-400"
            />
            <ActionCard
              icon={<Settings className="h-5 w-5" />}
              title="Configurações"
              subtitle="Modelo de IA, voz, comportamento"
              onClick={() => setOpenSheet("settings")}
              accent="bg-purple-500/10 text-purple-600 dark:text-purple-400"
            />
          </div>
        </section>

        {/* CANAIS */}
        <section>
          <h3 className="mb-2 px-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            Canais de atendimento
          </h3>
          <div className="grid grid-cols-2 gap-3">
            <ChannelCard
              icon={<MessageCircle className="h-5 w-5" />}
              title="WhatsApp"
              status={data.whatsapp?.status === "conectado" ? "Conectado" : "Desconectado"}
              statusColor={data.whatsapp?.status === "conectado" ? "emerald" : "zinc"}
              onClick={() => setOpenSheet("whatsapp")}
            />
            <ChannelCard
              icon={<Headphones className="h-5 w-5" />}
              title="Áudio"
              status={data.audio?.habilitado ? "Ativo" : "Inativo"}
              statusColor={data.audio?.habilitado ? "emerald" : "zinc"}
              onClick={() => setOpenSheet("audio")}
            />
            <ChannelCard
              icon={<Users className="h-5 w-5" />}
              title="Filas"
              status="Configurar"
              statusColor="zinc"
              onClick={() => setOpenSheet("queues")}
            />
            <ChannelCard
              icon={<Globe className="h-5 w-5" />}
              title="Web Chat"
              status="BETA"
              statusColor="amber"
              onClick={() => setOpenSheet("webchat")}
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
                <KeyRound className="h-4.5 w-4.5" />
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
            </div>
          </Card>
        </section>

        <p className="pt-2 text-center text-[10px] text-muted-foreground">
          Conta {accountId} · webhook: <code>/api/public/webhook/helena/{agent.id}</code>
        </p>
      </main>

      {/* SHEETS */}
      <TrainingSheet
        open={openSheet === "training"}
        onClose={() => setOpenSheet(null)}
        accountId={accountId}
        initialPrompt={agent.system_prompt ?? ""}
        initialNome={agent.nome}
      />
      <SettingsSheet
        open={openSheet === "settings"}
        onClose={() => setOpenSheet(null)}
        accountId={accountId}
        currentModel={agent.llm_model_override ?? data.llm?.default_model ?? ""}
        currentVoice={data.voice?.elevenlabs_voice_id ?? null}
        hasOpenRouter={!!data.secrets?.openrouter_last4}
        hasElevenLabs={!!data.secrets?.elevenlabs_last4}
      />
      <AudioSheet
        open={openSheet === "audio"}
        onClose={() => setOpenSheet(null)}
        accountId={accountId}
        habilitado={!!data.audio?.habilitado}
        transcrever={!!data.audio?.transcrever_in}
        responder={!!data.audio?.responder_out}
      />
      <SecretsSheet
        open={openSheet === "secrets"}
        onClose={() => setOpenSheet(null)}
        accountId={accountId}
        last4={{
          openrouter: data.secrets?.openrouter_last4 ?? null,
          elevenlabs: data.secrets?.elevenlabs_last4 ?? null,
          groq: data.secrets?.groq_last4 ?? null,
        }}
      />
      <PlaceholderSheet
        open={openSheet === "whatsapp"}
        onClose={() => setOpenSheet(null)}
        title="WhatsApp"
        body="Em breve: conexão Evolution API por conta com QR Code."
      />
      <PlaceholderSheet
        open={openSheet === "queues"}
        onClose={() => setOpenSheet(null)}
        title="Filas de transferência"
        body="Em breve: cadastro de filas que o agente pode escalar."
      />
      <PlaceholderSheet
        open={openSheet === "webchat"}
        onClose={() => setOpenSheet(null)}
        title="Web Chat (BETA)"
        body="Em breve: widget de chat para incorporar no site."
      />
    </div>
  );
}

// =================================================================
// Sub-components
// =================================================================

function ActionCard({
  icon,
  title,
  subtitle,
  onClick,
  accent,
}: {
  icon: React.ReactNode;
  title: string;
  subtitle: string;
  onClick: () => void;
  accent: string;
}) {
  return (
    <button
      onClick={onClick}
      className="rounded-xl border bg-card p-4 text-left transition-all hover:-translate-y-0.5 hover:shadow-md"
    >
      <div className={`mb-3 inline-flex h-10 w-10 items-center justify-center rounded-lg ${accent}`}>
        {icon}
      </div>
      <p className="text-sm font-semibold">{title}</p>
      <p className="text-xs text-muted-foreground">{subtitle}</p>
    </button>
  );
}

function ChannelCard({
  icon,
  title,
  status,
  statusColor,
  onClick,
}: {
  icon: React.ReactNode;
  title: string;
  status: string;
  statusColor: "emerald" | "zinc" | "amber";
  onClick: () => void;
}) {
  const colors: Record<string, string> = {
    emerald: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400",
    zinc: "bg-zinc-500/15 text-zinc-600 dark:text-zinc-400",
    amber: "bg-amber-500/15 text-amber-700 dark:text-amber-400",
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
      <Badge variant="outline" className={`mt-1 border-0 ${colors[statusColor]}`}>
        {status}
      </Badge>
    </button>
  );
}

// ---- TRAINING ----
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
          <SheetTitle>Treinamentos avançados</SheetTitle>
        </SheetHeader>
        <div className="space-y-4 py-4">
          <div>
            <Label htmlFor="nome">Nome do agente</Label>
            <Input id="nome" value={nome} onChange={(e) => setNome(e.target.value)} />
          </div>
          <div>
            <Label htmlFor="prompt">Prompt do agente</Label>
            <Textarea
              id="prompt"
              rows={20}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="Você é um assistente virtual para uma clínica..."
            />
          </div>
          <Button onClick={() => m.mutate()} disabled={m.isPending} className="w-full">
            {m.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            Salvar
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  );
}

// ---- SETTINGS ----
function SettingsSheet({
  open,
  onClose,
  accountId,
  currentModel,
  currentVoice,
  hasOpenRouter,
  hasElevenLabs,
}: {
  open: boolean;
  onClose: () => void;
  accountId: string;
  currentModel: string;
  currentVoice: string | null;
  hasOpenRouter: boolean;
  hasElevenLabs: boolean;
}) {
  const qc = useQueryClient();
  const updateLlm = useServerFn(updateLlmConfig);
  const updateVoice = useServerFn(updateVoiceConfig);
  const listModels = useServerFn(listOpenRouterModels);
  const listVoices = useServerFn(listElevenLabsVoices);

  const [model, setModel] = useState(currentModel);
  const [voiceId, setVoiceId] = useState(currentVoice ?? "");

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
          <SheetTitle>Configurações</SheetTitle>
        </SheetHeader>
        <div className="space-y-4 py-4">
          <div>
            <Label>Modelo (OpenRouter)</Label>
            {!hasOpenRouter ? (
              <p className="rounded-md border bg-muted/40 p-3 text-xs text-muted-foreground">
                Cadastre sua chave OpenRouter em "Conexões e custos" para listar os modelos.
              </p>
            ) : models.isLoading ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <select
                className="w-full rounded-md border bg-background p-2 text-sm"
                value={model}
                onChange={(e) => setModel(e.target.value)}
              >
                <option value="">— escolher —</option>
                {(models.data?.models ?? []).map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name} ({m.id})
                  </option>
                ))}
              </select>
            )}
          </div>

          <div>
            <Label>Voz (ElevenLabs)</Label>
            {!hasElevenLabs ? (
              <p className="rounded-md border bg-muted/40 p-3 text-xs text-muted-foreground">
                Cadastre sua chave ElevenLabs em "Conexões e custos" para escolher uma voz.
              </p>
            ) : voices.isLoading ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <select
                className="w-full rounded-md border bg-background p-2 text-sm"
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

          <Button onClick={() => save.mutate()} disabled={save.isPending} className="w-full">
            {save.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            Salvar
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  );
}

// ---- AUDIO ----
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
          <ToggleRow
            label="Transcrever áudios recebidos (Groq Whisper)"
            value={t}
            onChange={setT}
            disabled={!h}
          />
          <ToggleRow
            label="Responder com voz (ElevenLabs TTS)"
            value={r}
            onChange={setR}
            disabled={!h}
          />
          <Button onClick={() => m.mutate()} disabled={m.isPending} className="w-full">
            {m.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            Salvar
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  );
}

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

// ---- SECRETS ----
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
    (s, r) => s + Number(r.cost_usd ?? 0),
    0
  );

  async function saveOR() {
    if (!orKey) return;
    await setOR({ data: { accountId, apiKey: orKey } });
    toast.success("Chave OpenRouter salva.");
    setOrKey("");
    qc.invalidateQueries({ queryKey: ["agent", accountId] });
  }
  async function saveEL() {
    if (!elKey) return;
    await setEL({ data: { accountId, apiKey: elKey } });
    toast.success("Chave ElevenLabs salva.");
    setElKey("");
    qc.invalidateQueries({ queryKey: ["agent", accountId] });
  }
  async function saveGroq() {
    if (!grKey) return;
    await setGroq({ data: { accountId, apiKey: grKey } });
    toast.success("Chave Groq salva.");
    setGrKey("");
    qc.invalidateQueries({ queryKey: ["agent", accountId] });
  }
  async function doTest() {
    setTesting(true);
    setTestResult(null);
    try {
      const r = await test({ data: { accountId } });
      if (r.ok) {
        setTestResult(
          `✅ OK${r.label ? ` · ${r.label}` : ""} · usado $${(r.usage ?? 0).toFixed(4)}${r.limit ? ` / $${r.limit}` : ""}`
        );
      } else {
        setTestResult(`❌ ${r.error}`);
      }
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
            help={
              <a
                className="text-primary underline"
                href="https://openrouter.ai/keys"
                target="_blank"
                rel="noreferrer"
              >
                openrouter.ai/keys
              </a>
            }
            current={last4.openrouter}
            value={orKey}
            onChange={setOrKey}
            onSave={saveOR}
            extra={
              last4.openrouter ? (
                <Button variant="outline" size="sm" onClick={doTest} disabled={testing}>
                  {testing ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : <Check className="mr-1 h-3 w-3" />}
                  Testar
                </Button>
              ) : null
            }
            note={testResult}
          />
          <KeyBlock
            label="ElevenLabs"
            help={
              <a
                className="text-primary underline"
                href="https://elevenlabs.io/app/settings/api-keys"
                target="_blank"
                rel="noreferrer"
              >
                elevenlabs.io/app/settings/api-keys
              </a>
            }
            current={last4.elevenlabs}
            value={elKey}
            onChange={setElKey}
            onSave={saveEL}
          />
          <KeyBlock
            label="Groq (opcional, transcrição de áudio)"
            help={
              <a
                className="text-primary underline"
                href="https://console.groq.com/keys"
                target="_blank"
                rel="noreferrer"
              >
                console.groq.com/keys
              </a>
            }
            current={last4.groq}
            value={grKey}
            onChange={setGrKey}
            onSave={saveGroq}
          />

          <div className="rounded-md border p-3">
            <p className="text-xs uppercase text-muted-foreground">Custo estimado (30 dias)</p>
            <p className="mt-1 text-2xl font-semibold">${totalUsd.toFixed(4)}</p>
            <p className="text-[11px] text-muted-foreground">
              Cada chamada de LLM/TTS/STT é registrada por conta em <code>agent_runs</code>.
            </p>
          </div>
        </div>
      </SheetContent>
    </Sheet>
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
          <Badge variant="outline" className="border-emerald-500/40 text-emerald-700">
            ••{current}
          </Badge>
        ) : (
          <Badge variant="outline">não configurado</Badge>
        )}
      </div>
      <p className="text-[11px] text-muted-foreground">Obter em: {help}</p>
      <div className="flex gap-2">
        <Input
          type="password"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="cole a chave aqui"
        />
        <Button onClick={onSave} disabled={!value}>
          Salvar
        </Button>
        {extra}
      </div>
      {note ? <p className="text-xs">{note}</p> : null}
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
      <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-md">
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

// silence unused import warning
void Copy;
