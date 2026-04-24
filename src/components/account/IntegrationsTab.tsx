import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, API_BASE_URL } from "@/lib/api";
import type { Agent, AgentWebhook, Integration, IntegrationType } from "@/lib/types";
import { Copy, RefreshCw } from "lucide-react";

const INTEGRATION_FIELDS: Record<
  IntegrationType,
  { label: string; fields: Array<{ name: string; label: string; secret?: boolean }> }
> = {
  helena_crm: {
    label: "CRM Helena",
    fields: [
      { name: "base_api", label: "Base API URL" },
      { name: "token", label: "API Token", secret: true },
    ],
  },
  clinicorp: {
    label: "Clinicorp",
    fields: [
      { name: "subscriber_id", label: "Subscriber ID" },
      { name: "business_id", label: "Business ID" },
      { name: "api_token", label: "API Token", secret: true },
    ],
  },
  clinicexpress: {
    label: "Clinic Express",
    fields: [
      { name: "token", label: "Token API", secret: true },
    ],
  },
  google_calendar: {
    label: "Google Agenda",
    fields: [], // No manual fields - uses OAuth
  },
  google_drive: {
    label: "Google Drive",
    fields: [{ name: "service_account_json", label: "Service Account JSON", secret: true }],
  },
  clinup: {
    label: "Clinup",
    fields: [{ name: "api_token", label: "API Token", secret: true }],
  },
  elevenlabs: {
    label: "ElevenLabs",
    fields: [
      { name: "api_key", label: "API Key", secret: true },
      { name: "voice_id", label: "Voice ID" },
    ],
  },
  openrouter: {
    label: "OpenRouter",
    fields: [{ name: "api_key", label: "API Key", secret: true }],
  },
  evolution_api: {
    label: "Evolution API",
    fields: [
      { name: "base_url", label: "Base URL" },
      { name: "api_key", label: "API Key", secret: true },
      { name: "alert_group_jid", label: "JID do grupo de alerta" },
    ],
  },
  central360: {
    label: "Central360",
    fields: [
      { name: "base_url", label: "Base URL" },
      { name: "api_key", label: "API Key", secret: true },
    ],
  },
  groq: {
    label: "Groq (Whisper STT)",
    fields: [{ name: "api_key", label: "API Key", secret: true }],
  },
};

export function IntegrationsTab({ accountId }: { accountId: string }) {
  const queryClient = useQueryClient();
  const integrations = useQuery({
    queryKey: ["integrations", accountId],
    queryFn: () => api<Integration[]>(`/api/accounts/${accountId}/integrations`),
    staleTime: 60_000,
  });
  const agents = useQuery({
    queryKey: ["agents", accountId],
    queryFn: () => api<Agent[]>(`/api/accounts/${accountId}/agents`),
    staleTime: 60_000,
  });

  const types = Object.keys(INTEGRATION_FIELDS) as IntegrationType[];
  const [active, setActive] = useState<IntegrationType>("helena_crm");
  const [values, setValues] = useState<Record<string, string>>({});

  const current = integrations.data?.find((i) => i.type === active);

  const save = useMutation({
    mutationFn: async () =>
      api(`/api/accounts/${accountId}/integrations`, {
        method: "PUT",
        json: { type: active, config: values },
      }),
    onSuccess: () => {
      setValues({});
      queryClient.invalidateQueries({ queryKey: ["integrations", accountId] });
    },
  });

  const test = useMutation({
    mutationFn: async () =>
      api<{ ok: boolean; details?: string }>(`/api/test/${active}`, {
        method: "POST",
        json: { account_id: accountId },
      }),
  });

  return (
    <div className="grid gap-6 md:grid-cols-[200px_1fr]">
      <aside className="space-y-1">
        {types.map((t) => {
          const has = integrations.data?.some((i) => i.type === t);
          return (
            <button
              key={t}
              onClick={() => {
                setActive(t);
                setValues({});
                test.reset();
              }}
              className={
                t === active
                  ? "block w-full rounded-md bg-secondary px-3 py-2 text-left text-sm"
                  : "block w-full rounded-md px-3 py-2 text-left text-sm text-muted-foreground hover:bg-accent"
              }
            >
              {INTEGRATION_FIELDS[t].label}
              {has && <span className="ml-1 text-[10px] text-emerald-500">●</span>}
            </button>
          );
        })}
      </aside>

      <section className="space-y-5">
        <div>
          <h2 className="text-base font-semibold">
            {INTEGRATION_FIELDS[active].label}
          </h2>
          {current && (
            <p className="mt-1 text-xs text-muted-foreground">
              Atualizado em {new Date(current.updated_at).toLocaleString()}
            </p>
          )}
        </div>

        {INTEGRATION_FIELDS[active].fields.map((field) => (
          <label key={field.name} className="block">
            <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-muted-foreground">
              {field.label}{" "}
              {field.secret && (
                <span className="text-[10px] text-muted-foreground">(secreto)</span>
              )}
            </span>
            <input
              type={field.secret ? "password" : "text"}
              value={values[field.name] ?? ""}
              placeholder={
                current?.config_preview?.[field.name] ??
                (field.secret ? "(deixe em branco para manter)" : "")
              }
              onChange={(e) =>
                setValues({ ...values, [field.name]: e.target.value })
              }
              className="input"
            />
          </label>
        ))}

        {active === "google_calendar" && (
          <GoogleCalendarOAuth accountId={accountId} />
        )}

        {active !== "google_calendar" && (
          <div className="flex items-center gap-3">
            <button
              onClick={() => save.mutate()}
              disabled={save.isPending}
              className="rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground disabled:opacity-50"
            >
              {save.isPending ? "Salvando…" : "Salvar"}
            </button>
            <button
              onClick={() => test.mutate()}
              disabled={test.isPending}
              className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-2 text-sm hover:bg-accent disabled:opacity-50"
            >
              <RefreshCw className="h-3.5 w-3.5" /> Testar conexão
            </button>
            {test.data && (
              <span
                className={
                  test.data.ok
                    ? "text-xs text-emerald-500"
                    : "text-xs text-destructive"
                }
              >
                {test.data.ok ? "OK" : test.data.details ?? "Falha"}
              </span>
            )}
          </div>
        )}

        {active === "helena_crm" && agents.data && (
          <div className="mt-8 rounded-lg border border-border bg-card p-4">
            <h3 className="text-sm font-semibold">Webhooks dos agentes</h3>
            <p className="mt-1 text-xs text-muted-foreground">
              Cole estas URLs no CRM Helena para receber as mensagens.
            </p>
            <div className="mt-3 space-y-2">
              {agents.data.map((agent) => (
                <WebhookRow key={agent.id} agent={agent} />
              ))}
            </div>
          </div>
        )}
      </section>
    </div>
  );
}

function GoogleCalendarOAuth({ accountId }: { accountId: string }) {
  const queryClient = useQueryClient();
  const [connecting, setConnecting] = useState(false);
  const [connected, setConnected] = useState(false);

  const integrations = useQuery({
    queryKey: ["integrations", accountId],
    queryFn: () => api<Integration[]>(`/api/accounts/${accountId}/integrations`),
  });

  const calendars = useQuery({
    queryKey: ["google-calendars", accountId],
    queryFn: () =>
      api<{
        calendars: Array<{ id: string; summary: string; primary?: boolean }>;
        selectedCalendarId: string;
      }>(`/api/oauth/google/calendars?accountId=${accountId}`),
    enabled: !!integrations.data?.some((i) => i.type === "google_calendar"),
  });

  const selectCalendar = useMutation({
    mutationFn: (calendarId: string) =>
      api("/api/oauth/google/select-calendar", {
        method: "POST",
        json: { accountId, calendarId },
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["google-calendars", accountId] });
      queryClient.invalidateQueries({ queryKey: ["integrations", accountId] });
    },
  });

  const isConnected = integrations.data?.some((i) => i.type === "google_calendar");

  // Listen for OAuth popup messages
  useEffect(() => {
    function handleMessage(event: MessageEvent) {
      if (event.data?.type === "google-oauth-success") {
        setConnecting(false);
        setConnected(true);
        queryClient.invalidateQueries({ queryKey: ["integrations", accountId] });
        queryClient.invalidateQueries({ queryKey: ["google-calendars", accountId] });
      } else if (event.data?.type === "google-oauth-error") {
        setConnecting(false);
      }
    }
    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [accountId, queryClient]);

  const startOAuth = async () => {
    setConnecting(true);
    try {
      const { url } = await api<{ url: string }>(
        `/api/oauth/google/url?accountId=${accountId}`,
      );
      const popup = window.open(
        url,
        "google-oauth",
        "width=500,height=700,left=200,top=100",
      );
      if (!popup) {
        setConnecting(false);
        alert("Popup bloqueado. Permita popups para este site.");
      }
    } catch (e) {
      setConnecting(false);
      alert("Erro ao iniciar autorizacao: " + (e as Error).message);
    }
  };

  return (
    <div className="space-y-4 rounded-lg border border-border bg-background p-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold">Conta Google</h3>
          <p className="text-xs text-muted-foreground">
            Conecte sua conta Google para acessar o Google Calendar
          </p>
        </div>
        {isConnected ? (
          <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-100 px-2.5 py-1 text-xs font-medium text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
            Conectado
          </span>
        ) : (
          <button
            onClick={startOAuth}
            disabled={connecting}
            className="inline-flex items-center gap-2 rounded-md bg-white border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 shadow-sm hover:bg-gray-50 disabled:opacity-50 dark:bg-gray-800 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-700"
          >
            <svg className="h-4 w-4" viewBox="0 0 24 24">
              <path
                fill="#4285F4"
                d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z"
              />
              <path
                fill="#34A853"
                d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
              />
              <path
                fill="#FBBC05"
                d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
              />
              <path
                fill="#EA4335"
                d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
              />
            </svg>
            {connecting ? "Conectando..." : "Conectar conta Google"}
          </button>
        )}
      </div>

      {isConnected && calendars.data && (
        <div className="space-y-2">
          <label className="block">
            <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Agenda a ser usada pela IA
            </span>
            <select
              value={calendars.data.selectedCalendarId || "primary"}
              onChange={(e) => selectCalendar.mutate(e.target.value)}
              className="input"
            >
              {calendars.data.calendars.map((cal) => (
                <option key={cal.id} value={cal.id}>
                  {cal.summary} {cal.primary ? "(Principal)" : ""}
                </option>
              ))}
            </select>
          </label>
          {selectCalendar.isPending && (
            <p className="text-xs text-muted-foreground">Salvando...</p>
          )}
        </div>
      )}

      {isConnected && (
        <div className="flex items-center gap-2">
          <button
            onClick={startOAuth}
            className="text-xs text-muted-foreground hover:text-foreground hover:underline"
          >
            Reconectar com outra conta
          </button>
        </div>
      )}
    </div>
  );
}

function WebhookRow({ agent }: { agent: Agent }) {
  const wh = useQuery({
    queryKey: ["webhook", agent.id],
    queryFn: () => api<AgentWebhook>(`/api/agents/${agent.id}/webhook`),
    staleTime: 60_000,
  });
  const url = wh.data?.inbound_url ?? `${API_BASE_URL}/webhook/${agent.id}`;
  const secret = wh.data?.webhook_secret ?? "…";
  return (
    <div className="space-y-1 rounded border border-border bg-background p-2 text-xs">
      <div className="flex items-center gap-2">
        <span className="w-32 truncate font-medium">{agent.name}</span>
        <code className="flex-1 truncate text-muted-foreground">{url}</code>
        <button
          type="button"
          onClick={() => navigator.clipboard.writeText(url)}
          className="rounded p-1 hover:bg-accent"
          title="Copiar URL"
        >
          <Copy className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="flex items-center gap-2 pl-32">
        <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
          x-webhook-secret
        </span>
        <code className="flex-1 truncate text-muted-foreground">{secret}</code>
        <button
          type="button"
          onClick={() => navigator.clipboard.writeText(secret)}
          className="rounded p-1 hover:bg-accent"
          title="Copiar secret"
        >
          <Copy className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}
