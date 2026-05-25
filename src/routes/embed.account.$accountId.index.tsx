import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { helenaWebhookUrl } from "@/lib/app-base-url";
import { useServerFn } from "@tanstack/react-start";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState, useEffect, useRef, useCallback, useMemo } from "react";
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
  Plus,
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
  listGoogleCalendarsFn,
  selectGoogleCalendarFn,
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
import {
  requestPromptEdit,
  applyPromptEdit,
  listAiMagicHistory,
  getAiMagicSuggestions,
  listPromptVersions,
  restorePromptVersion,
} from "@/lib/ai-magic.functions";
import {
  runTrainerTurn,
  requestTrainerImprovement,
} from "@/lib/trainer.functions";
import {
  addUrlDocument,
  addPdfDocument,
  listKnowledgeDocuments,
  deleteKnowledgeDocument,
} from "@/lib/knowledge.functions";
import {
  listFollowupSteps,
  createFollowupStep,
  updateFollowupStep,
  deleteFollowupStep,
} from "@/lib/followup-sequence.functions";
import {
  uploadAgentMedia,
  listAgentMedia,
  updateAgentMedia,
  deleteAgentMedia,
} from "@/lib/media.functions";
import { lineDiff, diffChangeBlocks, diffStats, type DiffOp } from "@/lib/text-diff";

interface AccountSearch {
  picked?: string;
}

export const Route = createFileRoute("/embed/account/$accountId/")({
  validateSearch: (s: Record<string, unknown>): AccountSearch => ({
    picked: (s.picked as string | undefined) ?? undefined,
  }),
  component: EmbedHome,
});

type SheetKey =
  | null
  | "training"
  | "settings"
  | "followup"
  | "warmup"
  | "escalation";

// =================================================================
// Blocker: conta não cadastrada
// =================================================================
function AccountNotRegisteredBlocker({ accountId }: { accountId: string }) {
  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-slate-900/90 p-6 backdrop-blur-sm">
      <div className="w-full max-w-md overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl">
        {/* Header colorido */}
        <div className="bg-gradient-to-br from-amber-400 to-orange-500 px-6 py-8 text-center">
          <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-white/20 backdrop-blur-sm">
            <AlertCircle className="h-8 w-8 text-white" />
          </div>
          <h1 className="mt-4 text-xl font-bold text-white">Agente não disponível</h1>
          <p className="mt-1 text-sm text-white/90">
            Esta conta ainda não está cadastrada na plataforma Sarai.
          </p>
        </div>

        {/* Conteúdo */}
        <div className="space-y-4 px-6 py-6">
          <div className="rounded-lg border border-slate-200 bg-slate-50 p-4">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">
              ID da conta solicitada
            </p>
            <p className="mt-1 break-all font-mono text-xs text-slate-700">{accountId}</p>
          </div>

          <div className="space-y-2 text-sm text-slate-600">
            <p>
              O assistente virtual ainda não foi liberado para esta conta. Para ativar:
            </p>
            <ol className="list-decimal space-y-1 pl-5 text-xs">
              <li>Entre em contato com o suporte Sarai</li>
              <li>Envie o ID acima para liberação</li>
              <li>Após o cadastro, recarregue esta página</li>
            </ol>
          </div>

          <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800">
            <strong className="font-semibold">Importante:</strong> sem cadastro prévio,
            nenhum agente é provisionado para esta conta — esta é uma medida de segurança.
          </div>
        </div>
      </div>
    </div>
  );
}

// =================================================================
// Seletor inline quando a conta tem múltiplos agentes Sarai irmãos
// (mesmo helena_account_id). Renderizado direto no embed.
// =================================================================
function MultiAgentSelector({
  accounts,
  onPick,
}: {
  accounts: { id: string; nome: string }[];
  onPick: (accountId: string) => void;
}) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-6">
      <div className="w-full max-w-sm">
        <div className="mb-6 text-center">
          <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-primary/10">
            <Bot className="h-6 w-6 text-primary" />
          </div>
          <h1 className="text-lg font-semibold">Selecionar agente</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Esta conta do Helena tem {accounts.length} agentes configurados.
            Selecione qual deseja gerenciar.
          </p>
        </div>
        <div className="space-y-2">
          {accounts.map((a, i) => (
            <button
              key={a.id}
              onClick={() => onPick(a.id)}
              className="flex w-full items-center justify-between rounded-xl border bg-card p-4 text-left transition hover:bg-accent/50 hover:border-primary/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
            >
              <div className="flex items-center gap-3">
                <div className="flex h-8 w-8 items-center justify-center rounded-full bg-primary/10 text-xs font-bold text-primary">
                  {i + 1}
                </div>
                <div>
                  <p className="font-medium text-sm">{a.nome}</p>
                  <p className="text-[11px] font-mono text-muted-foreground">{a.id}</p>
                </div>
              </div>
              <ArrowRight className="h-4 w-4 text-muted-foreground shrink-0" />
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function EmbedHome() {
  const { accountId } = Route.useParams();
  const { picked } = Route.useSearch();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const fetchAgent = useServerFn(getAgent);
  const updateAgentFn = useServerFn(updateAgent);
  const resetAgentFn = useServerFn(resetAgent);

  const [openSheet, setOpenSheet] = useState<SheetKey>(null);

  const { data, isLoading } = useQuery({
    queryKey: ["agent", accountId],
    queryFn: () => fetchAgent({ data: { accountId } }),
    retry: false,
  });

  // IMPORTANTE: TODOS os hooks (useMutation incluso) precisam ser chamados
  // ANTES de qualquer early return — senão violamos as Rules of Hooks e o
  // React lança o erro #300 ("Rendered fewer hooks than expected").
  const toggleAtivo = useMutation({
    mutationFn: (ativo: boolean) => updateAgentFn({ data: { accountId, ativo } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["agent", accountId] }),
  });

  const doReset = useMutation({
    mutationFn: () => {
      const aid = data && data.registered ? (data.agent?.id as string | undefined) : undefined;
      if (!aid) throw new Error("Agente indisponível");
      return resetAgentFn({ data: { agentId: aid } });
    },
    onSuccess: () => {
      toast.success("Histórico do agente limpo.");
      qc.invalidateQueries({ queryKey: ["agent", accountId] });
    },
  });

  // Conta não cadastrada → blocker em tela cheia
  if (data && data.registered === false) {
    return <AccountNotRegisteredBlocker accountId={accountId} />;
  }

  // Múltiplos agentes Sarai sob o mesmo Helena CRM → seletor
  // (a menos que o usuário já tenha escolhido — flag ?picked=1 na URL)
  if (
    data &&
    data.registered &&
    !picked &&
    data.siblings &&
    data.siblings.length > 1
  ) {
    return (
      <MultiAgentSelector
        accounts={data.siblings}
        onPick={(id) =>
          navigate({
            to: "/embed/account/$accountId",
            params: { accountId: id },
            search: { picked: "1" },
          })
        }
      />
    );
  }

  if (isLoading || !data || !data.registered || !data.agent) {
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
        agentId={agentId}
        initialPrompt={(agent.system_prompt as string | null) ?? ""}
        initialNome={(agent.nome as string) ?? ""}
        agentSettings={(agent.settings as Record<string, string> | null) ?? {}}
        configuredIntegrations={data.configured_integrations ?? { clinicorp: false, clinup: false, google_calendar: false }}
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
        configuredIntegrations={data.configured_integrations ?? { clinicorp: false, clinup: false, google_calendar: false }}
        secretsLast4={{
          openrouter: (data.secrets?.openrouter_last4 as string | null) ?? null,
          elevenlabs: (data.secrets?.elevenlabs_last4 as string | null) ?? null,
        }}
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
              onClick={() => { void navigator.clipboard.writeText(helenaWebhookUrl(accountId)); toast.success("URL do webhook copiada!"); }}
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

        {/* ── Aviso enxuto: OpenRouter obrigatório ── */}
        {!data.secrets?.openrouter_last4 && (
          <section>
            <button
              onClick={() => setOpenSheet("settings")}
              className="group w-full overflow-hidden rounded-2xl border border-amber-300/70 bg-gradient-to-r from-amber-50 to-orange-50 p-4 text-left shadow-sm transition-all duration-200 hover:-translate-y-0.5 hover:shadow-lg hover:shadow-amber-500/10"
            >
              <div className="flex items-center gap-3">
                <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-amber-400 to-orange-500 text-white shadow-md shadow-amber-500/30">
                  <AlertCircle className="h-5 w-5" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-semibold text-foreground">Configure o OpenRouter para ativar o agente</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    Sem a chave OpenRouter o assistente não responde. Configure em <strong>Personalize o Assistente → Integrações</strong>.
                  </p>
                </div>
                <ArrowRight className="h-4 w-4 shrink-0 text-amber-600 transition-transform group-hover:translate-x-1" />
              </div>
            </button>
          </section>
        )}

        <p className="pb-2 text-center text-[10px] text-muted-foreground/60">
          {accountId} · {agentId.slice(0, 8)}
        </p>
      </main>

      {/* SHEETS */}
      {/* SecretsSheet movido para dentro do IntegrationsTab (em Personalize o Assistente). */}
    </div>
  );
}

// =================================================================
// Layout helpers
// =================================================================

// =================================================================
// BusinessHoursEditor
// =================================================================

const BH_DAYS = [
  { key: "dom", label: "Domingo" },
  { key: "seg", label: "Segunda-feira" },
  { key: "ter", label: "Terça-feira" },
  { key: "qua", label: "Quarta-feira" },
  { key: "qui", label: "Quinta-feira" },
  { key: "sex", label: "Sexta-feira" },
  { key: "sab", label: "Sábado" },
];

interface DaySchedule {
  active: boolean;
  start: string;
  lunch_start: string;
  lunch_end: string;
  end: string;
}

type WeekSchedule = Record<string, DaySchedule>;

const BH_DEFAULT: WeekSchedule = {
  dom: { active: false, start: "08:00", lunch_start: "12:00", lunch_end: "13:00", end: "18:00" },
  seg: { active: true,  start: "08:00", lunch_start: "12:00", lunch_end: "13:00", end: "18:00" },
  ter: { active: true,  start: "08:00", lunch_start: "12:00", lunch_end: "13:00", end: "18:00" },
  qua: { active: true,  start: "08:00", lunch_start: "12:00", lunch_end: "13:00", end: "18:00" },
  qui: { active: true,  start: "08:00", lunch_start: "12:00", lunch_end: "13:00", end: "18:00" },
  sex: { active: true,  start: "08:00", lunch_start: "12:00", lunch_end: "13:00", end: "18:00" },
  sab: { active: false, start: "08:00", lunch_start: "12:00", lunch_end: "13:00", end: "13:00" },
};

/** Tenta carregar do JSON salvo; se não for JSON, retorna defaults. */
function parseBhJson(jsonStr: string): WeekSchedule {
  if (!jsonStr) return structuredClone(BH_DEFAULT);
  try {
    const parsed = JSON.parse(jsonStr) as Record<string, unknown>;
    if (parsed && typeof parsed === "object" && "seg" in parsed) {
      return { ...structuredClone(BH_DEFAULT), ...parsed } as WeekSchedule;
    }
  } catch { /* not JSON */ }
  return structuredClone(BH_DEFAULT);
}

/** Converte WeekSchedule em string legível para o prompt do agente. */
function bhToHuman(s: WeekSchedule): string {
  const shortName: Record<string, string> = {
    dom: "Dom", seg: "Seg", ter: "Ter", qua: "Qua", qui: "Qui", sex: "Sex", sab: "Sáb",
  };
  const parts: string[] = [];
  let i = 0;
  const active = BH_DAYS.filter((d) => s[d.key]?.active);
  while (i < active.length) {
    const cur = active[i];
    const sch = s[cur.key];
    let j = i + 1;
    while (j < active.length) {
      const nxt = s[active[j].key];
      if (nxt.start === sch.start && nxt.end === sch.end && nxt.lunch_start === sch.lunch_start && nxt.lunch_end === sch.lunch_end) j++;
      else break;
    }
    const range = j - i > 1
      ? `${shortName[cur.key]}–${shortName[active[j - 1].key]}`
      : shortName[cur.key];
    parts.push(`${range}: ${sch.start}–${sch.end} (almoço ${sch.lunch_start}–${sch.lunch_end})`);
    i = j;
  }
  return parts.length ? parts.join(" / ") : "Não definido";
}

function BusinessHoursEditor({
  jsonValue,
  onChange,
}: {
  /** Valor em JSON (business_hours_json). Pode ser string vazia para usar defaults. */
  jsonValue: string;
  /** Chama com (humanReadable, jsonStr) ao mudar */
  onChange: (human: string, json: string) => void;
}) {
  const [schedule, setSchedule] = useState<WeekSchedule>(() => parseBhJson(jsonValue));

  // Sincroniza o valor inicial com o pai uma vez na montagem,
  // para que o varValues do TemplatesModal já tenha o schedule default
  // mesmo que o usuário ainda não tenha tocado em nada.
  const didSyncRef = useRef(false);
  useEffect(() => {
    if (didSyncRef.current) return;
    didSyncRef.current = true;
    onChange(bhToHuman(schedule), JSON.stringify(schedule));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function update(day: string, field: keyof DaySchedule, value: string | boolean) {
    setSchedule((prev) => {
      const next = { ...prev, [day]: { ...prev[day], [field]: value } };
      onChange(bhToHuman(next), JSON.stringify(next));
      return next;
    });
  }

  return (
    <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
      <table className="w-full min-w-[540px] text-xs">
        <thead>
          <tr className="border-b border-slate-100 bg-slate-50">
            <th className="px-3 py-2.5 text-left font-semibold text-slate-600 w-32">Dia da semana</th>
            <th className="px-3 py-2.5 text-center font-semibold text-slate-600 w-16">Ativo</th>
            <th className="px-3 py-2.5 text-center font-semibold text-slate-600">Início</th>
            <th className="px-3 py-2.5 text-center font-semibold text-slate-600">Almoço início</th>
            <th className="px-3 py-2.5 text-center font-semibold text-slate-600">Almoço fim</th>
            <th className="px-3 py-2.5 text-center font-semibold text-slate-600">Fim</th>
          </tr>
        </thead>
        <tbody>
          {BH_DAYS.map((d, idx) => {
            const row = schedule[d.key];
            return (
              <tr
                key={d.key}
                className={`border-b border-slate-100 last:border-0 transition-colors ${row.active ? "bg-white" : "bg-slate-50/60"} ${idx % 2 === 0 ? "" : "bg-slate-50/30"}`}
              >
                <td className="px-3 py-2">
                  <span className={`font-medium ${row.active ? "text-slate-800" : "text-slate-400"}`}>
                    {d.label}
                  </span>
                </td>
                <td className="px-3 py-2 text-center">
                  <Switch
                    checked={row.active}
                    onCheckedChange={(v) => update(d.key, "active", v)}
                  />
                </td>
                {(["start", "lunch_start", "lunch_end", "end"] as const).map((field) => (
                  <td key={field} className="px-2 py-2 text-center">
                    <input
                      type="time"
                      value={row[field] as string}
                      onChange={(e) => update(d.key, field, e.target.value)}
                      disabled={!row.active}
                      className={`w-24 rounded-lg border px-2 py-1.5 text-center text-xs outline-none transition-colors focus:border-primary focus:ring-1 focus:ring-primary/20 ${
                        row.active
                          ? "border-slate-200 bg-white text-slate-800 hover:border-slate-300"
                          : "border-slate-100 bg-transparent text-slate-300 cursor-not-allowed"
                      }`}
                    />
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// =================================================================
// PromptText — renderiza texto de prompt destacando tool names e headings
// =================================================================

/**
 * Detecta e destaca dentro do texto do prompt:
 * - Tool names em snake_case (ex: agendar_clinicorp, buscar_paciente)
 * - Backticks `` `código` ``
 * - Linhas que são headings (# ou TUDO EM MAIÚSCULAS)
 */
function PromptText({ text, className }: { text: string; className?: string }) {
  // Divide por \n preservando linhas vazias
  const lines = text.split("\n");

  return (
    <div className={className}>
      {lines.map((line, li) => {
        // Linha vazia → espaçamento
        if (!line.trim()) return <div key={li} className="h-2" />;

        // Detecta heading: começa com # ou é ALL_CAPS com pelo menos 3 chars
        const isHeading =
          /^#{1,3}\s/.test(line) ||
          (/^[A-ZÀ-Ú0-9\s\-–_/()!?:]{3,}$/.test(line.trim()) && line.trim().length <= 80);

        const content = isHeading ? line.replace(/^#+\s*/, "") : line;

        if (isHeading) {
          return (
            <p key={li} className="mt-3 mb-1 text-[11px] font-bold uppercase tracking-wider text-slate-700 first:mt-0">
              {content}
            </p>
          );
        }

        // Para linhas normais, destaca snake_case e backticks
        return (
          <p key={li} className="text-xs leading-relaxed text-slate-700">
            <PromptInline text={line} />
          </p>
        );
      })}
    </div>
  );
}

/** Destaca tokens inline: snake_case e `backtick` dentro de uma linha. */
function PromptInline({ text }: { text: string }) {
  // Regex: captura `backtick` ou snake_case (mínimo 1 underscore)
  const parts = text.split(/(``?[^`]+``?|`[^`]+`|\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b)/g);

  return (
    <>
      {parts.map((part, i) => {
        if (!part) return null;
        const isCode =
          /^``?[^`]+``?$/.test(part) ||
          /^`[^`]+`$/.test(part) ||
          /^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/.test(part);
        if (isCode) {
          const clean = part.replace(/^`+|`+$/g, "");
          return (
            <code
              key={i}
              className="mx-0.5 inline-flex items-center rounded-md border border-slate-200 bg-slate-100 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-primary"
            >
              {clean}
            </code>
          );
        }
        return <span key={i}>{part}</span>;
      })}
    </>
  );
}

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

type TrainingTab = "instrucoes" | "midia";

function TrainingView({
  accountId,
  agentId,
  initialPrompt,
  initialNome,
  agentSettings,
  configuredIntegrations,
  onClose,
}: {
  accountId: string;
  agentId: string;
  initialPrompt: string;
  initialNome: string;
  agentSettings: Record<string, string>;
  configuredIntegrations: { clinicorp: boolean; clinup: boolean; google_calendar: boolean };
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
  const [showAiMagic, setShowAiMagic] = useState(false);
  const [showTrainer, setShowTrainer] = useState(false);
  const [showVersions, setShowVersions] = useState(false);
  const [showKnowledge, setShowKnowledge] = useState(false);

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
      // 60s de inatividade — só salva quando o usuário para de digitar
      autoSaveTimer.current = setTimeout(() => { void doSave(markdown); }, 60000);
    }
  };

  const applyTemplate = (prompt: string) => {
    setPromptContent(prompt);
    setCharCount(prompt.length);
    setSaveState("unsaved");
    if (autosave) {
      if (autoSaveTimer.current) clearTimeout(autoSaveTimer.current);
      autoSaveTimer.current = setTimeout(() => { void doSave(prompt); }, 60000);
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
      label: "MÍDIAS",
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
          className="flex items-center gap-1.5 rounded-full bg-emerald-500 px-3 py-1.5 text-xs font-semibold text-white shadow-sm shadow-emerald-500/30 transition-opacity hover:opacity-90"
          onClick={() => setShowTrainer(true)}
        >
          <MessageCircle className="h-3 w-3" />
          Modo Treinador
          <span className="flex h-4 w-4 items-center justify-center rounded-full bg-white/20 text-[9px]">▶</span>
        </button>

        <button
          className="flex items-center gap-1.5 rounded-full border border-slate-200 px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-slate-50"
          onClick={() => setShowKnowledge(true)}
        >
          <GraduationCap className="h-3 w-3" />
          Base de Conhecimento
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
            key={promptContent === initialPrompt ? "init" : promptContent.length === initialPrompt.length ? undefined : "ai-magic-applied-" + promptContent.length}
            initialContent={promptContent}
            onChange={handleChange}
            charCount={charCount}
            saveState={saveState}
            autosave={autosave}
            onAutosaveChange={setAutosave}
            onSave={() => void doSave()}
            onAiMagic={() => setShowAiMagic(true)}
            onHistory={() => setShowVersions(true)}
            configuredIntegrations={configuredIntegrations}
          />

          <PromptVersionsSheet
            open={showVersions}
            onClose={() => setShowVersions(false)}
            agentId={agentId}
            onRestored={(newPrompt) => {
              setPromptContent(newPrompt);
              setCharCount(newPrompt.length);
              setSaveState("saved");
              qc.invalidateQueries({ queryKey: ["agent", accountId] });
              toast.success("Versão restaurada.");
            }}
          />

          <AiMagicSheet
            open={showAiMagic}
            onClose={() => setShowAiMagic(false)}
            accountId={accountId}
            agentId={agentId}
            onApplied={(newPrompt) => {
              setPromptContent(newPrompt);
              setCharCount(newPrompt.length);
              setSaveState("saved"); // applyPromptEdit já salvou no banco
              qc.invalidateQueries({ queryKey: ["agent", accountId] });
              toast.success("Prompt atualizado pelo AI Magic.");
            }}
          />
        </>
      ) : (
        <MediaLibrary agentId={agentId} />
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

      {/* Modo Treinador — chat de teste em tela cheia */}
      {showTrainer && (
        <TrainerMode
          accountId={accountId}
          agentId={agentId}
          assistantName={agentSettings.assistant_name || nome || "Assistente"}
          onClose={() => setShowTrainer(false)}
          onPromptUpdated={(newPrompt) => {
            setPromptContent(newPrompt);
            setCharCount(newPrompt.length);
            setSaveState("saved");
            qc.invalidateQueries({ queryKey: ["agent", accountId] });
          }}
        />
      )}

      {/* Base de Conhecimento — sheet com upload + lista */}
      <KnowledgeSheet
        open={showKnowledge}
        onClose={() => setShowKnowledge(false)}
        agentId={agentId}
      />
    </div>
  );
}

// =================================================================
// Modo Treinador — chat estilo WhatsApp para testar o agente
// =================================================================

interface TrainerMessage {
  idx: number;
  role: "user" | "assistant";
  parts: string[]; // bolhas (split)
  pending?: boolean;
  at: string; // HH:MM
  /** Mídia anexada (quando o agente envia uma mídia simulada). */
  media?: {
    slug: string;
    title: string;
    media_type: "image" | "video" | "audio" | "document";
    file_url: string;
    caption?: string;
  };
}

interface TrainerAnnotation {
  id: string;
  messageIdx: number;
  assistantText: string;
  comment: string;
}

function TrainerMode({
  accountId,
  agentId,
  assistantName,
  onClose,
  onPromptUpdated,
}: {
  accountId: string;
  agentId: string;
  assistantName: string;
  onClose: () => void;
  onPromptUpdated: (newPrompt: string) => void;
}) {
  const turnFn = useServerFn(runTrainerTurn);
  const improveFn = useServerFn(requestTrainerImprovement);
  const applyFn = useServerFn(applyPromptEdit);
  const listMediaFn = useServerFn(listAgentMedia);

  const [messages, setMessages] = useState<TrainerMessage[]>([]);
  const [input, setInput] = useState("");
  const [pending, setPending] = useState(false);
  const [annotations, setAnnotations] = useState<TrainerAnnotation[]>([]);
  const [annotatingFor, setAnnotatingFor] = useState<TrainerMessage | null>(null);
  const [annotationDraft, setAnnotationDraft] = useState("");
  const [generating, setGenerating] = useState(false);
  const [showMediaPicker, setShowMediaPicker] = useState(false);
  // Estado de máquina (igual à produção) — começa em RECEPTION
  const [currentStage, setCurrentStage] = useState<string>("RECEPTION");
  const [leadData, setLeadData] = useState<Record<string, unknown>>({});

  // Lista mídias do agente (cache 5min)
  const mediaQ = useQuery({
    queryKey: ["agent-media", agentId],
    queryFn: () => listMediaFn({ data: { agentId } }),
    staleTime: 5 * 60 * 1000,
  });
  const [proposal, setProposal] = useState<{
    request_id: string;
    summary: string;
    proposed_prompt: string;
    prompt_before: string;
    sections_changed: string[];
    reasoning: string;
  } | null>(null);

  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages, pending]);

  function nowTime() {
    return new Date().toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
  }

  async function send() {
    const text = input.trim();
    if (!text || pending) return;
    setInput("");
    const idxUser = messages.length;
    const userMsg: TrainerMessage = {
      idx: idxUser,
      role: "user",
      parts: [text],
      at: nowTime(),
    };
    setMessages((prev) => [...prev, userMsg]);
    setPending(true);

    // history para o backend = todas as mensagens anteriores (cada role com content
    // = parts.join('\n\n') reflete bolhas do agente)
    const history = messages.map((m) => ({
      role: m.role,
      content: m.parts.join("\n\n"),
    }));

    try {
      const res = await turnFn({
        data: {
          accountId,
          agentId,
          history,
          userMessage: text,
          currentStage: currentStage as
            | "RECEPTION"
            | "QUALIFICATION"
            | "SLOT_OFFER"
            | "NAME_COLLECT"
            | "BOOKING"
            | "CONFIRMED"
            | "ESCALATED",
          leadData,
        },
      });
      const idxAsst = idxUser + 1;
      const asstMsg: TrainerMessage = {
        idx: idxAsst,
        role: "assistant",
        parts: res.parts.length > 0 ? res.parts : [res.reply],
        at: nowTime(),
      };
      setMessages((prev) => [...prev, asstMsg]);
      // Avança o estado (igual à máquina de produção)
      if (res.next_stage) setCurrentStage(res.next_stage);
      if (res.lead_data) setLeadData(res.lead_data as Record<string, unknown>);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Falha no agente");
      setMessages((prev) => [
        ...prev,
        {
          idx: idxUser + 1,
          role: "assistant",
          parts: [`❌ ${e instanceof Error ? e.message : "erro desconhecido"}`],
          at: nowTime(),
        },
      ]);
    } finally {
      setPending(false);
    }
  }

  function sendMediaManually(media: {
    slug: string;
    title: string;
    media_type: "image" | "video" | "audio" | "document";
    file_url: string;
  }) {
    const idxAsst = messages.length;
    setMessages((prev) => [
      ...prev,
      {
        idx: idxAsst,
        role: "assistant",
        parts: [`📎 [Mídia enviada: ${media.title}]`],
        at: nowTime(),
        media,
      },
    ]);
    setShowMediaPicker(false);
  }

  function saveAnnotation() {
    if (!annotatingFor || !annotationDraft.trim()) {
      setAnnotatingFor(null);
      setAnnotationDraft("");
      return;
    }
    setAnnotations((prev) => [
      ...prev,
      {
        id: `ann-${Date.now()}`,
        messageIdx: annotatingFor.idx,
        assistantText: annotatingFor.parts.join("\n\n"),
        comment: annotationDraft.trim(),
      },
    ]);
    setAnnotatingFor(null);
    setAnnotationDraft("");
    toast.success("Correção adicionada");
  }

  async function generateImprovements() {
    if (annotations.length === 0) {
      toast.info("Adicione pelo menos 1 correção primeiro");
      return;
    }
    setGenerating(true);
    try {
      // Transcript = todas as mensagens em formato linear
      const transcript = messages.map((m) => ({
        role: m.role,
        content: m.parts.join("\n\n"),
      }));
      const res = await improveFn({
        data: {
          accountId,
          agentId,
          transcript,
          annotations: annotations.map((a) => ({
            messageIdx: a.messageIdx,
            assistantText: a.assistantText,
            comment: a.comment,
          })),
        },
      });
      setProposal({
        request_id: res.request_id,
        summary: res.summary,
        proposed_prompt: res.proposed_prompt,
        prompt_before: res.prompt_before,
        sections_changed: res.sections_changed,
        reasoning: res.reasoning,
      });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Erro ao gerar correções");
    } finally {
      setGenerating(false);
    }
  }

  async function applyProposal() {
    if (!proposal) return;
    try {
      await applyFn({ data: { requestId: proposal.request_id } });
      onPromptUpdated(proposal.proposed_prompt);
      toast.success("Prompt atualizado com base na sessão de treino");
      setProposal(null);
      setAnnotations([]);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Erro ao aplicar");
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-slate-100">
      {/* Header */}
      <div className="flex items-center justify-between border-b bg-white px-5 py-3 shadow-sm">
        <div className="flex items-center gap-2">
          <button onClick={onClose} className="text-xs font-semibold text-primary hover:text-primary/80">
            ← VOLTAR
          </button>
          <div className="mx-2 h-4 w-px bg-slate-200" />
          <MessageCircle className="h-4 w-4 text-emerald-600" />
          <span className="text-sm font-semibold">Modo Treinador</span>
          <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-medium text-emerald-700">
            simulação · não envia pelo WhatsApp
          </span>
          <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-medium text-slate-600">
            stage: {currentStage}
          </span>
          {messages.length > 0 && (
            <button
              onClick={() => {
                setMessages([]);
                setCurrentStage("RECEPTION");
                setLeadData({});
                setAnnotations([]);
              }}
              className="rounded-full border border-slate-200 px-2 py-0.5 text-[10px] font-medium text-slate-500 hover:bg-slate-50"
            >
              ↺ Reiniciar
            </button>
          )}
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">
            {annotations.length} correç{annotations.length === 1 ? "ão" : "ões"}
          </span>
          <Button
            onClick={() => void generateImprovements()}
            disabled={annotations.length === 0 || generating}
            size="sm"
            className="bg-primary"
          >
            {generating ? (
              <>
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                Gerando…
              </>
            ) : (
              <>
                <Zap className="mr-1.5 h-3.5 w-3.5" />
                Aplicar correções no prompt
              </>
            )}
          </Button>
        </div>
      </div>

      <div className="flex flex-1 overflow-hidden">
        {/* ── Chat estilo WhatsApp (tema claro) ── */}
        <div className="flex flex-1 flex-col bg-[#efeae2]">
          <div
            ref={scrollRef}
            className="flex-1 overflow-y-auto px-4 py-4"
            style={{
              backgroundImage:
                "url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='400' height='400' viewBox='0 0 400 400'><g fill='%23000000' fill-opacity='0.03'><circle cx='50' cy='50' r='1'/><circle cx='150' cy='80' r='1'/><circle cx='250' cy='120' r='1'/><circle cx='350' cy='60' r='1'/><circle cx='80' cy='200' r='1'/><circle cx='200' cy='250' r='1'/><circle cx='320' cy='280' r='1'/></g></svg>\")",
            }}
          >
            {messages.length === 0 && (
              <div className="mx-auto mt-12 max-w-md text-center text-slate-500">
                <Bot className="mx-auto mb-3 h-12 w-12 opacity-30" />
                <p className="text-sm font-medium">Inicie uma conversa para testar o agente</p>
                <p className="mt-1 text-xs">
                  Use mensagens reais (saudação, dúvidas, objeções).
                  <br />
                  Selecione respostas que precisem de correção.
                </p>
                <p className="mt-3 text-[10px] text-slate-400">
                  Stage: <strong>{currentStage}</strong>
                </p>
              </div>
            )}

            <div className="space-y-2">
              {messages.map((m) => (
                <div key={m.idx} className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}>
                  <div className={`flex max-w-[75%] flex-col gap-1 ${m.role === "user" ? "items-end" : "items-start"}`}>
                    {/* Mídia (apenas em mensagens do agente que carregam media) */}
                    {m.role === "assistant" && m.media && (
                      <div className="overflow-hidden rounded-lg rounded-bl-none border border-slate-200 bg-white shadow-sm">
                        {m.media.media_type === "image" ? (
                          <img src={m.media.file_url} alt={m.media.title} className="max-h-48 w-auto object-cover" />
                        ) : m.media.media_type === "video" ? (
                          <video src={m.media.file_url} controls className="max-h-48 w-auto" />
                        ) : m.media.media_type === "audio" ? (
                          <audio src={m.media.file_url} controls className="w-64" />
                        ) : (
                          <div className="flex items-center gap-2 p-3">
                            <GraduationCap className="h-8 w-8 text-slate-400" />
                            <div>
                              <p className="text-sm font-medium">{m.media.title}</p>
                              <p className="text-[10px] text-muted-foreground">{m.media.slug}</p>
                            </div>
                          </div>
                        )}
                        {m.media.caption && (
                          <p className="border-t border-slate-100 px-3 py-1.5 text-sm text-slate-700">
                            {m.media.caption}
                          </p>
                        )}
                      </div>
                    )}
                    {m.parts.map((part, pi) => {
                      const isLast = pi === m.parts.length - 1;
                      const hasAnnotation = annotations.some((a) => a.messageIdx === m.idx);
                      return (
                        <div
                          key={pi}
                          className={`group relative rounded-lg px-3 py-1.5 text-sm shadow-sm ${
                            m.role === "user"
                              ? "rounded-br-none bg-[#d9fdd3] text-slate-900"
                              : `rounded-bl-none bg-white text-slate-900 ${hasAnnotation ? "ring-2 ring-amber-400" : ""}`
                          }`}
                        >
                          <p className="whitespace-pre-wrap break-words">{part}</p>
                          {isLast && (
                            <span className="mt-0.5 block text-right text-[10px] text-slate-500">
                              {m.at}
                            </span>
                          )}
                          {m.role === "assistant" && isLast && (
                            <button
                              onClick={() => {
                                setAnnotatingFor(m);
                                setAnnotationDraft("");
                              }}
                              className="absolute -bottom-2 -right-2 flex h-6 w-6 items-center justify-center rounded-full bg-amber-500 text-white opacity-0 shadow-md transition-opacity hover:bg-amber-600 group-hover:opacity-100"
                              title="Adicionar correção"
                            >
                              <AlertCircle className="h-3.5 w-3.5" />
                            </button>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              ))}

              {pending && (
                <div className="flex justify-start">
                  <div className="flex items-center gap-1 rounded-lg rounded-bl-none bg-white px-3 py-2 shadow-sm">
                    <span className="h-2 w-2 animate-pulse rounded-full bg-slate-400 [animation-delay:0ms]" />
                    <span className="h-2 w-2 animate-pulse rounded-full bg-slate-400 [animation-delay:150ms]" />
                    <span className="h-2 w-2 animate-pulse rounded-full bg-slate-400 [animation-delay:300ms]" />
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Input WhatsApp */}
          <div className="relative flex items-center gap-2 bg-[#f0f2f5] px-3 py-2.5">
            {/* Botão 📎 (mídia manual) */}
            <button
              onClick={() => setShowMediaPicker((v) => !v)}
              title="Enviar mídia do agente"
              className="flex h-9 w-9 items-center justify-center rounded-full text-slate-500 transition-colors hover:bg-slate-200 hover:text-slate-700"
            >
              📎
            </button>

            <input
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void send();
                }
              }}
              placeholder="Digite uma mensagem"
              disabled={pending}
              className="flex-1 rounded-full bg-white px-4 py-2 text-sm text-slate-900 outline-none placeholder:text-slate-400 disabled:opacity-60"
            />
            <button
              onClick={() => void send()}
              disabled={!input.trim() || pending}
              className="flex h-9 w-9 items-center justify-center rounded-full bg-emerald-600 text-white transition-colors hover:bg-emerald-700 disabled:bg-slate-300"
            >
              {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowRight className="h-4 w-4" />}
            </button>

            {/* Popover de mídias */}
            {showMediaPicker && (
              <>
                <div className="fixed inset-0 z-10" onClick={() => setShowMediaPicker(false)} />
                <div className="absolute bottom-full left-3 z-20 mb-2 w-80 rounded-xl border border-slate-200 bg-white p-2 shadow-2xl">
                  <p className="border-b border-slate-100 px-2 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-slate-500">
                    Mídias do agente
                  </p>
                  <div className="max-h-72 overflow-y-auto">
                    {!mediaQ.data?.media || mediaQ.data.media.length === 0 ? (
                      <p className="px-3 py-4 text-center text-xs text-muted-foreground">
                        Nenhuma mídia cadastrada.<br />
                        Adicione em <strong>Mídias</strong>.
                      </p>
                    ) : (
                      mediaQ.data.media.map((m) => {
                        const item = m as AgentMediaItem;
                        return (
                          <button
                            key={item.id}
                            onClick={() =>
                              sendMediaManually({
                                slug: item.slug,
                                title: item.title,
                                media_type: item.media_type,
                                file_url: item.file_url,
                              })
                            }
                            className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left hover:bg-slate-50"
                          >
                            <div className="h-10 w-10 shrink-0 overflow-hidden rounded-md bg-slate-100">
                              {item.media_type === "image" ? (
                                <img src={item.file_url} alt="" className="h-full w-full object-cover" />
                              ) : item.media_type === "video" ? (
                                <video src={item.file_url} className="h-full w-full object-cover" />
                              ) : (
                                <div className="flex h-full w-full items-center justify-center text-slate-400">
                                  {item.media_type === "audio" ? "🎵" : "📄"}
                                </div>
                              )}
                            </div>
                            <div className="min-w-0 flex-1">
                              <p className="truncate text-xs font-medium text-foreground">{item.title}</p>
                              <p className="truncate text-[10px] font-mono text-muted-foreground">
                                {item.slug}
                              </p>
                            </div>
                          </button>
                        );
                      })
                    )}
                  </div>
                </div>
              </>
            )}
          </div>
        </div>

        {/* ── Sidebar de Correções ── */}
        <aside className="hidden w-80 flex-col border-l bg-white sm:flex">
          <div className="border-b px-4 py-3">
            <h3 className="text-sm font-semibold">Correções</h3>
            <p className="text-[11px] text-muted-foreground">
              Clique no balão amarelo (canto da mensagem do agente) para anotar.
            </p>
          </div>
          <div className="flex-1 overflow-y-auto p-3 space-y-2">
            {annotations.length === 0 ? (
              <div className="mt-6 text-center text-[11px] text-muted-foreground">
                Nenhuma correção ainda.
                <br />
                Passe o mouse sobre as respostas do agente e clique no ícone para comentar.
              </div>
            ) : (
              annotations.map((a, i) => (
                <div key={a.id} className="rounded-lg border border-slate-200 bg-amber-50/40 p-2.5">
                  <div className="mb-1 flex items-center justify-between">
                    <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-semibold text-amber-800">
                      #{i + 1} · mensagem {a.messageIdx}
                    </span>
                    <button
                      onClick={() => setAnnotations((prev) => prev.filter((x) => x.id !== a.id))}
                      className="text-[10px] text-muted-foreground hover:text-destructive"
                    >
                      Remover
                    </button>
                  </div>
                  <p className="line-clamp-2 text-[10px] italic text-slate-500">
                    "{a.assistantText.slice(0, 120)}{a.assistantText.length > 120 ? "…" : ""}"
                  </p>
                  <p className="mt-1.5 text-xs text-slate-800">{a.comment}</p>
                </div>
              ))
            )}
          </div>
        </aside>
      </div>

      {/* Modal: nova anotação */}
      {annotatingFor && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-md rounded-xl border bg-white p-5 shadow-2xl">
            <div className="mb-3 flex items-start gap-2">
              <AlertCircle className="mt-0.5 h-5 w-5 shrink-0 text-amber-500" />
              <div>
                <p className="text-sm font-semibold">Adicionar correção</p>
                <p className="text-[11px] text-muted-foreground">
                  Mensagem do agente {annotatingFor.idx}
                </p>
              </div>
            </div>
            <div className="mb-3 max-h-32 overflow-y-auto rounded-md border bg-slate-50 p-2.5 text-[11px] italic text-slate-600 whitespace-pre-wrap">
              "{annotatingFor.parts.join("\n\n")}"
            </div>
            <Label className="text-xs">O que precisa melhorar?</Label>
            <textarea
              value={annotationDraft}
              onChange={(e) => setAnnotationDraft(e.target.value)}
              rows={3}
              autoFocus
              placeholder="Ex: deveria ter perguntado o tamanho da clínica antes de oferecer horário"
              className="mt-1 w-full resize-none rounded-md border border-slate-200 px-3 py-2 text-sm outline-none focus:border-primary focus:ring-1 focus:ring-primary/20"
            />
            <div className="mt-3 flex justify-end gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setAnnotatingFor(null);
                  setAnnotationDraft("");
                }}
              >
                Cancelar
              </Button>
              <Button size="sm" onClick={saveAnnotation} disabled={!annotationDraft.trim()}>
                Salvar correção
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Modal: proposta gerada */}
      {proposal && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-4">
          <div className="flex w-full max-w-2xl flex-col rounded-xl border bg-white shadow-2xl max-h-[90vh]">
            <div className="border-b px-5 py-3">
              <div className="flex items-center justify-between">
                <h3 className="flex items-center gap-2 text-base font-semibold">
                  <Zap className="h-4 w-4 text-primary" />
                  Correções propostas
                </h3>
                <button onClick={() => setProposal(null)} className="text-muted-foreground hover:text-foreground">
                  ✕
                </button>
              </div>
              <p className="mt-1 text-[11px] text-muted-foreground">{assistantName} · GPT-4 analisou {annotations.length} correção(ões)</p>
            </div>
            <div className="flex-1 space-y-3 overflow-y-auto p-5">
              <div className="rounded-md border bg-slate-50 p-3 text-sm text-slate-800">{proposal.summary}</div>
              {proposal.sections_changed.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {proposal.sections_changed.map((s) => (
                    <span key={s} className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-medium text-amber-800">
                      {s}
                    </span>
                  ))}
                </div>
              )}
              {proposal.reasoning && (
                <p className="text-[11px] italic text-muted-foreground">💡 {proposal.reasoning}</p>
              )}
              <DiffPreviewBlock before={proposal.prompt_before} after={proposal.proposed_prompt} />
            </div>
            <div className="flex justify-end gap-2 border-t px-5 py-3">
              <Button variant="outline" size="sm" onClick={() => setProposal(null)}>
                Descartar
              </Button>
              <Button size="sm" onClick={() => void applyProposal()}>
                <Check className="mr-1.5 h-3.5 w-3.5" />
                Aplicar no prompt
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// =================================================================
// MediaLibrary — galeria de mídias do agente (tab dentro do Treinamento)
// =================================================================

interface AgentMediaItem {
  id: string;
  slug: string;
  title: string;
  description: string | null;
  file_url: string;
  media_type: "image" | "video" | "audio" | "document";
  mime_type: string | null;
  file_size: number | null;
  criado_em: string;
}

function MediaLibrary({ agentId }: { agentId: string }) {
  const qc = useQueryClient();
  const listFn = useServerFn(listAgentMedia);
  const uploadFn = useServerFn(uploadAgentMedia);
  const updateFn = useServerFn(updateAgentMedia);
  const delFn = useServerFn(deleteAgentMedia);

  const q = useQuery({
    queryKey: ["agent-media", agentId],
    queryFn: () => listFn({ data: { agentId } }),
  });

  const [pending, setPending] = useState(false);
  const [showUpload, setShowUpload] = useState(false);
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [draftTitle, setDraftTitle] = useState("");
  const [draftDesc, setDraftDesc] = useState("");
  const [draftSlug, setDraftSlug] = useState("");

  const fileInputRef = useRef<HTMLInputElement>(null);

  function openUploadDialog(file: File) {
    setPendingFile(file);
    setDraftTitle(file.name.replace(/\.[^.]+$/, ""));
    setDraftDesc("");
    setDraftSlug("");
    setShowUpload(true);
  }

  async function confirmUpload() {
    if (!pendingFile || !draftTitle.trim() || pending) return;
    setPending(true);
    try {
      const base64 = await new Promise<string>((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(String(r.result));
        r.onerror = reject;
        r.readAsDataURL(pendingFile);
      });
      await uploadFn({
        data: {
          agentId,
          filename: pendingFile.name,
          fileBase64: base64,
          title: draftTitle.trim(),
          description: draftDesc.trim() || undefined,
          slug: draftSlug.trim() || undefined,
        },
      });
      toast.success("Mídia adicionada.");
      qc.invalidateQueries({ queryKey: ["agent-media", agentId] });
      setShowUpload(false);
      setPendingFile(null);
      if (fileInputRef.current) fileInputRef.current.value = "";
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Erro no upload");
    } finally {
      setPending(false);
    }
  }

  async function removeMedia(id: string, title: string) {
    if (!confirm(`Remover "${title}"?`)) return;
    try {
      await delFn({ data: { id } });
      qc.invalidateQueries({ queryKey: ["agent-media", agentId] });
      toast.success("Mídia removida.");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Erro ao remover");
    }
  }

  async function saveEdit(item: AgentMediaItem, patch: Partial<AgentMediaItem>) {
    try {
      await updateFn({
        data: {
          id: item.id,
          title: patch.title,
          description: patch.description,
          slug: patch.slug,
        },
      });
      qc.invalidateQueries({ queryKey: ["agent-media", agentId] });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Erro ao salvar");
    }
  }

  const items = (q.data?.media ?? []) as AgentMediaItem[];

  return (
    <div className="flex flex-1 flex-col gap-4 p-6">
      <div className="rounded-xl border border-primary/20 bg-primary/5 px-5 py-3.5">
        <p className="text-sm font-semibold text-primary">📎 Biblioteca de Mídias</p>
        <p className="mt-1 text-xs text-primary/80">
          Suba imagens, vídeos, áudios ou PDFs. O agente vai poder enviar essas mídias
          durante a conversa através da tool <code className="rounded bg-white/60 px-1 py-0.5 font-mono">enviar_midia</code>.
          Use no AI Magic ou Modo Treinador para acionar manualmente.
        </p>
      </div>

      {/* Upload zone */}
      <div className="rounded-xl border-2 border-dashed border-slate-300 bg-slate-50 px-6 py-4">
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*,video/*,audio/*,application/pdf"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) openUploadDialog(f);
          }}
          className="hidden"
        />
        <div className="flex items-center justify-between gap-4">
          <div>
            <p className="text-sm font-medium text-slate-700">Adicionar nova mídia</p>
            <p className="text-[11px] text-muted-foreground">
              Imagens (JPG/PNG/WebP), vídeos (MP4/WebM), áudios (MP3/OGG) ou PDF. Até 50MB.
            </p>
          </div>
          <Button onClick={() => fileInputRef.current?.click()}>
            <Plus className="mr-1 h-4 w-4" />
            Escolher arquivo
          </Button>
        </div>
      </div>

      {/* Lista */}
      {q.isLoading && (
        <div className="flex items-center justify-center py-8">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      )}

      {!q.isLoading && items.length === 0 && (
        <div className="rounded-xl border border-dashed border-slate-200 p-8 text-center">
          <p className="text-sm font-medium text-foreground">Nenhuma mídia cadastrada</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Suba a primeira para que o agente possa enviá-la durante o atendimento.
          </p>
        </div>
      )}

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {items.map((m) => (
          <MediaCard
            key={m.id}
            item={m}
            onRemove={() => void removeMedia(m.id, m.title)}
            onSave={(patch) => void saveEdit(m, patch)}
          />
        ))}
      </div>

      {/* Dialog de upload */}
      {showUpload && pendingFile && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="w-full max-w-md rounded-xl border bg-white p-5 shadow-2xl">
            <div className="mb-3">
              <p className="text-sm font-semibold">Nova mídia</p>
              <p className="text-[11px] text-muted-foreground truncate">{pendingFile.name}</p>
            </div>
            <div className="space-y-3">
              <div>
                <Label className="text-xs">Título *</Label>
                <Input
                  value={draftTitle}
                  onChange={(e) => setDraftTitle(e.target.value)}
                  placeholder="Ex: Vídeo de localização"
                  className="mt-1"
                />
              </div>
              <div>
                <Label className="text-xs">Slug (opcional)</Label>
                <Input
                  value={draftSlug}
                  onChange={(e) => setDraftSlug(e.target.value.replace(/[^a-zA-Z0-9_-]/g, "_"))}
                  placeholder="ex: localizacao (gerado do título se vazio)"
                  className="mt-1 font-mono text-xs"
                />
                <p className="mt-0.5 text-[10px] text-muted-foreground">
                  Identificador que o agente usa para chamar (apenas letras, números, _).
                </p>
              </div>
              <div>
                <Label className="text-xs">Quando usar?</Label>
                <textarea
                  value={draftDesc}
                  onChange={(e) => setDraftDesc(e.target.value)}
                  placeholder="Ex: Envie ao confirmar agendamento, junto com o resumo."
                  rows={3}
                  className="mt-1 w-full resize-none rounded-md border border-slate-200 px-3 py-2 text-sm outline-none focus:border-primary"
                />
                <p className="mt-0.5 text-[10px] text-muted-foreground">
                  Essa descrição entra no contexto do LLM — ele decide quando usar baseado no que você descrever.
                </p>
              </div>
            </div>
            <div className="mt-4 flex justify-end gap-2">
              <Button variant="outline" onClick={() => setShowUpload(false)} disabled={pending}>
                Cancelar
              </Button>
              <Button onClick={() => void confirmUpload()} disabled={!draftTitle.trim() || pending}>
                {pending && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
                Adicionar
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function MediaCard({
  item,
  onRemove,
  onSave,
}: {
  item: AgentMediaItem;
  onRemove: () => void;
  onSave: (patch: Partial<AgentMediaItem>) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(item.title);
  const [desc, setDesc] = useState(item.description ?? "");
  const [slug, setSlug] = useState(item.slug);

  const sizeKb = item.file_size ? Math.round(item.file_size / 1024) : 0;

  return (
    <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
      <div className="aspect-video bg-slate-100 flex items-center justify-center">
        {item.media_type === "image" ? (
          <img src={item.file_url} alt={item.title} className="h-full w-full object-cover" />
        ) : item.media_type === "video" ? (
          <video src={item.file_url} className="h-full w-full object-cover" />
        ) : item.media_type === "audio" ? (
          <Headphones className="h-12 w-12 text-slate-400" />
        ) : (
          <GraduationCap className="h-12 w-12 text-slate-400" />
        )}
      </div>
      <div className="p-3">
        {editing ? (
          <div className="space-y-2">
            <Input value={title} onChange={(e) => setTitle(e.target.value)} className="text-xs" />
            <Input
              value={slug}
              onChange={(e) => setSlug(e.target.value.replace(/[^a-zA-Z0-9_-]/g, "_"))}
              className="text-xs font-mono"
            />
            <textarea
              value={desc}
              onChange={(e) => setDesc(e.target.value)}
              rows={2}
              className="w-full resize-none rounded-md border border-slate-200 px-2 py-1 text-xs outline-none focus:border-primary"
            />
            <div className="flex gap-1">
              <Button
                size="sm"
                className="h-7 flex-1 text-xs"
                onClick={() => {
                  onSave({ title: title.trim(), slug: slug.trim(), description: desc.trim() || null });
                  setEditing(false);
                }}
              >
                Salvar
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="h-7 text-xs"
                onClick={() => {
                  setTitle(item.title);
                  setSlug(item.slug);
                  setDesc(item.description ?? "");
                  setEditing(false);
                }}
              >
                Cancelar
              </Button>
            </div>
          </div>
        ) : (
          <>
            <p className="truncate text-sm font-medium text-foreground" title={item.title}>
              {item.title}
            </p>
            <p className="truncate text-[10px] font-mono text-muted-foreground" title={item.slug}>
              {item.slug}
            </p>
            {item.description && (
              <p className="mt-1 line-clamp-2 text-[11px] text-muted-foreground">
                {item.description}
              </p>
            )}
            <div className="mt-2 flex items-center justify-between text-[10px] text-muted-foreground">
              <span className="rounded-full bg-slate-100 px-2 py-0.5 font-semibold">
                {item.media_type}
              </span>
              <span>{sizeKb >= 1024 ? `${(sizeKb / 1024).toFixed(1)}MB` : `${sizeKb}KB`}</span>
            </div>
            <div className="mt-2 flex justify-between text-[10px]">
              <button onClick={() => setEditing(true)} className="text-primary hover:underline">
                Editar
              </button>
              <button onClick={onRemove} className="text-rose-500 hover:text-rose-700">
                Remover
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// =================================================================
// KnowledgeSheet — base de conhecimento (RAG) do agente
// =================================================================

function KnowledgeSheet({
  open,
  onClose,
  agentId,
}: {
  open: boolean;
  onClose: () => void;
  agentId: string;
}) {
  const qc = useQueryClient();
  const listFn = useServerFn(listKnowledgeDocuments);
  const addUrl = useServerFn(addUrlDocument);
  const addPdf = useServerFn(addPdfDocument);
  const delFn = useServerFn(deleteKnowledgeDocument);

  const q = useQuery({
    queryKey: ["knowledge-docs", agentId],
    queryFn: () => listFn({ data: { agentId } }),
    enabled: open,
    refetchInterval: open ? 5000 : false, // polling para ver status mudar
  });

  const [tab, setTab] = useState<"url" | "pdf">("url");
  const [urlInput, setUrlInput] = useState("");
  const [pending, setPending] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  async function submitUrl() {
    const url = urlInput.trim();
    if (!url || pending) return;
    setPending(true);
    try {
      await addUrl({ data: { agentId, url } });
      setUrlInput("");
      toast.success("Documento indexado.");
      qc.invalidateQueries({ queryKey: ["knowledge-docs", agentId] });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Erro ao adicionar URL");
    } finally {
      setPending(false);
    }
  }

  async function submitPdf(file: File) {
    if (pending) return;
    if (file.size > 25 * 1024 * 1024) {
      toast.error("Arquivo maior que 25MB.");
      return;
    }
    setPending(true);
    try {
      const base64 = await new Promise<string>((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(String(r.result));
        r.onerror = reject;
        r.readAsDataURL(file);
      });
      await addPdf({ data: { agentId, filename: file.name, fileBase64: base64 } });
      toast.success(`${file.name} indexado.`);
      qc.invalidateQueries({ queryKey: ["knowledge-docs", agentId] });
      if (fileInputRef.current) fileInputRef.current.value = "";
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Erro ao adicionar PDF");
    } finally {
      setPending(false);
    }
  }

  async function deleteDoc(id: string, title: string) {
    if (!confirm(`Apagar "${title}"? Os chunks indexados também serão removidos.`)) return;
    try {
      await delFn({ data: { documentId: id, agentId } });
      qc.invalidateQueries({ queryKey: ["knowledge-docs", agentId] });
      toast.success("Documento removido.");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Erro ao remover");
    }
  }

  const docs = q.data?.documents ?? [];
  const totalChunks = docs.reduce((s, d) => s + ((d.total_chunks as number) ?? 0), 0);

  return (
    <Sheet open={open} onOpenChange={(v) => !v && onClose()}>
      <SheetContent side="right" className="flex w-full flex-col gap-0 p-0 sm:max-w-xl">
        <SheetHeader className="border-b px-5 py-3">
          <SheetTitle className="flex items-center gap-2">
            <GraduationCap className="h-4 w-4 text-primary" />
            Base de Conhecimento
          </SheetTitle>
          <p className="text-xs text-muted-foreground">
            Suba PDFs ou cole URLs. O agente vai consultar esse conteúdo a cada
            mensagem do lead para responder com mais precisão.
            {totalChunks > 0 && (
              <> · <strong>{totalChunks}</strong> trecho{totalChunks > 1 ? "s" : ""} indexado{totalChunks > 1 ? "s" : ""}</>
            )}
          </p>
        </SheetHeader>

        {/* Tabs URL / PDF */}
        <div className="flex border-b bg-slate-50 px-3 pt-2">
          <button
            onClick={() => setTab("url")}
            className={`relative px-3 py-2 text-xs font-medium transition-colors ${
              tab === "url" ? "text-primary" : "text-muted-foreground hover:text-foreground"
            }`}
          >
            🔗 Link / URL
            {tab === "url" && <span className="absolute inset-x-1 -bottom-px h-0.5 bg-primary" />}
          </button>
          <button
            onClick={() => setTab("pdf")}
            className={`relative px-3 py-2 text-xs font-medium transition-colors ${
              tab === "pdf" ? "text-primary" : "text-muted-foreground hover:text-foreground"
            }`}
          >
            📄 PDF
            {tab === "pdf" && <span className="absolute inset-x-1 -bottom-px h-0.5 bg-primary" />}
          </button>
        </div>

        {/* Formulário */}
        <div className="border-b bg-slate-50/50 px-4 py-3">
          {tab === "url" ? (
            <div className="flex gap-2">
              <input
                type="url"
                value={urlInput}
                onChange={(e) => setUrlInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !pending) {
                    e.preventDefault();
                    void submitUrl();
                  }
                }}
                placeholder="https://site.com/sobre-nos"
                disabled={pending}
                className="flex-1 rounded-md border border-slate-200 bg-white px-3 py-2 text-sm outline-none focus:border-primary focus:ring-1 focus:ring-primary/20"
              />
              <Button onClick={() => void submitUrl()} disabled={!urlInput.trim() || pending}>
                {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : "Indexar"}
              </Button>
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <input
                ref={fileInputRef}
                type="file"
                accept="application/pdf,.pdf"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void submitPdf(f);
                }}
                disabled={pending}
                className="flex-1 cursor-pointer rounded-md border border-slate-200 bg-white px-3 py-2 text-sm file:mr-3 file:rounded-md file:border-0 file:bg-primary file:px-3 file:py-1 file:text-xs file:font-semibold file:text-white hover:file:bg-primary/90 disabled:opacity-60"
              />
              {pending && <Loader2 className="h-4 w-4 animate-spin text-primary" />}
            </div>
          )}
          <p className="mt-1.5 text-[10px] text-muted-foreground">
            {tab === "url"
              ? "Suporta páginas HTML. JavaScript-only (SPA) pode não funcionar."
              : "Até 25MB. PDFs com texto extraível (não funcionará para PDFs só de imagens sem OCR)."}
          </p>
        </div>

        {/* Lista de documentos */}
        <div className="flex-1 overflow-y-auto p-3 space-y-2">
          {q.isLoading && (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          )}

          {!q.isLoading && docs.length === 0 && (
            <div className="rounded-lg border border-dashed border-slate-200 p-6 text-center text-xs text-muted-foreground">
              Nenhum documento ainda.
              <br />
              Cole uma URL ou faça upload de PDF acima para começar.
            </div>
          )}

          {docs.map((d) => {
            const status = d.status as string;
            const statusColor =
              status === "ready"
                ? "bg-emerald-100 text-emerald-700"
                : status === "failed"
                  ? "bg-rose-100 text-rose-700"
                  : "bg-amber-100 text-amber-700";
            const dt = new Date(d.criado_em as string).toLocaleString("pt-BR", {
              day: "2-digit",
              month: "2-digit",
              hour: "2-digit",
              minute: "2-digit",
            });
            return (
              <div key={d.id as string} className="rounded-lg border border-slate-200 bg-white p-3">
                <div className="mb-1 flex items-start justify-between gap-2">
                  <div className="flex-1 min-w-0">
                    <p className="truncate text-sm font-medium text-foreground" title={d.title as string}>
                      {(d.source_type as string) === "url" ? "🔗" : "📄"} {(d.title as string) || (d.source_ref as string) || "Sem título"}
                    </p>
                    {d.source_type === "url" && (
                      <p className="truncate text-[10px] text-muted-foreground" title={d.source_ref as string}>
                        {d.source_ref as string}
                      </p>
                    )}
                  </div>
                  <span className={`rounded-full px-2 py-0.5 text-[9px] font-semibold ${statusColor}`}>
                    {status === "ready"
                      ? "PRONTO"
                      : status === "failed"
                        ? "FALHOU"
                        : status === "indexing"
                          ? "INDEXANDO…"
                          : "PENDENTE"}
                  </span>
                </div>

                <div className="flex items-center justify-between text-[10px] text-muted-foreground">
                  <span>
                    {d.total_chunks ? `${d.total_chunks} trecho${(d.total_chunks as number) > 1 ? "s" : ""}` : "0 trechos"} ·
                    {" "}{d.total_chars ? `${((d.total_chars as number) / 1000).toFixed(1)}k chars` : ""}
                  </span>
                  <span>{dt}</span>
                </div>

                {d.error && (
                  <p className="mt-1.5 rounded-md bg-rose-50 px-2 py-1 text-[10px] text-rose-700">
                    {d.error as string}
                  </p>
                )}

                {d.content_preview && status === "ready" && (
                  <p className="mt-1.5 line-clamp-2 text-[10px] italic text-muted-foreground">
                    "{(d.content_preview as string).slice(0, 200)}…"
                  </p>
                )}

                <div className="mt-2 flex justify-end">
                  <button
                    onClick={() => void deleteDoc(d.id as string, (d.title as string) || "documento")}
                    className="text-[10px] text-muted-foreground hover:text-destructive"
                  >
                    Remover
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </SheetContent>
    </Sheet>
  );
}

// =================================================================
// PromptVersionsSheet — histórico de versões com restauração
// =================================================================

function PromptVersionsSheet({
  open,
  onClose,
  agentId,
  onRestored,
}: {
  open: boolean;
  onClose: () => void;
  agentId: string;
  onRestored: (newPrompt: string) => void;
}) {
  const qc = useQueryClient();
  const listFn = useServerFn(listPromptVersions);
  const restoreFn = useServerFn(restorePromptVersion);

  const q = useQuery({
    queryKey: ["prompt-versions", agentId],
    queryFn: () => listFn({ data: { agentId } }),
    enabled: open,
  });

  const [restoring, setRestoring] = useState<string | null>(null);
  const [previewing, setPreviewing] = useState<{
    summary: string;
    before: string;
    after: string;
    appliedAt: string | null;
  } | null>(null);

  async function restore(requestId: string, target: "before" | "after") {
    if (!confirm(`Restaurar versão "${target === "before" ? "anterior" : "deste ponto"}"? O prompt atual será substituído.`)) return;
    setRestoring(requestId + ":" + target);
    try {
      const res = await restoreFn({ data: { agentId, sourceRequestId: requestId, target } });
      if (res.restored_prompt) {
        onRestored(res.restored_prompt);
      } else if (res.already_current) {
        toast.info("Essa versão já é a atual.");
      }
      qc.invalidateQueries({ queryKey: ["prompt-versions", agentId] });
      qc.invalidateQueries({ queryKey: ["ai-magic-history", agentId] });
      onClose();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Erro ao restaurar");
    } finally {
      setRestoring(null);
    }
  }

  return (
    <Sheet open={open} onOpenChange={(v) => !v && onClose()}>
      <SheetContent side="right" className="flex w-full flex-col gap-0 p-0 sm:max-w-lg">
        <SheetHeader className="border-b px-5 py-3">
          <SheetTitle className="flex items-center gap-2">
            <RotateCcw className="h-4 w-4 text-primary" />
            Histórico de versões
          </SheetTitle>
          <p className="text-xs text-muted-foreground">
            Cada vez que uma alteração foi aplicada no prompt. Você pode restaurar
            qualquer versão anterior.
          </p>
        </SheetHeader>

        <div className="flex-1 overflow-y-auto p-4 space-y-3">
          {q.isLoading && (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          )}

          {q.data && q.data.versions.length === 0 && (
            <div className="rounded-lg border border-dashed border-slate-200 p-6 text-center text-xs text-muted-foreground">
              Ainda não há versões salvas.
              <br />
              Cada vez que você aplicar uma alteração via AI Magic ou Modo Treinador,
              ela aparecerá aqui.
            </div>
          )}

          {q.data?.versions.map((v, idx) => {
            const userMsg = v.user_message as string;
            const isRestore = userMsg.startsWith("[RESTORE]");
            const isTrainer = userMsg.startsWith("[TRAINER]");
            const dt = v.applied_at
              ? new Date(v.applied_at as string).toLocaleString("pt-BR", {
                  day: "2-digit",
                  month: "2-digit",
                  hour: "2-digit",
                  minute: "2-digit",
                })
              : "-";
            return (
              <div
                key={v.id as string}
                className="rounded-xl border border-slate-200 bg-white p-3 shadow-sm"
              >
                <div className="mb-1 flex items-start justify-between gap-2">
                  <span className="text-[11px] font-semibold text-slate-700">
                    {idx === 0 ? "✨ Versão atual" : `#${q.data.versions.length - idx}`}
                  </span>
                  <span className="text-[10px] text-muted-foreground">{dt}</span>
                </div>

                {(isRestore || isTrainer) && (
                  <span
                    className={`mb-1 inline-block rounded-full px-2 py-0.5 text-[9px] font-semibold ${
                      isRestore
                        ? "bg-violet-100 text-violet-700"
                        : "bg-emerald-100 text-emerald-700"
                    }`}
                  >
                    {isRestore ? "RESTAURAÇÃO" : "TREINADOR"}
                  </span>
                )}

                <p className="text-xs text-foreground line-clamp-2 mb-1">
                  {(v.summary as string) ?? userMsg}
                </p>

                {Array.isArray(v.sections_changed) && (v.sections_changed as string[]).length > 0 && (
                  <div className="mb-2 flex flex-wrap gap-1">
                    {(v.sections_changed as string[]).slice(0, 4).map((s) => (
                      <span
                        key={s}
                        className="rounded-full bg-amber-100 px-1.5 py-0.5 text-[9px] font-medium text-amber-800"
                      >
                        {s}
                      </span>
                    ))}
                  </div>
                )}

                <div className="flex flex-wrap items-center gap-2">
                  <button
                    onClick={() =>
                      setPreviewing({
                        summary: (v.summary as string) ?? userMsg,
                        before: v.prompt_before as string,
                        after: (v.proposed_prompt as string) ?? "",
                        appliedAt: v.applied_at as string | null,
                      })
                    }
                    className="text-[10px] font-medium text-primary hover:underline"
                  >
                    Ver alterações
                  </button>
                  {idx > 0 && (
                    <button
                      disabled={restoring !== null}
                      onClick={() => void restore(v.id as string, "before")}
                      className="rounded-md border border-rose-200 bg-rose-50 px-2 py-0.5 text-[10px] font-semibold text-rose-700 hover:bg-rose-100 disabled:opacity-60"
                    >
                      ↶ Restaurar estado anterior a essa edição
                    </button>
                  )}
                  {idx > 0 && (
                    <button
                      disabled={restoring !== null}
                      onClick={() => void restore(v.id as string, "after")}
                      className="rounded-md border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[10px] font-semibold text-emerald-700 hover:bg-emerald-100 disabled:opacity-60"
                    >
                      Restaurar para esta versão
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        {/* Modal: preview de uma versão antiga */}
        {previewing && (
          <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-4">
            <div className="flex max-h-[90vh] w-full max-w-2xl flex-col rounded-xl border bg-white shadow-2xl">
              <div className="flex items-center justify-between border-b px-5 py-3">
                <div>
                  <h3 className="text-base font-semibold">Alterações desta versão</h3>
                  {previewing.appliedAt && (
                    <p className="text-[11px] text-muted-foreground">
                      {new Date(previewing.appliedAt).toLocaleString("pt-BR")}
                    </p>
                  )}
                </div>
                <button onClick={() => setPreviewing(null)} className="text-muted-foreground hover:text-foreground">
                  ✕
                </button>
              </div>
              <div className="flex-1 overflow-y-auto p-5 space-y-3">
                <div className="rounded-md border bg-slate-50 p-3 text-sm text-slate-800">
                  {previewing.summary}
                </div>
                <DiffPreviewBlock before={previewing.before} after={previewing.after} />
              </div>
            </div>
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}

// =================================================================
// AI Magic Sheet — chat lateral para ajustar o prompt via GPT-4
// =================================================================

interface AiMagicMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  proposed_prompt?: string;
  prompt_before?: string;
  sections_changed?: string[];
  reasoning?: string;
  request_id?: string;
  no_changes?: boolean;
  applied?: boolean;
}

// Componente: preview compacto + modal expandido com diff completo
function DiffPreviewBlock({ before, after }: { before: string; after: string }) {
  const [modalOpen, setModalOpen] = useState(false);
  const ops = useMemo(() => lineDiff(before, after), [before, after]);
  const blocks = useMemo(() => diffChangeBlocks(ops, 1), [ops]);
  const stats = useMemo(() => diffStats(ops), [ops]);

  // Mostra no preview: primeiros 2 blocos OU primeiras ~8 linhas alteradas
  const previewBlocks = blocks.slice(0, 2);
  const restCount = blocks.length - previewBlocks.length;

  if (stats.changed_lines === 0) {
    return <p className="text-[11px] text-muted-foreground italic">Sem alterações de texto.</p>;
  }

  return (
    <>
      <div className="space-y-1.5">
        <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
          {stats.added > 0 && (
            <span className="rounded-full bg-emerald-100 px-2 py-0.5 font-semibold text-emerald-700">
              +{stats.added} linha{stats.added > 1 ? "s" : ""}
            </span>
          )}
          {stats.removed > 0 && (
            <span className="rounded-full bg-rose-100 px-2 py-0.5 font-semibold text-rose-700">
              −{stats.removed} linha{stats.removed > 1 ? "s" : ""}
            </span>
          )}
        </div>

        <div className="overflow-hidden rounded-md border border-slate-200 bg-slate-50 font-mono text-[10px] leading-relaxed">
          {previewBlocks.map((block, bi) => (
            <div key={bi} className={bi > 0 ? "border-t border-dashed border-slate-200" : ""}>
              {block.slice(0, 8).map((op, oi) => (
                <DiffLine key={oi} op={op} />
              ))}
              {block.length > 8 && (
                <div className="bg-slate-100 px-2 py-0.5 text-[10px] text-muted-foreground italic">
                  … +{block.length - 8} linhas
                </div>
              )}
            </div>
          ))}
        </div>

        {(restCount > 0 || blocks.some((b) => b.length > 8)) && (
          <button
            onClick={() => setModalOpen(true)}
            className="text-[11px] text-primary hover:underline"
          >
            Ver alterações completas{restCount > 0 ? ` (${restCount} bloco${restCount > 1 ? "s" : ""} a mais)` : ""}
          </button>
        )}
        {restCount === 0 && !blocks.some((b) => b.length > 8) && (
          <button
            onClick={() => setModalOpen(true)}
            className="text-[11px] text-muted-foreground hover:text-primary"
          >
            Ver em tela cheia
          </button>
        )}
      </div>

      {/* Modal com diff completo */}
      <Sheet open={modalOpen} onOpenChange={(v) => !v && setModalOpen(false)}>
        <SheetContent side="right" className="w-full p-0 sm:max-w-2xl flex flex-col">
          <SheetHeader className="border-b px-5 py-3">
            <SheetTitle className="text-base">Alterações propostas</SheetTitle>
            <div className="flex items-center gap-2 text-xs">
              {stats.added > 0 && (
                <span className="rounded-full bg-emerald-100 px-2 py-0.5 font-semibold text-emerald-700">
                  +{stats.added}
                </span>
              )}
              {stats.removed > 0 && (
                <span className="rounded-full bg-rose-100 px-2 py-0.5 font-semibold text-rose-700">
                  −{stats.removed}
                </span>
              )}
              <span className="text-muted-foreground">{blocks.length} bloco{blocks.length > 1 ? "s" : ""} alterado{blocks.length > 1 ? "s" : ""}</span>
            </div>
          </SheetHeader>
          <div className="flex-1 overflow-y-auto font-mono text-[11px] leading-relaxed">
            {blocks.map((block, bi) => (
              <div key={bi} className={bi > 0 ? "border-t-2 border-slate-200" : ""}>
                <div className="sticky top-0 z-10 bg-slate-100 px-3 py-1 text-[10px] font-semibold uppercase tracking-wider text-slate-500">
                  Bloco {bi + 1} de {blocks.length}
                </div>
                {block.map((op, oi) => (
                  <DiffLine key={oi} op={op} />
                ))}
              </div>
            ))}
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
}

function DiffLine({ op }: { op: DiffOp }) {
  if (op.type === "add") {
    return (
      <div className="flex border-l-2 border-emerald-500 bg-emerald-50">
        <span className="select-none px-1.5 py-0.5 text-emerald-700">+</span>
        <span className="flex-1 whitespace-pre-wrap break-words py-0.5 pr-2 text-emerald-900">
          {op.text || " "}
        </span>
      </div>
    );
  }
  if (op.type === "remove") {
    return (
      <div className="flex border-l-2 border-rose-500 bg-rose-50">
        <span className="select-none px-1.5 py-0.5 text-rose-700">−</span>
        <span className="flex-1 whitespace-pre-wrap break-words py-0.5 pr-2 text-rose-900 line-through decoration-rose-400/60">
          {op.text || " "}
        </span>
      </div>
    );
  }
  return (
    <div className="flex">
      <span className="select-none px-1.5 py-0.5 text-slate-400"> </span>
      <span className="flex-1 whitespace-pre-wrap break-words py-0.5 pr-2 text-slate-500">
        {op.text || " "}
      </span>
    </div>
  );
}

function AiMagicSheet({
  open,
  onClose,
  accountId,
  agentId,
  onApplied,
}: {
  open: boolean;
  onClose: () => void;
  accountId: string;
  agentId: string;
  onApplied: (newPrompt: string) => void;
}) {
  const requestFn = useServerFn(requestPromptEdit);
  const applyFn = useServerFn(applyPromptEdit);
  const historyFn = useServerFn(listAiMagicHistory);
  const suggestionsFn = useServerFn(getAiMagicSuggestions);
  const uploadMediaFn = useServerFn(uploadAgentMedia);

  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<AiMagicMessage[]>([]);
  const [pending, setPending] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const mediaInputRef = useRef<HTMLInputElement>(null);

  // Dialog de upload de mídia (acionado pelo botão 📎)
  const [pendingMedia, setPendingMedia] = useState<{
    file: File;
    title: string;
    description: string;
    moment: string;
  } | null>(null);
  const [uploadingMedia, setUploadingMedia] = useState(false);

  async function confirmMediaUpload() {
    if (!pendingMedia || !pendingMedia.title.trim() || uploadingMedia) return;
    setUploadingMedia(true);
    try {
      const base64 = await new Promise<string>((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(String(r.result));
        r.onerror = reject;
        r.readAsDataURL(pendingMedia.file);
      });
      const result = await uploadMediaFn({
        data: {
          agentId,
          filename: pendingMedia.file.name,
          fileBase64: base64,
          title: pendingMedia.title.trim(),
          description: pendingMedia.description.trim() || undefined,
        },
      });

      // Monta o pedido de edição de prompt pré-preenchido para o AI Magic
      const moment = pendingMedia.moment.trim() || "no momento adequado da conversa";
      const promptRequest = `Acabei de cadastrar uma nova mídia para esse agente. Slug: \`${result.slug}\`. Título: "${pendingMedia.title.trim()}". ${pendingMedia.description.trim() ? `Quando usar: ${pendingMedia.description.trim()}.` : ""} Por favor, ajuste o prompt do agente para que ele chame a tool \`enviar_midia\` com o slug \`${result.slug}\` ${moment}. Mantenha o fluxo natural — a tool deve ser acionada quando fizer sentido na conversa, sem soar forçado.`;

      setInput(promptRequest);
      setPendingMedia(null);
      toast.success(`Mídia "${pendingMedia.title.trim()}" enviada.`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Erro no upload");
    } finally {
      setUploadingMedia(false);
    }
  }

  // Carrega histórico ao abrir
  const historyQ = useQuery({
    queryKey: ["ai-magic-history", agentId],
    queryFn: () => historyFn({ data: { agentId, limit: 20 } }),
    enabled: open,
  });

  // Carrega sugestões contextuais (cache de 10min para evitar custo repetido)
  const suggestionsQ = useQuery({
    queryKey: ["ai-magic-suggestions", agentId],
    queryFn: () => suggestionsFn({ data: { accountId, agentId } }),
    enabled: open && messages.length === 0,
    staleTime: 10 * 60 * 1000,
  });

  useEffect(() => {
    if (!open) return;
    if (historyQ.data?.items && messages.length === 0) {
      // Converte histórico em mensagens cronológicas
      const past: AiMagicMessage[] = [];
      const items = [...historyQ.data.items].reverse();
      for (const it of items) {
        past.push({ id: `u-${it.id}`, role: "user", text: it.user_message });
        past.push({
          id: `a-${it.id}`,
          role: "assistant",
          text: it.summary ?? (it.error ? `Erro: ${it.error}` : "(sem resposta)"),
          sections_changed: (it.sections_changed as string[]) ?? [],
          applied: !!it.applied,
        });
      }
      if (past.length > 0) setMessages(past);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, historyQ.data]);

  // Scroll para o fim quando mudam mensagens
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, pending]);

  async function send() {
    const text = input.trim();
    if (!text || pending) return;
    setInput("");
    const userMsg: AiMagicMessage = { id: `u-${Date.now()}`, role: "user", text };
    setMessages((prev) => [...prev, userMsg]);
    setPending(true);
    try {
      const res = await requestFn({
        data: { accountId, agentId, userMessage: text },
      });
      const asstMsg: AiMagicMessage = {
        id: `a-${Date.now()}`,
        role: "assistant",
        text: res.summary || (res.no_changes ? "Sem alterações propostas." : "(resposta vazia)"),
        proposed_prompt: res.proposed_prompt,
        prompt_before: res.prompt_before,
        sections_changed: res.sections_changed,
        reasoning: res.reasoning,
        request_id: res.request_id,
        no_changes: res.no_changes,
        applied: false,
      };
      setMessages((prev) => [...prev, asstMsg]);
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);
      setMessages((prev) => [
        ...prev,
        { id: `e-${Date.now()}`, role: "assistant", text: `❌ ${errMsg}` },
      ]);
    } finally {
      setPending(false);
    }
  }

  async function apply(msg: AiMagicMessage) {
    if (!msg.request_id || !msg.proposed_prompt || msg.applied) return;
    try {
      await applyFn({ data: { requestId: msg.request_id } });
      setMessages((prev) =>
        prev.map((m) => (m.id === msg.id ? { ...m, applied: true } : m)),
      );
      onApplied(msg.proposed_prompt);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Erro ao aplicar");
    }
  }

  return (
    <Sheet open={open} onOpenChange={(v) => !v && onClose()}>
      <SheetContent side="right" className="flex w-full flex-col gap-0 p-0 sm:max-w-md">
        <SheetHeader className="border-b px-5 py-4">
          <SheetTitle className="flex items-center gap-2">
            <Zap className="h-4 w-4 text-primary" />
            AI Magic
            <span className="ml-2 rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-medium text-primary">
              GPT-4
            </span>
          </SheetTitle>
          <p className="text-xs text-muted-foreground">
            Peça ajustes em linguagem natural. O assistente analisa o prompt e
            mostra as mudanças antes de aplicar.
          </p>
        </SheetHeader>

        {/* Mensagens */}
        <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
          {messages.length === 0 && !pending && (
            <div className="mt-6 text-center text-xs text-muted-foreground space-y-2">
              <p className="font-medium text-foreground">Como posso ajudar?</p>
              {suggestionsQ.isLoading ? (
                <div className="flex flex-col items-center gap-2 py-4">
                  <Loader2 className="h-4 w-4 animate-spin text-primary" />
                  <p className="text-[11px]">Analisando seu prompt para sugerir ajustes…</p>
                </div>
              ) : suggestionsQ.data?.suggestions && suggestionsQ.data.suggestions.length > 0 ? (
                <>
                  <p>Sugestões baseadas no seu prompt:</p>
                  <div className="space-y-1.5 mt-2">
                    {suggestionsQ.data.suggestions.map((ex) => (
                      <button
                        key={ex}
                        onClick={() => setInput(ex)}
                        className="block w-full rounded-md border border-slate-200 bg-slate-50 px-2.5 py-1.5 text-left text-[11px] hover:bg-slate-100 hover:border-primary/40 transition-colors"
                      >
                        {ex}
                      </button>
                    ))}
                  </div>
                  <p className="text-[10px] text-muted-foreground/70 mt-2">
                    💡 Clique numa sugestão para usar como ponto de partida
                  </p>
                </>
              ) : (
                <p className="text-[11px]">
                  Descreva o que quer ajustar — ex: "mude o tom", "adicione objeção sobre preço"…
                </p>
              )}
            </div>
          )}

          {messages.map((m) =>
            m.role === "user" ? (
              <div key={m.id} className="flex justify-end">
                <div className="max-w-[85%] rounded-2xl rounded-tr-sm bg-primary px-3 py-2 text-xs text-white">
                  {m.text}
                </div>
              </div>
            ) : (
              <div key={m.id} className="flex justify-start">
                <div className="max-w-[90%] space-y-2">
                  <div className="rounded-2xl rounded-tl-sm border border-slate-200 bg-white px-3 py-2 text-xs text-slate-800">
                    {m.text}
                  </div>
                  {m.sections_changed && m.sections_changed.length > 0 && (
                    <div className="ml-1 flex flex-wrap gap-1">
                      {m.sections_changed.map((s) => (
                        <span
                          key={s}
                          className="inline-flex items-center rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-medium text-amber-800"
                        >
                          {s}
                        </span>
                      ))}
                    </div>
                  )}
                  {m.reasoning && (
                    <p className="ml-1 text-[10px] italic text-muted-foreground">
                      💡 {m.reasoning}
                    </p>
                  )}
                  {m.proposed_prompt && m.prompt_before && !m.no_changes && (
                    <div className="ml-1">
                      <DiffPreviewBlock before={m.prompt_before} after={m.proposed_prompt} />
                    </div>
                  )}
                  {m.proposed_prompt && !m.no_changes && (
                    <div className="ml-1 flex gap-2">
                      <Button
                        size="sm"
                        onClick={() => void apply(m)}
                        disabled={m.applied}
                        className="h-7 px-2 text-[11px]"
                      >
                        {m.applied ? (
                          <>
                            <Check className="mr-1 h-3 w-3" /> Aplicado
                          </>
                        ) : (
                          "Aplicar"
                        )}
                      </Button>
                      <button
                        onClick={() => setMessages((prev) => prev.filter((x) => x.id !== m.id))}
                        className="text-[11px] text-muted-foreground hover:text-foreground"
                      >
                        Descartar
                      </button>
                    </div>
                  )}
                </div>
              </div>
            ),
          )}

          {pending && (
            <div className="flex justify-start">
              <div className="flex items-center gap-2 rounded-2xl rounded-tl-sm border border-slate-200 bg-white px-3 py-2 text-xs text-muted-foreground">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                Analisando o prompt…
              </div>
            </div>
          )}
        </div>

        {/* Input */}
        <div className="border-t bg-white p-3">
          <div className="flex gap-2">
            <input
              ref={mediaInputRef}
              type="file"
              accept="image/*,video/*,audio/*,application/pdf"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) {
                  setPendingMedia({
                    file: f,
                    title: f.name.replace(/\.[^.]+$/, ""),
                    description: "",
                    moment: "",
                  });
                }
              }}
            />
            <button
              onClick={() => mediaInputRef.current?.click()}
              title="Anexar mídia para o agente enviar"
              disabled={pending}
              className="flex h-9 w-9 items-end justify-center self-end rounded-md text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-700 disabled:opacity-60"
            >
              <span className="pb-1.5 text-lg">📎</span>
            </button>
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void send();
                }
              }}
              placeholder="O que quer ajustar no prompt?"
              rows={2}
              disabled={pending}
              className="flex-1 resize-none rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm outline-none focus:border-primary focus:ring-1 focus:ring-primary/20 disabled:opacity-60"
            />
            <Button
              onClick={() => void send()}
              disabled={!input.trim() || pending}
              size="sm"
              className="self-end"
            >
              {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : "Enviar"}
            </Button>
          </div>
          <p className="mt-1.5 text-[10px] text-muted-foreground">
            ⏎ envia · Shift+⏎ nova linha · 📎 anexa mídia · GPT-4 analisa e propõe a edição
          </p>
        </div>

        {/* Dialog: upload de mídia (acionado pelo 📎) */}
        {pendingMedia && (
          <div className="absolute inset-0 z-30 flex items-end justify-center bg-black/50 p-4 sm:items-center">
            <div className="w-full max-w-md rounded-xl border bg-white p-5 shadow-2xl">
              <div className="mb-3 flex items-start gap-2">
                <span className="text-xl">📎</span>
                <div>
                  <p className="text-sm font-semibold">Anexar mídia ao prompt</p>
                  <p className="text-[11px] text-muted-foreground truncate">
                    {pendingMedia.file.name}
                  </p>
                </div>
              </div>
              <div className="space-y-3">
                <div>
                  <Label className="text-xs">Título *</Label>
                  <Input
                    value={pendingMedia.title}
                    onChange={(e) =>
                      setPendingMedia((p) => (p ? { ...p, title: e.target.value } : p))
                    }
                    placeholder="Ex: Antes e depois implante"
                    className="mt-1"
                  />
                </div>
                <div>
                  <Label className="text-xs">Quando enviar essa mídia? *</Label>
                  <textarea
                    value={pendingMedia.moment}
                    onChange={(e) =>
                      setPendingMedia((p) => (p ? { ...p, moment: e.target.value } : p))
                    }
                    placeholder="Ex: quando o lead demonstrar interesse em ver casos reais"
                    rows={2}
                    className="mt-1 w-full resize-none rounded-md border border-slate-200 px-3 py-2 text-sm outline-none focus:border-primary"
                  />
                  <p className="mt-0.5 text-[10px] text-muted-foreground">
                    O AI Magic vai usar isso para inserir a chamada da tool no momento certo do prompt.
                  </p>
                </div>
                <div>
                  <Label className="text-xs">Descrição (opcional)</Label>
                  <textarea
                    value={pendingMedia.description}
                    onChange={(e) =>
                      setPendingMedia((p) => (p ? { ...p, description: e.target.value } : p))
                    }
                    placeholder="Detalhe adicional sobre o conteúdo da mídia"
                    rows={2}
                    className="mt-1 w-full resize-none rounded-md border border-slate-200 px-3 py-2 text-sm outline-none focus:border-primary"
                  />
                </div>
              </div>
              <div className="mt-4 flex justify-end gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setPendingMedia(null)}
                  disabled={uploadingMedia}
                >
                  Cancelar
                </Button>
                <Button
                  size="sm"
                  onClick={() => void confirmMediaUpload()}
                  disabled={!pendingMedia.title.trim() || !pendingMedia.moment.trim() || uploadingMedia}
                >
                  {uploadingMedia && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
                  Anexar e gerar ajuste
                </Button>
              </div>
              <p className="mt-2 text-[10px] text-muted-foreground">
                A mídia será salva na biblioteca do agente, e um pedido será preenchido no chat para o GPT-4 inserir a chamada da tool <code>enviar_midia</code> no momento certo do prompt.
              </p>
            </div>
          </div>
        )}
      </SheetContent>
    </Sheet>
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

/** Catálogo de tools disponíveis no sistema, agrupadas por integração. */
const PROMPT_TOOLS: { group: string; tools: { name: string; desc: string }[] }[] = [
  {
    group: "Clinicorp — Agendamento",
    tools: [
      { name: "buscar_paciente",               desc: "Verifica se o lead já é paciente cadastrado" },
      { name: "listar_horarios",                desc: "Lista horários disponíveis nos próximos dias" },
      { name: "criar_agendamento",              desc: "Cria a consulta com os dados coletados" },
      { name: "buscar_agendamentos_clinicorp",  desc: "Lista agendamentos futuros do paciente" },
      { name: "cancelar_agendamento_clinicorp", desc: "Cancela um agendamento existente" },
    ],
  },
  {
    group: "Clinup — Agendamento",
    tools: [
      { name: "clinup_buscar_horarios",  desc: "Lista horários disponíveis no Clinup" },
      { name: "clinup_agendar",          desc: "Cria consulta no Clinup" },
      { name: "clinup_buscar_consultas", desc: "Lista consultas futuras do paciente" },
      { name: "clinup_gerir_consulta",   desc: "Confirma, cancela ou reagenda consulta" },
    ],
  },
  {
    group: "Google Agenda",
    tools: [
      { name: "listar_horarios_google_calendar", desc: "Lista horários livres no Google Calendar" },
      { name: "agendar_google_calendar",         desc: "Cria evento no Google Calendar" },
    ],
  },
  {
    group: "Qualificação",
    tools: [
      { name: "aplicar_tag_interesse", desc: "Aplica tag de qualificação no contato (Helena CRM)" },
    ],
  },
  {
    group: "Escalada Humana",
    tools: [
      { name: "escalar_humano", desc: "Pausa a IA e alerta equipe via Evolution API" },
    ],
  },
  {
    group: "Helena CRM",
    tools: [
      { name: "helena_listar_tags",  desc: "Lista as tags atuais do contato" },
      { name: "helena_add_tags",     desc: "Adiciona tags ao contato" },
      { name: "salvar_telefone_lead", desc: "Salva/confirma o telefone WhatsApp do lead" },
    ],
  },
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
  onAiMagic,
  onHistory,
  configuredIntegrations,
}: {
  initialContent: string;
  onChange: (md: string) => void;
  charCount: number;
  saveState: "saved" | "unsaved" | "saving";
  autosave: boolean;
  onAutosaveChange: (v: boolean) => void;
  onSave: () => void;
  onAiMagic?: () => void;
  onHistory?: () => void;
  configuredIntegrations?: { clinicorp: boolean; clinup: boolean; google_calendar: boolean };
}) {
  const [showColorPicker, setShowColorPicker] = useState<"text" | "highlight" | null>(null);
  const [showToolsPicker, setShowToolsPicker] = useState(false);
  const toolsPickerRef = useRef<HTMLDivElement>(null);

  // Fecha o tools picker ao clicar fora — sem overlay que bloqueia scroll
  useEffect(() => {
    if (!showToolsPicker) return;
    function handleOutside(e: MouseEvent) {
      if (toolsPickerRef.current && !toolsPickerRef.current.contains(e.target as Node)) {
        setShowToolsPicker(false);
      }
    }
    document.addEventListener("mousedown", handleOutside);
    return () => document.removeEventListener("mousedown", handleOutside);
  }, [showToolsPicker]);

  // Filtra os grupos de tools pelas integrações configuradas neste agente.
  // Grupos "sempre visíveis": Qualificação, Escalada e Helena CRM.
  const visibleTools = useMemo(() => {
    const ci = configuredIntegrations;
    return PROMPT_TOOLS.filter((g) => {
      if (g.group.startsWith("Clinicorp")) return !!ci?.clinicorp;
      if (g.group.startsWith("Clinup"))    return !!ci?.clinup;
      if (g.group.startsWith("Google"))    return !!ci?.google_calendar;
      return true; // Qualificação, Escalada, Helena — sempre
    });
  }, [configuredIntegrations]);

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
        // +4pt em relação ao padrão (14px → ~19px). 1rem ≈ 16px; usamos px para travar.
        style: "min-height: calc(100vh - 320px); font-size: 18px; line-height: 1.6;",
      },
    },
  });

  // Sincroniza conteúdo externo (template aplicado) sem mexer no cursor quando
  // o usuário está digitando. Só chama setContent se o markdown atual do editor
  // realmente difere do novo initialContent — assim, edições locais que voltam
  // como initialContent prop NÃO disparam reset de cursor.
  const prevContent = useRef(initialContent);
  useEffect(() => {
    if (!editor) return;
    if (initialContent === prevContent.current) return;
    prevContent.current = initialContent;

    const mdStorage = editor.storage as { markdown?: { getMarkdown: () => string } };
    const currentMd = mdStorage.markdown?.getMarkdown() ?? editor.getText();
    if (currentMd.trim() === initialContent.trim()) return;

    // Preserva a posição do cursor quando o conteúdo precisar ser realmente recarregado
    const { from, to } = editor.state.selection;
    editor.commands.setContent(initialContent, { emitUpdate: false });
    try {
      editor.commands.setTextSelection({ from, to });
    } catch {
      /* posição inválida após reset — ignora */
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

        {/* Tools inserter */}
        <div className="relative" ref={toolsPickerRef}>
          <button
            title="Inserir tool no prompt"
            onMouseDown={(e) => {
              e.preventDefault();
              setShowToolsPicker((v) => !v);
              setShowColorPicker(null);
            }}
            className={`flex items-center gap-1 rounded px-2 py-1.5 text-xs font-semibold transition-colors ${showToolsPicker ? "bg-primary/10 text-primary" : "text-slate-600 hover:bg-slate-100"}`}
          >
            <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 fill-none stroke-current stroke-[1.75]"><path d="M14.7 6.3a1 1 0 000 1.4l1.6 1.6a1 1 0 001.4 0l3.77-3.77a6 6 0 01-7.94 7.94l-6.91 6.91a2.12 2.12 0 01-3-3l6.91-6.91a6 6 0 017.94-7.94l-3.76 3.76z" strokeLinecap="round" strokeLinejoin="round"/></svg>
            Tools
            <span className="text-slate-400">▾</span>
          </button>

          {showToolsPicker && (
            <div className="absolute left-0 top-full z-50 mt-1 w-[420px] rounded-xl border border-slate-200 bg-white shadow-2xl">
              {visibleTools.length === 0 ? (
                <div className="px-4 py-6 text-center">
                  <p className="text-xs font-medium text-slate-500">Nenhuma integração configurada</p>
                  <p className="mt-1 text-[11px] text-slate-400">Configure uma integração para ver as tools disponíveis.</p>
                </div>
              ) : (
                <div className="max-h-[420px] overflow-y-auto overscroll-contain rounded-xl">
                  {visibleTools.map((group) => (
                    <div key={group.group}>
                      <div className="sticky top-0 bg-slate-50 px-3 py-2 border-b border-slate-100">
                        <p className="text-[10px] font-bold uppercase tracking-wider text-slate-500">{group.group}</p>
                      </div>
                      {group.tools.map((tool) => (
                        <button
                          key={tool.name}
                          type="button"
                          onMouseDown={(e) => {
                            // onMouseDown + preventDefault preserva o foco do editor
                            e.preventDefault();
                            editor.chain().focus().insertContent(
                              `<code>${tool.name}</code>&nbsp;`
                            ).run();
                            setShowToolsPicker(false);
                          }}
                          className="flex w-full flex-col gap-0.5 px-3 py-2 text-left hover:bg-primary/5 active:bg-primary/10 transition-colors border-b border-slate-50 last:border-0"
                        >
                          <code className="inline-flex items-center rounded-md border border-slate-200 bg-slate-100 px-2 py-0.5 font-mono text-[10px] font-semibold text-primary w-fit">
                            {tool.name}
                          </code>
                          <span className="text-[11px] text-slate-500 leading-snug">{tool.desc}</span>
                        </button>
                      ))}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        <div className="mx-1 h-4 w-px bg-slate-200" />

        {/* Histórico de versões */}
        {onHistory && (
          <button
            onClick={onHistory}
            title="Histórico de versões — restaurar estado anterior"
            className="flex items-center gap-1 rounded-full border border-slate-200 px-2.5 py-1 text-xs font-medium text-slate-600 hover:bg-slate-50"
          >
            <RotateCcw className="h-3 w-3" />
            Histórico
          </button>
        )}

        {/* AI Magic */}
        <button
          onClick={onAiMagic ?? (() => toast.info("AI Magic indisponível"))}
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

      {/* Click outside to close color picker */}
      {showColorPicker && (
        <div className="fixed inset-0 z-10" onClick={() => { setShowColorPicker(null); }} />
      )}

      {/* Editor area — code chips, headings e listas estilizados */}
      <div className="flex-1 overflow-y-auto [&_.ProseMirror_code]:mx-0.5 [&_.ProseMirror_code]:inline-flex [&_.ProseMirror_code]:items-center [&_.ProseMirror_code]:rounded-md [&_.ProseMirror_code]:border [&_.ProseMirror_code]:border-slate-200 [&_.ProseMirror_code]:bg-slate-100 [&_.ProseMirror_code]:px-1.5 [&_.ProseMirror_code]:py-0.5 [&_.ProseMirror_code]:font-mono [&_.ProseMirror_code]:text-[10px] [&_.ProseMirror_code]:font-semibold [&_.ProseMirror_code]:text-primary [&_.ProseMirror_code]:not-italic">
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
  const listClinProfsFn = useServerFn(listClinicorpProfessionalsFn);
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
    // Persistir JSON do horário de funcionamento quando preenchido via editor estruturado
    if (varValues.business_hours_json) {
      settingsToSave.business_hours_json = varValues.business_hours_json;
    }
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

                // ── Editor estruturado de horários ──
                // Aceita tanto v.key === "business_hours" quanto v.settings_key === "business_hours"
                // (no template Clinicorp/Google a key é HORARIOS_FUNCIONAMENTO mas o settings_key é business_hours).
                const isBusinessHours =
                  v.key === "business_hours" || v.settings_key === "business_hours";
                if (isBusinessHours) {
                  return (
                    <div key={v.key} className="sm:col-span-2">
                      <label className="flex items-center gap-1.5 text-xs font-medium text-slate-700 mb-2">
                        {v.label}
                        {v.required && <span className="text-destructive">*</span>}
                        {prefilled && (
                          <span className="ml-auto inline-flex items-center gap-0.5 rounded-full bg-emerald-100 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700">
                            ✓ perfil
                          </span>
                        )}
                      </label>
                      <BusinessHoursEditor
                        jsonValue={
                          varValues.business_hours_json ||
                          agentSettings.business_hours_json ||
                          ""
                        }
                        onChange={(human, json) => {
                          setVarValues((p) => ({
                            ...p,
                            [v.key]: human,
                            business_hours_json: json,
                          }));
                        }}
                      />
                    </div>
                  );
                }

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
                disabled={(selected.variables ?? [])
                  .filter((v) => v.required)
                  .some((v) => {
                    // Business hours: aceita JSON do editor estruturado
                    const isBh = v.key === "business_hours" || v.settings_key === "business_hours";
                    if (isBh) {
                      return !(varValues.business_hours_json?.trim() || varValues[v.key]?.trim());
                    }
                    return !varValues[v.key]?.trim();
                  })}
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
              <p className="mb-3 text-xs font-semibold uppercase text-muted-foreground">Preview do prompt</p>
              <div className="max-h-56 overflow-y-auto">
                <PromptText
                  text={selected.system_prompt || "(sem prompt)"}
                />
              </div>
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
            listProfsFn={listClinProfsFn}
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
  listProfsFn,
  onSuccess,
  onSkip,
}: {
  accountId: string;
  saveFn: ReturnType<typeof useServerFn<typeof saveClinicorpConfig>>;
  testFn: ReturnType<typeof useServerFn<typeof testClinicorpConnection>>;
  listProfsFn: ReturnType<typeof useServerFn<typeof listClinicorpProfessionalsFn>>;
  onSuccess: () => void;
  onSkip: () => void;
}) {
  const [token, setToken] = useState("");
  const [subscriberId, setSubscriberId] = useState("");
  const [businessId, setBusinessId] = useState("");
  const [codeLink, setCodeLink] = useState("");
  const [selectedProfIds, setSelectedProfIds] = useState<number[]>([]);
  const [professionals, setProfessionals] = useState<{ id: number; name: string }[]>([]);
  const [loadingProfs, setLoadingProfs] = useState(false);
  const [tokenSaved, setTokenSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testResult, setTestResult] = useState<string | null>(null);

  function toggleProf(id: number) {
    setSelectedProfIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );
  }

  async function doLoadProfs() {
    setLoadingProfs(true);
    setProfessionals([]);
    const r = await listProfsFn({ data: { accountId } });
    if (r.ok) setProfessionals(r.professionals);
    else toast.error(r.error ?? "Erro ao carregar profissionais.");
    setLoadingProfs(false);
  }

  async function handleSave() {
    setSaving(true);
    try {
      await saveFn({
        data: {
          accountId,
          ...(token ? { api_token: token } : {}),
          subscriber_id: subscriberId || undefined,
          business_id: businessId ? Number(businessId) : undefined,
          code_link: codeLink || undefined,
          profissional_ids: selectedProfIds,
          ativo: true,
        },
      });
      toast.success("Clinicorp configurado!");
      setTokenSaved(true);
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

      {/* Token */}
      <div>
        <Label className="text-xs font-semibold">Token API (Basic auth base64)</Label>
        <Input
          type="password"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder="cole o token Basic auth aqui"
          className="mt-1"
        />
      </div>

      {/* Subscriber ID + Business ID */}
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

      {/* Code Link */}
      <div>
        <Label className="text-xs font-semibold">
          Code Link{" "}
          <span className="font-normal text-muted-foreground">(agenda online)</span>
        </Label>
        <Input
          value={codeLink}
          onChange={(e) => setCodeLink(e.target.value)}
          placeholder="ex: 73828"
          className="mt-1"
        />
        <p className="text-[10px] text-muted-foreground mt-1">
          Código da agenda que libera horários para agendamento por API.
        </p>
      </div>

      {/* Profissionais — múltipla seleção */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <Label className="text-xs font-semibold">
            Profissionais{" "}
            <span className="font-normal text-muted-foreground">(opcional — marque os desejados)</span>
          </Label>
          {token && (
            <button
              type="button"
              onClick={doLoadProfs}
              disabled={loadingProfs}
              className="text-[10px] text-blue-600 hover:underline disabled:opacity-50"
            >
              {loadingProfs ? "Carregando..." : "↻ Carregar profissionais"}
            </button>
          )}
        </div>

        {!token && professionals.length === 0 ? (
          <p className="text-[10px] text-muted-foreground">
            Preencha o token acima para carregar os profissionais.
          </p>
        ) : loadingProfs ? (
          <p className="text-[10px] text-muted-foreground">Carregando profissionais...</p>
        ) : professionals.length === 0 ? (
          <p className="text-[10px] text-muted-foreground">
            Clique em ↻ Carregar profissionais após preencher o token.
          </p>
        ) : (
          <div className="rounded-lg border border-slate-200 divide-y divide-slate-100 max-h-48 overflow-y-auto">
            {professionals.map((p) => {
              const checked = selectedProfIds.includes(p.id);
              return (
                <label
                  key={p.id}
                  className="flex items-center gap-3 px-3 py-2.5 cursor-pointer hover:bg-slate-50 transition-colors"
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => toggleProf(p.id)}
                    className="h-4 w-4 rounded border-slate-300 accent-slate-800"
                  />
                  <span className="text-sm">{p.name}</span>
                </label>
              );
            })}
          </div>
        )}

        {selectedProfIds.length > 0 && professionals.length > 0 && (
          <p className="text-[10px] text-muted-foreground mt-1">
            {selectedProfIds.length} profissional{selectedProfIds.length > 1 ? "is" : ""} selecionado{selectedProfIds.length > 1 ? "s" : ""}.
            Deixe todos desmarcados para usar qualquer profissional disponível.
          </p>
        )}
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
  const getStatus = useServerFn(getGoogleCalendarStatusFn);
  const listCalendars = useServerFn(listGoogleCalendarsFn);
  const selectCalendar = useServerFn(selectGoogleCalendarFn);
  const [connecting, setConnecting] = useState(false);

  // Status da conexão Google
  const statusQ = useQuery({
    queryKey: ["gcal-status", accountId],
    queryFn: () => getStatus({ data: { accountId } }),
  });

  // Calendários disponíveis (só busca quando conectado)
  const calendarsQ = useQuery({
    queryKey: ["gcal-list", accountId],
    queryFn: () => listCalendars({ data: { accountId } }),
    enabled: !!statusQ.data?.connected,
  });

  const selectM = useMutation({
    mutationFn: (input: { calendarId: string; calendarName: string }) =>
      selectCalendar({ data: { accountId, ...input } }),
    onSuccess: () => {
      toast.success("Calendário selecionado");
      qc.invalidateQueries({ queryKey: ["gcal-status", accountId] });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Erro ao salvar"),
  });

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
          // Atualiza status + lista — NÃO chama onSuccess ainda; usuário precisa
          // escolher o calendário primeiro.
          qc.invalidateQueries({ queryKey: ["gcal-status", accountId] });
          qc.invalidateQueries({ queryKey: ["gcal-list", accountId] });
        }
      }, 500);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error("[gcal-auth]", e);
      toast.error(`Erro ao gerar URL: ${msg.slice(0, 200)}`);
      setConnecting(false);
    }
  }

  const connected = !!statusQ.data?.connected;
  const hasCalendarSelected = !!statusQ.data?.calendarId && !!statusQ.data?.calendarName;

  // ── Estado: ainda não conectado ──
  if (!connected) {
    return (
      <div className="p-6 space-y-4">
        <div className="rounded-xl border border-blue-200 bg-blue-50 p-4">
          <p className="text-sm font-semibold text-blue-800">Este template requer o Google Calendar</p>
          <p className="mt-1 text-xs text-blue-700">
            Conecte sua conta Google. Depois você escolhe qual agenda o agente vai usar.
          </p>
        </div>
        <Button onClick={connect} disabled={connecting} className="w-full bg-blue-600 hover:bg-blue-700">
          {connecting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <ExternalLink className="mr-2 h-4 w-4" />}
          Conectar com Google
        </Button>
        <button onClick={onSkip} className="w-full text-center text-xs text-muted-foreground hover:text-foreground">
          Pular configuração e aplicar mesmo assim
        </button>
      </div>
    );
  }

  // ── Estado: conectado → mostrar seletor de calendário ──
  return (
    <div className="p-6 space-y-4">
      <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-4">
        <div className="flex items-center gap-2">
          <Check className="h-4 w-4 text-emerald-600" />
          <p className="text-sm font-semibold text-emerald-800">Conta Google conectada</p>
        </div>
        {statusQ.data?.email && (
          <p className="mt-1 text-xs text-emerald-700">Conta: {statusQ.data.email}</p>
        )}
      </div>

      <div className="space-y-2">
        <Label className="text-xs font-medium">Selecione a agenda para os agendamentos</Label>
        {calendarsQ.isLoading ? (
          <div className="flex items-center gap-2 rounded-md border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> Carregando agendas…
          </div>
        ) : calendarsQ.error ? (
          <p className="text-xs text-destructive">
            Erro ao listar agendas: {calendarsQ.error instanceof Error ? calendarsQ.error.message : "desconhecido"}
          </p>
        ) : (
          <>
            <select
              value={statusQ.data?.calendarId ?? ""}
              onChange={(e) => {
                const cal = calendarsQ.data?.calendars.find((c) => c.id === e.target.value);
                if (cal) selectM.mutate({ calendarId: cal.id, calendarName: cal.summary });
              }}
              disabled={selectM.isPending}
              className="w-full rounded-md border border-slate-200 bg-white px-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
            >
              <option value="" disabled>Selecione uma agenda...</option>
              {(calendarsQ.data?.calendars ?? []).map((c) => (
                <option key={c.id} value={c.id}>
                  {c.summary} {c.primary ? "(principal)" : ""}
                </option>
              ))}
            </select>
            <p className="text-[11px] text-muted-foreground">
              O agente buscará janelas livres e criará eventos nesta agenda.
            </p>
            {selectM.isPending && (
              <p className="flex items-center gap-1 text-[11px] text-muted-foreground">
                <Loader2 className="h-3 w-3 animate-spin" /> Salvando…
              </p>
            )}
          </>
        )}
      </div>

      <Button
        onClick={onSuccess}
        disabled={!hasCalendarSelected || selectM.isPending}
        className="w-full bg-blue-600 hover:bg-blue-700"
      >
        {hasCalendarSelected ? "Aplicar template" : "Selecione uma agenda para continuar"}
      </Button>

      <button onClick={onSkip} className="w-full text-center text-xs text-muted-foreground hover:text-foreground">
        Pular e aplicar mesmo assim
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
  configuredIntegrations,
  secretsLast4,
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
  configuredIntegrations: { clinicorp: boolean; clinup: boolean; google_calendar: boolean };
  secretsLast4: { openrouter: string | null; elevenlabs: string | null };
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
  // Combobox do modelo: busca + abre/fecha dropdown
  const [modelSearch, setModelSearch] = useState("");
  const [modelOpen, setModelOpen] = useState(false);

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

  // Modelos ordenados alfabeticamente + filtrados pela busca (case-insensitive,
  // busca em nome e id).
  const filteredSortedModels = useMemo(() => {
    const list = models.data?.models ?? [];
    const q = modelSearch.trim().toLowerCase();
    const filtered = !q
      ? list
      : list.filter(
          (m) =>
            m.name.toLowerCase().includes(q) ||
            m.id.toLowerCase().includes(q),
        );
    return [...filtered].sort((a, b) => a.name.localeCompare(b.name, "pt-BR"));
  }, [models.data, modelSearch]);

  const selectedModelLabel = useMemo(() => {
    const found = (models.data?.models ?? []).find((m) => m.id === model);
    return found?.name ?? model;
  }, [models.data, model]);

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
                {["company_name", "company_type", "company_address", "payment_methods", "featured_services"].map((key) => {
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

              {/* Horário de funcionamento — editor estruturado */}
              <div className="mt-4">
                <label className="block text-xs font-semibold text-slate-700 mb-2">
                  Horário de funcionamento
                </label>
                <BusinessHoursEditor
                  jsonValue={settings.business_hours_json ?? ""}
                  onChange={(human, json) => {
                    setSetting("business_hours", human);
                    setSetting("business_hours_json", json);
                  }}
                />
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
                  <div className="relative">
                    <input
                      type="text"
                      value={modelOpen ? modelSearch : selectedModelLabel}
                      onChange={(e) => {
                        setModelSearch(e.target.value);
                        setModelOpen(true);
                      }}
                      onFocus={() => {
                        setModelOpen(true);
                        setModelSearch("");
                      }}
                      placeholder={
                        model ? "Buscar outro modelo…" : "— buscar e escolher modelo —"
                      }
                      className="w-full rounded-xl border border-slate-200 bg-background px-4 py-2.5 text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
                    />
                    {modelOpen && (
                      <>
                        {/* clique fora fecha */}
                        <div
                          className="fixed inset-0 z-10"
                          onClick={() => {
                            setModelOpen(false);
                            setModelSearch("");
                          }}
                        />
                        <div className="absolute left-0 right-0 z-20 mt-1 max-h-72 overflow-y-auto rounded-xl border border-slate-200 bg-white shadow-xl">
                          {filteredSortedModels.length === 0 ? (
                            <div className="px-3 py-3 text-xs text-muted-foreground">
                              Nenhum modelo encontrado para "{modelSearch}".
                            </div>
                          ) : (
                            filteredSortedModels.map((m) => (
                              <button
                                key={m.id}
                                type="button"
                                onClick={() => {
                                  setModel(m.id);
                                  setModelOpen(false);
                                  setModelSearch("");
                                }}
                                className={`block w-full border-b border-slate-50 px-3 py-2 text-left text-sm transition-colors last:border-b-0 hover:bg-slate-50 ${
                                  m.id === model
                                    ? "bg-primary/5 text-primary"
                                    : "text-foreground"
                                }`}
                              >
                                <div className="font-medium">{m.name}</div>
                                <div className="font-mono text-[10px] text-muted-foreground">
                                  {m.id}
                                </div>
                              </button>
                            ))
                          )}
                        </div>
                      </>
                    )}
                  </div>
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

              <div className="border-t border-slate-100" />

              {/* Comandos pausar / reativar */}
              <div>
                <Label className="text-sm font-semibold">Comandos para pausar a IA</Label>
                <p className="mb-3 text-xs text-muted-foreground">
                  Defina <strong>qualquer frase</strong> que o lead envia no WhatsApp para pausar ou reativar a IA.
                  Ao pausar, a tag <strong>&quot;IA Desligada&quot;</strong> é aplicada no Helena (pausa silenciosa, sem mensagem automática). A comparação ignora maiúsculas, acentos e barra inicial (<code>/pausar</code> = <code>pausar</code>).
                  Vários comandos no mesmo campo: separe por vírgula (ex.: <code>/pausar, parar bot, stop</code>).
                  Se deixar vazio, o padrão é <code>/pausar</code> e <code>/ativar</code>.
                </p>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <div>
                    <Label className="text-xs text-muted-foreground">Comando(s) para pausar</Label>
                    <input
                      type="text"
                      value={settings.pause_command ?? ""}
                      onChange={(e) => setSetting("pause_command", e.target.value)}
                      placeholder="Ex.: /pausar ou a frase que você quiser"
                      className="mt-1 w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm shadow-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
                    />
                  </div>
                  <div>
                    <Label className="text-xs text-muted-foreground">Comando(s) para reativar</Label>
                    <input
                      type="text"
                      value={settings.resume_command ?? ""}
                      onChange={(e) => setSetting("resume_command", e.target.value)}
                      placeholder="Ex.: /ativar ou voltar ia"
                      className="mt-1 w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm shadow-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
                    />
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
            configuredIntegrations={configuredIntegrations}
            secretsLast4={secretsLast4}
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
  configuredIntegrations,
  secretsLast4,
}: {
  accountId: string;
  agentId: string;
  audioHabilitado: boolean;
  audioTranscrever: boolean;
  audioResponder: boolean;
  configuredIntegrations: { clinicorp: boolean; clinup: boolean; google_calendar: boolean };
  secretsLast4?: { openrouter: string | null; elevenlabs: string | null };
}) {
  const hasAny =
    configuredIntegrations.clinicorp ||
    configuredIntegrations.clinup ||
    configuredIntegrations.google_calendar;

  const [showSecrets, setShowSecrets] = useState(false);

  return (
    <div className="mx-auto max-w-2xl px-6 py-8 space-y-4">
      <div className="rounded-xl border border-primary/20 bg-primary/5 px-5 py-3.5">
        <p className="text-xs text-primary/80 leading-relaxed">
          <strong className="text-primary">Dica:</strong> Configure aqui os canais e ferramentas que seu assistente usa. Apenas as integrações do seu template estão disponíveis.
        </p>
      </div>

      {/* Custo de IA — últimos 30 dias */}
      <CostMiniCard accountId={accountId} />

      {/* Conexões (OpenRouter / ElevenLabs) */}
      <button
        onClick={() => setShowSecrets(true)}
        className="group w-full overflow-hidden rounded-2xl border border-amber-200/60 bg-gradient-to-r from-amber-50 to-orange-50 p-4 text-left shadow-sm transition-all duration-200 hover:-translate-y-0.5 hover:shadow-lg hover:shadow-amber-500/10"
      >
        <div className="flex items-center gap-3">
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-amber-400 to-orange-500 text-white shadow-md shadow-amber-500/30">
            <KeyRound className="h-5 w-5" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold text-foreground">Conexões de IA</p>
            <div className="mt-1 flex flex-wrap gap-2">
              <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium ${secretsLast4?.openrouter ? "bg-emerald-100 text-emerald-700" : "bg-red-100 text-red-600"}`}>
                <span className={`h-1 w-1 rounded-full ${secretsLast4?.openrouter ? "bg-emerald-500" : "bg-red-500"}`} />
                OpenRouter {secretsLast4?.openrouter ? `••${secretsLast4.openrouter}` : "não configurado"}
              </span>
              <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium ${secretsLast4?.elevenlabs ? "bg-emerald-100 text-emerald-700" : "bg-zinc-100 text-zinc-500"}`}>
                <span className={`h-1 w-1 rounded-full ${secretsLast4?.elevenlabs ? "bg-emerald-500" : "bg-zinc-400"}`} />
                ElevenLabs {secretsLast4?.elevenlabs ? `••${secretsLast4.elevenlabs}` : "não configurado"}
              </span>
            </div>
          </div>
          {!secretsLast4?.openrouter && (
            <AlertCircle className="h-5 w-5 shrink-0 text-amber-500" />
          )}
          <ArrowRight className="h-4 w-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-1" />
        </div>
      </button>

      <SecretsSheet
        open={showSecrets}
        onClose={() => setShowSecrets(false)}
        accountId={accountId}
        last4={{
          openrouter: secretsLast4?.openrouter ?? null,
          elevenlabs: secretsLast4?.elevenlabs ?? null,
          groq: null,
        }}
      />

      {/* Helena CRM — sempre visível */}
      <HelenaConfigPanel accountId={accountId} />

      {/* Áudio — sempre visível */}
      <AudioPanel
        accountId={accountId}
        initialHabilitado={audioHabilitado}
        initialTranscrever={audioTranscrever}
        initialResponder={audioResponder}
      />

      {/* Integrações de agendamento — condicionais ao template */}
      {configuredIntegrations.clinicorp && (
        <ClinicorpPanel accountId={accountId} />
      )}
      {configuredIntegrations.clinup && (
        <ClinupPanel accountId={accountId} />
      )}
      {configuredIntegrations.google_calendar && (
        <GoogleCalendarPanel accountId={accountId} />
      )}

      {/* Nenhuma integração configurada ainda */}
      {!hasAny && (
        <div className="rounded-xl border border-dashed border-slate-200 bg-slate-50 px-5 py-6 text-center">
          <p className="text-sm font-medium text-slate-500">Nenhuma integração de agendamento configurada</p>
          <p className="mt-1 text-xs text-slate-400">
            Aplique um template com integração (Clinicorp, Clinup ou Google Agenda) para ativar as ferramentas de agendamento.
          </p>
        </div>
      )}
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
  const listCalendars = useServerFn(listGoogleCalendarsFn);
  const selectCalendar = useServerFn(selectGoogleCalendarFn);

  const { data } = useQuery({
    queryKey: ["gcal-status", accountId],
    queryFn: () => getStatus({ data: { accountId } }),
  });

  // Lista de calendários só busca quando conectado
  const calendarsQ = useQuery({
    queryKey: ["gcal-list", accountId],
    queryFn: () => listCalendars({ data: { accountId } }),
    enabled: !!data?.connected,
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
          qc.invalidateQueries({ queryKey: ["gcal-list", accountId] });
        }
      }, 500);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error("[gcal-auth]", e);
      toast.error(`Erro ao gerar URL: ${msg.slice(0, 200)}`);
      setConnecting(false);
    }
  }

  const disconnectM = useMutation({
    mutationFn: () => disconnect({ data: { accountId } }),
    onSuccess: () => {
      toast.success("Google Calendar desconectado.");
      qc.invalidateQueries({ queryKey: ["gcal-status", accountId] });
      qc.invalidateQueries({ queryKey: ["gcal-list", accountId] });
    },
  });

  const selectM = useMutation({
    mutationFn: (input: { calendarId: string; calendarName: string }) =>
      selectCalendar({ data: { accountId, ...input } }),
    onSuccess: () => {
      toast.success("Calendário selecionado");
      qc.invalidateQueries({ queryKey: ["gcal-status", accountId] });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Erro ao salvar"),
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
                  <p className="text-sm font-medium text-emerald-800">Conta conectada</p>
                </div>
                {data.email && <p className="mt-1 text-xs text-muted-foreground">Conta: {data.email}</p>}
              </div>

              {/* Seletor de calendário */}
              <div className="space-y-1.5">
                <Label className="text-xs font-medium">Calendário usado para agendamentos</Label>
                {calendarsQ.isLoading ? (
                  <div className="flex items-center gap-2 rounded-md border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" /> Carregando calendários…
                  </div>
                ) : calendarsQ.error ? (
                  <p className="text-xs text-destructive">
                    Erro ao listar calendários: {calendarsQ.error instanceof Error ? calendarsQ.error.message : "desconhecido"}
                  </p>
                ) : (
                  <>
                    <select
                      value={data.calendarId ?? ""}
                      onChange={(e) => {
                        const cal = calendarsQ.data?.calendars.find((c) => c.id === e.target.value);
                        if (cal) selectM.mutate({ calendarId: cal.id, calendarName: cal.summary });
                      }}
                      className="w-full rounded-md border border-slate-200 bg-white px-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
                      disabled={selectM.isPending}
                    >
                      <option value="" disabled>Selecione um calendário...</option>
                      {(calendarsQ.data?.calendars ?? []).map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.summary} {c.primary ? "(principal)" : ""}
                        </option>
                      ))}
                    </select>
                    {data.calendarName && (
                      <p className="text-[11px] text-muted-foreground">
                        Atualmente em uso: <span className="font-medium">{data.calendarName}</span>
                      </p>
                    )}
                    {selectM.isPending && (
                      <p className="flex items-center gap-1 text-[11px] text-muted-foreground">
                        <Loader2 className="h-3 w-3 animate-spin" /> Salvando…
                      </p>
                    )}
                  </>
                )}
                <p className="text-[11px] text-muted-foreground">
                  O agente buscará janelas livres e criará eventos neste calendário.
                </p>
              </div>

              <Button variant="outline" className="w-full" onClick={() => disconnectM.mutate()} disabled={disconnectM.isPending}>
                {disconnectM.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Desconectar Google Calendar
              </Button>
            </>
          ) : (
            <>
              <p className="text-xs text-muted-foreground">Conecte sua conta Google para que o agente possa verificar disponibilidade e criar agendamentos. Após o login, escolha qual calendário será usado.</p>
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
  const [codeLink, setCodeLink] = useState("");
  const [selectedProfIds, setSelectedProfIds] = useState<number[]>([]);
  const [ativo, setAtivo] = useState(false);
  const [testResult, setTestResult] = useState<string | null>(null);
  const [professionals, setProfessionals] = useState<{ id: number; name: string }[]>([]);
  const [loadingProfs, setLoadingProfs] = useState(false);

  useEffect(() => {
    if (data) {
      setSubscriberId(data.subscriber_id ?? "");
      setBusinessId(data.business_id ? String(data.business_id) : "");
      setCodeLink(data.code_link ?? "");
      setSelectedProfIds(data.profissional_ids ?? []);
      setAtivo(data.ativo ?? false);
    }
  }, [data]);

  // Carrega profissionais automaticamente quando o token já está salvo
  useEffect(() => {
    if (!data?.token_configured) return;
    setLoadingProfs(true);
    listProfs({ data: { accountId } })
      .then((r) => { if (r.ok) setProfessionals(r.professionals); })
      .finally(() => setLoadingProfs(false));
  }, [data?.token_configured, accountId]);

  function toggleProf(id: number) {
    setSelectedProfIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );
  }

  const save = useMutation({
    mutationFn: () =>
      saveCfg({
        data: {
          accountId,
          ...(token ? { api_token: token } : {}),
          subscriber_id: subscriberId || undefined,
          business_id: businessId ? Number(businessId) : undefined,
          code_link: codeLink || undefined,
          profissional_ids: selectedProfIds,
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

          {/* Token */}
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

          {/* Subscriber ID + Business ID */}
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

          {/* Code Link */}
          <div>
            <Label className="text-xs font-semibold">
              Code Link{" "}
              <span className="font-normal text-muted-foreground">(agenda online)</span>
            </Label>
            <Input
              value={codeLink}
              onChange={(e) => setCodeLink(e.target.value)}
              placeholder="ex: 73828"
              className="mt-1"
            />
            <p className="text-[10px] text-muted-foreground mt-1">
              Código da agenda que libera horários para agendamento por API.
            </p>
          </div>

          {/* Profissionais — múltipla seleção */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <Label className="text-xs font-semibold">
                Profissionais{" "}
                <span className="font-normal text-muted-foreground">(opcional — marque os desejados)</span>
              </Label>
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

            {!data?.token_configured ? (
              <p className="text-[10px] text-muted-foreground">
                Salve o token primeiro para carregar os profissionais.
              </p>
            ) : loadingProfs ? (
              <p className="text-[10px] text-muted-foreground">Carregando profissionais...</p>
            ) : professionals.length === 0 ? (
              <p className="text-[10px] text-muted-foreground">
                Nenhum profissional encontrado. Clique em ↻ Recarregar.
              </p>
            ) : (
              <div className="rounded-lg border border-slate-200 divide-y divide-slate-100 max-h-48 overflow-y-auto">
                {professionals.map((p) => {
                  const checked = selectedProfIds.includes(p.id);
                  return (
                    <label
                      key={p.id}
                      className="flex items-center gap-3 px-3 py-2.5 cursor-pointer hover:bg-slate-50 transition-colors"
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggleProf(p.id)}
                        className="h-4 w-4 rounded border-slate-300 accent-slate-800"
                      />
                      <span className="text-sm">{p.name}</span>
                    </label>
                  );
                })}
              </div>
            )}

            {selectedProfIds.length > 0 && professionals.length > 0 && (
              <p className="text-[10px] text-muted-foreground mt-1">
                {selectedProfIds.length} profissional{selectedProfIds.length > 1 ? "is" : ""} selecionado{selectedProfIds.length > 1 ? "s" : ""}.
                Deixe todos desmarcados para usar qualquer profissional disponível.
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
  const test = useServerFn(testOpenRouterKey);
  const usage = useServerFn(getUsageSummary);

  const [orKey, setOrKey] = useState("");
  const [elKey, setElKey] = useState("");
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
          {/* Groq é gerenciado centralmente pelo servidor (GROQ_API_KEY).
              Não exposto na UI a partir de 2026-05. */}
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

interface FollowupStep {
  id: string;
  ordem: number;
  enabled: boolean;
  delay_value: number;
  delay_unit: "minutes" | "hours" | "days";
  mode: "message" | "contextual";
  message_text: string | null;
  contextual_instruction: string | null;
  window_start_hour: number | null;
  window_end_hour: number | null;
  allowed_days: string[] | null;
}

function FollowupView({ agentId, onClose }: { agentId: string; onClose: () => void }) {
  const qc = useQueryClient();
  const listFn = useServerFn(listFollowupSteps);
  const createFn = useServerFn(createFollowupStep);
  const updateFn = useServerFn(updateFollowupStep);
  const deleteFn = useServerFn(deleteFollowupStep);

  const q = useQuery({
    queryKey: ["followup-steps", agentId],
    queryFn: () => listFn({ data: { agentId } }),
  });

  const steps = (q.data?.steps ?? []) as FollowupStep[];

  async function addStep() {
    const nextOrdem = steps.length > 0 ? Math.max(...steps.map((s) => s.ordem)) + 1 : 1;
    try {
      await createFn({
        data: {
          agentId,
          ordem: nextOrdem,
          enabled: true,
          delay_value: nextOrdem === 1 ? 60 : 1,
          delay_unit: nextOrdem === 1 ? "minutes" : "days",
          mode: "message",
          message_text: "",
          contextual_instruction: null,
          window_start_hour: 8,
          window_end_hour: 20,
          allowed_days: ["seg", "ter", "qua", "qui", "sex"],
        },
      });
      qc.invalidateQueries({ queryKey: ["followup-steps", agentId] });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Erro ao adicionar passo");
    }
  }

  async function updateStep(step: FollowupStep, patch: Partial<FollowupStep>) {
    try {
      await updateFn({ data: { id: step.id, ...patch } });
      qc.invalidateQueries({ queryKey: ["followup-steps", agentId] });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Erro ao atualizar");
    }
  }

  async function removeStep(id: string) {
    if (!confirm("Remover esse passo da sequência?")) return;
    try {
      await deleteFn({ data: { id } });
      qc.invalidateQueries({ queryKey: ["followup-steps", agentId] });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Erro ao remover");
    }
  }

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
          <span className="text-sm font-semibold text-foreground">Follow-up automático — Sequência</span>
        </div>
      </div>

      {q.isLoading ? (
        <div className="flex flex-1 items-center justify-center">
          <Loader2 className="h-6 w-6 animate-spin text-primary" />
        </div>
      ) : (
        <div className="mx-auto w-full max-w-3xl px-6 py-8 space-y-4">
          {/* Info banner */}
          <div className="rounded-xl border border-orange-200 bg-orange-50 p-4">
            <p className="text-sm font-semibold text-orange-800">Reengajamento em sequência</p>
            <p className="mt-1 text-xs text-orange-700">
              Cada passo dispara após o tempo configurado de inatividade.
              O 1º conta a partir da última mensagem do lead; os seguintes contam a partir do envio do passo anterior.
            </p>
          </div>

          {/* Steps list */}
          {steps.length === 0 && (
            <div className="rounded-xl border border-dashed border-slate-200 bg-white p-8 text-center">
              <Bell className="mx-auto mb-2 h-8 w-8 text-slate-300" />
              <p className="text-sm font-medium text-foreground">Nenhum passo configurado</p>
              <p className="mt-1 text-xs text-muted-foreground">
                Adicione o primeiro passo abaixo para começar.
              </p>
            </div>
          )}

          {steps.map((step) => (
            <FollowupStepCard
              key={step.id}
              step={step}
              onUpdate={(patch) => void updateStep(step, patch)}
              onRemove={() => void removeStep(step.id)}
            />
          ))}

          <button
            onClick={() => void addStep()}
            className="flex w-full items-center justify-center gap-2 rounded-xl border-2 border-dashed border-slate-300 bg-white py-4 text-sm font-medium text-slate-600 transition-colors hover:border-primary hover:bg-primary/5 hover:text-primary"
          >
            <Plus className="h-4 w-4" />
            Adicionar passo de follow-up
          </button>
        </div>
      )}
    </div>
  );
}

const DAY_OPTIONS = [
  { key: "seg", label: "Seg" },
  { key: "ter", label: "Ter" },
  { key: "qua", label: "Qua" },
  { key: "qui", label: "Qui" },
  { key: "sex", label: "Sex" },
  { key: "sab", label: "Sáb" },
  { key: "dom", label: "Dom" },
];

function FollowupStepCard({
  step,
  onUpdate,
  onRemove,
}: {
  step: FollowupStep;
  onUpdate: (patch: Partial<FollowupStep>) => void;
  onRemove: () => void;
}) {
  // Estado local com debounce simples para evitar request a cada tecla
  const [delay, setDelay] = useState(step.delay_value);
  const [unit, setUnit] = useState(step.delay_unit);
  const [mode, setMode] = useState(step.mode);
  const [msgText, setMsgText] = useState(step.message_text ?? "");
  const [ctxInstr, setCtxInstr] = useState(step.contextual_instruction ?? "");
  const [winStart, setWinStart] = useState(step.window_start_hour ?? 8);
  const [winEnd, setWinEnd] = useState(step.window_end_hour ?? 20);
  const [days, setDays] = useState<string[]>(step.allowed_days ?? []);

  // Salva quando o input perde foco (onBlur) — evita request por tecla
  function commit(patch: Partial<FollowupStep>) {
    onUpdate(patch);
  }

  function toggleDay(key: string) {
    const next = days.includes(key) ? days.filter((d) => d !== key) : [...days, key];
    setDays(next);
    commit({ allowed_days: next });
  }

  return (
    <div className={`rounded-2xl border bg-white p-5 shadow-sm ${step.enabled ? "border-slate-200" : "border-slate-200 opacity-70"}`}>
      <div className="mb-4 flex items-start gap-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-sm font-bold text-primary">
          {step.ordem}
        </span>
        <div className="flex-1">
          <p className="text-sm font-semibold text-foreground">Passo {step.ordem}</p>
          <p className="text-[11px] text-muted-foreground">
            {step.ordem === 1
              ? "Dispara após inatividade do lead"
              : `Dispara depois do envio do passo ${step.ordem - 1}`}
          </p>
        </div>
        <Switch
          checked={step.enabled}
          onCheckedChange={(v) => commit({ enabled: v })}
        />
        <button
          onClick={onRemove}
          className="text-[10px] font-semibold text-rose-500 hover:text-rose-700"
        >
          Remover
        </button>
      </div>

      {/* Tempo */}
      <div className="mb-4 flex items-center gap-2">
        <Label className="text-xs font-semibold text-slate-700">Após</Label>
        <input
          type="number"
          min={1}
          value={delay}
          onChange={(e) => setDelay(Number(e.target.value))}
          onBlur={() => commit({ delay_value: delay })}
          className="w-20 rounded-md border border-slate-200 bg-white px-2 py-1 text-sm outline-none focus:border-primary"
        />
        <select
          value={unit}
          onChange={(e) => {
            const v = e.target.value as FollowupStep["delay_unit"];
            setUnit(v);
            commit({ delay_unit: v });
          }}
          className="rounded-md border border-slate-200 bg-white px-2 py-1 text-sm outline-none focus:border-primary"
        >
          <option value="minutes">minutos</option>
          <option value="hours">horas</option>
          <option value="days">dias</option>
        </select>
      </div>

      {/* Modo */}
      <div className="mb-4">
        <Label className="text-xs font-semibold text-slate-700 mb-1.5 block">Como gerar a mensagem?</Label>
        <div className="flex gap-2">
          <button
            onClick={() => {
              setMode("message");
              commit({ mode: "message" });
            }}
            className={`flex-1 rounded-lg border-2 px-3 py-2 text-left transition-colors ${
              mode === "message"
                ? "border-primary bg-primary/5"
                : "border-slate-200 bg-white hover:border-slate-300"
            }`}
          >
            <p className="text-xs font-semibold text-foreground">📝 Mensagem fixa</p>
            <p className="mt-0.5 text-[10px] text-muted-foreground">Texto exato que será enviado</p>
          </button>
          <button
            onClick={() => {
              setMode("contextual");
              commit({ mode: "contextual" });
            }}
            className={`flex-1 rounded-lg border-2 px-3 py-2 text-left transition-colors ${
              mode === "contextual"
                ? "border-primary bg-primary/5"
                : "border-slate-200 bg-white hover:border-slate-300"
            }`}
          >
            <p className="text-xs font-semibold text-foreground">🤖 Contextual (IA)</p>
            <p className="mt-0.5 text-[10px] text-muted-foreground">Agente gera baseado na conversa</p>
          </button>
        </div>
      </div>

      {/* Conteúdo (mensagem fixa OU instrução contextual) */}
      {mode === "message" ? (
        <div className="mb-4">
          <Label className="text-xs font-semibold text-slate-700 mb-1.5 block">
            Texto da mensagem
          </Label>
          <textarea
            value={msgText}
            onChange={(e) => setMsgText(e.target.value)}
            onBlur={() => commit({ message_text: msgText })}
            rows={3}
            placeholder="Oi! Tudo bem? Vi que ficamos sem falar — ainda quer ajuda com o assunto?"
            className="w-full resize-none rounded-md border border-slate-200 px-3 py-2 text-sm outline-none focus:border-primary"
          />
        </div>
      ) : (
        <div className="mb-4">
          <Label className="text-xs font-semibold text-slate-700 mb-1.5 block">
            Instrução para o agente
          </Label>
          <textarea
            value={ctxInstr}
            onChange={(e) => setCtxInstr(e.target.value)}
            onBlur={() => commit({ contextual_instruction: ctxInstr })}
            rows={3}
            placeholder="Reengaje o lead trazendo de volta o tema que ele tinha comentado. Seja leve, ofereça ajuda sem cobrar resposta."
            className="w-full resize-none rounded-md border border-slate-200 px-3 py-2 text-sm outline-none focus:border-primary"
          />
          <p className="mt-1 text-[10px] text-muted-foreground">
            O agente vai usar essa instrução + histórico da conversa para gerar uma mensagem única.
          </p>
        </div>
      )}

      {/* Janela horária + dias */}
      <div className="grid grid-cols-2 gap-4 mb-3">
        <div>
          <Label className="text-xs font-semibold text-slate-700 mb-1.5 block">Janela horária</Label>
          <div className="flex items-center gap-2">
            <input
              type="number"
              min={0}
              max={23}
              value={winStart}
              onChange={(e) => setWinStart(Number(e.target.value))}
              onBlur={() => commit({ window_start_hour: winStart })}
              className="w-16 rounded-md border border-slate-200 bg-white px-2 py-1 text-sm outline-none focus:border-primary"
            />
            <span className="text-xs text-muted-foreground">às</span>
            <input
              type="number"
              min={0}
              max={23}
              value={winEnd}
              onChange={(e) => setWinEnd(Number(e.target.value))}
              onBlur={() => commit({ window_end_hour: winEnd })}
              className="w-16 rounded-md border border-slate-200 bg-white px-2 py-1 text-sm outline-none focus:border-primary"
            />
            <span className="text-xs text-muted-foreground">h</span>
          </div>
        </div>
        <div>
          <Label className="text-xs font-semibold text-slate-700 mb-1.5 block">Dias permitidos</Label>
          <div className="flex flex-wrap gap-1">
            {DAY_OPTIONS.map((d) => {
              const active = days.includes(d.key);
              return (
                <button
                  key={d.key}
                  onClick={() => toggleDay(d.key)}
                  className={`rounded-full px-2 py-0.5 text-[10px] font-semibold transition-colors ${
                    active
                      ? "bg-primary text-white"
                      : "bg-slate-100 text-slate-500 hover:bg-slate-200"
                  }`}
                >
                  {d.label}
                </button>
              );
            })}
          </div>
        </div>
      </div>
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
