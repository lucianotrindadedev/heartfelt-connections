import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  Bot,
  Power,
  RotateCw,
  Play,
  Brain,
  Settings as SettingsIcon,
  Cog,
  MessageSquare,
  Mic,
  GitBranch,
  Monitor,
  Wifi,
  ArrowRight,
  type LucideIcon,
} from "lucide-react";
import { api } from "@/lib/api";
import type { Agent, DashboardStats } from "@/lib/types";

interface OverviewProps {
  accountId: string;
}

export function OverviewTab({ accountId }: OverviewProps) {
  const stats = useQuery({
    queryKey: ["stats", accountId],
    queryFn: () => api<DashboardStats>(`/api/accounts/${accountId}/stats`),
  });
  const agents = useQuery({
    queryKey: ["agents", accountId],
    queryFn: () => api<Agent[]>(`/api/accounts/${accountId}/agents`),
  });

  const mainAgent = agents.data?.find((a) => a.kind === "main");
  const agentName = mainAgent?.name ?? "Assistente";
  const agentActive = mainAgent?.enabled ?? false;
  const queueSize = stats.data?.queue_size ?? 0;
  const activeQueues =
    typeof stats.data?.queue_size === "number" ? stats.data.queue_size : null;

  return (
    <div className="space-y-8">
      {/* Header status */}
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-2">
          <h1 className="text-lg font-semibold tracking-tight">
            Assistente Virtual
          </h1>
          <StatusPill online={agentActive} label={agentActive ? "Online" : "Offline"} />
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
            Assistente:
          </span>
          <StatusPill
            online={agentActive}
            label={agentActive ? "ATIVO" : "INATIVO"}
            uppercase
          />
        </div>
      </div>

      {/* Welcome card */}
      <section className="rounded-xl border border-border bg-card p-5">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex items-start gap-4">
            <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-muted">
              <Bot className="h-6 w-6 text-muted-foreground" />
            </div>
            <div className="space-y-3">
              <div>
                <p className="text-base">
                  Olá! Meu nome é{" "}
                  <span className="font-semibold">{agentName}</span>, assistente
                  virtual da sua empresa!
                </p>
                <p className="mt-1 text-sm text-muted-foreground">
                  {agentActive
                    ? "Estou fazendo atendimentos agora mesmo. Se quiser que eu pare, basta me desativar."
                    : "Estou pausado. Ative para começar a atender."}
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <button className="inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-3 py-1.5 text-xs font-medium hover:bg-accent">
                  <RotateCw className="h-3.5 w-3.5" />
                  Resetar assistente
                </button>
                <button
                  className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-border bg-background hover:bg-accent"
                  aria-label="Iniciar"
                >
                  <Play className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
          </div>
          <button
            className={
              agentActive
                ? "inline-flex shrink-0 items-center gap-1.5 rounded-md border border-destructive/40 bg-background px-3 py-1.5 text-xs font-medium text-destructive hover:bg-destructive/5"
                : "inline-flex shrink-0 items-center gap-1.5 rounded-md border border-border bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:opacity-90"
            }
          >
            <Power className="h-3.5 w-3.5" />
            {agentActive ? "Desativar assistente" : "Ativar assistente"}
          </button>
        </div>
      </section>

      {/* Main actions */}
      <section className="space-y-3">
        <SectionLabel>Ações principais</SectionLabel>
        <div className="grid gap-4 md:grid-cols-2">
          <PrimaryActionCard
            accountId={accountId}
            to="/embed/account/$accountId/main-agent"
            accent="warning"
            eyebrow="Base de conhecimento"
            title="Treinamentos avançados"
            description="Configure informações, produtos, regras e ações do seu assistente."
            icon={Brain}
            cornerIcon={SettingsIcon}
            buttonLabel="Configurar treinamentos"
            buttonIcon={Cog}
          />
          <PrimaryActionCard
            accountId={accountId}
            to="/embed/account/$accountId/main-agent"
            accent="warning"
            eyebrow="Personalize seu assistente"
            title="Configurações"
            description="Ajuste comportamento, tom de voz e preferências gerais."
            icon={SettingsIcon}
            buttonLabel="Configurar"
            buttonIcon={ArrowRight}
            buttonIconAfter
          />
        </div>
      </section>

      {/* Channels */}
      <section className="space-y-3">
        <SectionLabel>Canais de atendimento</SectionLabel>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <ChannelCard
            accountId={accountId}
            to="/embed/account/$accountId/integrations"
            accent="success"
            icon={MessageSquare}
            title="WhatsApp"
            description="Conecte o WhatsApp da sua empresa."
            badge={{
              label: "Conectado",
              tone: "success",
              icon: Wifi,
            }}
            cta={{ label: "Conectar", variant: "primary", icon: MessageSquare }}
          />
          <ChannelCard
            accountId={accountId}
            to="/embed/account/$accountId/main-agent"
            accent="info"
            icon={Mic}
            title="Áudio"
            description="Configure respostas em áudio."
            badge={{ label: "0min restantes", tone: "neutral" }}
            cta={{ label: "Configurar", variant: "outline", icon: ArrowRight, iconAfter: true }}
          />
          <ChannelCard
            accountId={accountId}
            to="/embed/account/$accountId/automations"
            accent="warning"
            icon={GitBranch}
            title="Filas de atendimento"
            description="Crie filas de atendimento para transferência de conversas."
            badge={{
              label: activeQueues !== null ? `${activeQueues} ativas` : "—",
              tone: "success",
              dot: true,
            }}
            cta={{ label: "Configurar", variant: "outline", icon: ArrowRight, iconAfter: true }}
          />
          <ChannelCard
            accountId={accountId}
            to="/embed/account/$accountId/integrations"
            accent="muted"
            icon={Monitor}
            title="Web Chat"
            description="Crie um widget de chat para seu site."
            badge={{ label: "BETA", tone: "neutral" }}
            cta={{ label: "Configurar", variant: "outline", icon: ArrowRight, iconAfter: true }}
          />
        </div>
      </section>

      {/* Footer stats (kept from previous overview, condensed) */}
      <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <MiniStat
          label="Agentes ativos"
          value={stats.data?.agents_active ?? "—"}
          loading={stats.isLoading}
        />
        <MiniStat
          label="Mensagens 24h"
          value={stats.data?.messages_24h ?? "—"}
          loading={stats.isLoading}
        />
        <MiniStat
          label="Custo estimado 24h"
          value={
            stats.data
              ? `US$ ${stats.data.estimated_cost_24h_usd.toFixed(3)}`
              : "—"
          }
          loading={stats.isLoading}
        />
        <MiniStat
          label="Fila atual"
          value={queueSize}
          loading={stats.isLoading}
        />
      </section>

      {agents.isError && (
        <p className="text-xs text-destructive">
          Erro ao carregar agentes. Verifique se o backend está acessível em
          VITE_API_BASE_URL.
        </p>
      )}
    </div>
  );
}

/* ---------- subcomponents ---------- */

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
      {children}
    </p>
  );
}

function StatusPill({
  online,
  label,
  uppercase,
}: {
  online: boolean;
  label: string;
  uppercase?: boolean;
}) {
  return (
    <span
      className={
        "inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium " +
        (online
          ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
          : "border-border bg-muted text-muted-foreground") +
        (uppercase ? " tracking-wider" : "")
      }
    >
      <span
        className={
          "h-1.5 w-1.5 rounded-full " +
          (online ? "bg-emerald-500" : "bg-muted-foreground/50")
        }
      />
      {label}
    </span>
  );
}

const ACCENT_BAR: Record<string, string> = {
  warning: "bg-amber-400",
  success: "bg-emerald-500",
  info: "bg-sky-500",
  muted: "bg-muted-foreground/40",
};

function PrimaryActionCard({
  accountId,
  to,
  accent,
  eyebrow,
  title,
  description,
  icon: Icon,
  cornerIcon: CornerIcon,
  buttonLabel,
  buttonIcon: BtnIcon,
  buttonIconAfter,
}: {
  accountId: string;
  to: string;
  accent: keyof typeof ACCENT_BAR;
  eyebrow: string;
  title: string;
  description: string;
  icon: LucideIcon;
  cornerIcon?: LucideIcon;
  buttonLabel: string;
  buttonIcon?: LucideIcon;
  buttonIconAfter?: boolean;
}) {
  return (
    <div className="overflow-hidden rounded-xl border border-border bg-card">
      <div className={`h-1 w-full ${ACCENT_BAR[accent]}`} />
      <div className="flex flex-col gap-5 p-5">
        <div className="flex items-start justify-between">
          <Icon className="h-6 w-6 text-muted-foreground" strokeWidth={1.5} />
          {CornerIcon && (
            <CornerIcon className="h-4 w-4 text-muted-foreground" />
          )}
        </div>
        <div className="space-y-1.5">
          <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
            {eyebrow}
          </p>
          <h3 className="text-lg font-semibold leading-tight">{title}</h3>
          <p className="text-sm text-muted-foreground">{description}</p>
        </div>
        <Link
          // @ts-expect-error dynamic route param
          to={to}
          params={{ accountId }}
          search={{}}
          className="inline-flex items-center justify-center gap-2 rounded-md bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground hover:opacity-90"
        >
          {BtnIcon && !buttonIconAfter && <BtnIcon className="h-4 w-4" />}
          {buttonLabel}
          {BtnIcon && buttonIconAfter && <BtnIcon className="h-4 w-4" />}
        </Link>
      </div>
    </div>
  );
}

type Tone = "success" | "neutral";
function ChannelCard({
  accountId,
  to,
  accent,
  icon: Icon,
  title,
  description,
  badge,
  cta,
}: {
  accountId: string;
  to: string;
  accent: keyof typeof ACCENT_BAR;
  icon: LucideIcon;
  title: string;
  description: string;
  badge: { label: string; tone: Tone; dot?: boolean; icon?: LucideIcon };
  cta: {
    label: string;
    variant: "primary" | "outline";
    icon?: LucideIcon;
    iconAfter?: boolean;
  };
}) {
  const BadgeIcon = badge.icon;
  const CtaIcon = cta.icon;
  return (
    <div className="overflow-hidden rounded-xl border border-border bg-card">
      <div className={`h-1 w-full ${ACCENT_BAR[accent]}`} />
      <div className="flex h-full flex-col gap-4 p-4">
        <div className="flex items-start justify-between gap-2">
          <Icon className="h-5 w-5 text-muted-foreground" strokeWidth={1.5} />
          <span
            className={
              "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium " +
              (badge.tone === "success"
                ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                : "bg-muted text-muted-foreground")
            }
          >
            {badge.dot && (
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
            )}
            {BadgeIcon && <BadgeIcon className="h-3 w-3" />}
            {badge.label}
          </span>
        </div>
        <div className="flex-1 space-y-1">
          <h3 className="text-sm font-semibold">{title}</h3>
          <p className="text-xs text-muted-foreground">{description}</p>
        </div>
        <Link
          // @ts-expect-error dynamic route param
          to={to}
          params={{ accountId }}
          search={{}}
          className={
            "inline-flex items-center justify-center gap-1.5 rounded-md px-3 py-2 text-xs font-medium " +
            (cta.variant === "primary"
              ? "bg-emerald-500 text-white hover:bg-emerald-600"
              : "border border-border bg-background hover:bg-accent")
          }
        >
          {CtaIcon && !cta.iconAfter && <CtaIcon className="h-3.5 w-3.5" />}
          {cta.label}
          {CtaIcon && cta.iconAfter && <CtaIcon className="h-3.5 w-3.5" />}
        </Link>
      </div>
    </div>
  );
}

function MiniStat({
  label,
  value,
  loading,
}: {
  label: string;
  value: string | number;
  loading?: boolean;
}) {
  return (
    <div className="rounded-lg border border-border bg-card px-4 py-3">
      <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        {label}
      </p>
      <p className="mt-1 text-xl font-semibold tabular-nums">
        {loading ? "…" : value}
      </p>
    </div>
  );
}
