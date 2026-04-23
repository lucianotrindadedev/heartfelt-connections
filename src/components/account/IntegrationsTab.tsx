import { useState } from "react";
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
  google_calendar: {
    label: "Google Agenda",
    fields: [
      { name: "calendar_id", label: "Calendar ID" },
      { name: "service_account_json", label: "Service Account JSON", secret: true },
    ],
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
  });
  const agents = useQuery({
    queryKey: ["agents", accountId],
    queryFn: () => api<Agent[]>(`/api/accounts/${accountId}/agents`),
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

function WebhookRow({ agent }: { agent: Agent }) {
  const wh = useQuery({
    queryKey: ["webhook", agent.id],
    queryFn: () => api<AgentWebhook>(`/api/agents/${agent.id}/webhook`),
  });
  const url =
    wh.data?.inbound_url ??
    `${API_BASE_URL}/webhook/inbound/${wh.data?.inbound_token ?? "…"}`;
  return (
    <div className="flex items-center gap-2 rounded border border-border bg-background p-2 text-xs">
      <span className="w-32 truncate font-medium">{agent.name}</span>
      <code className="flex-1 truncate text-muted-foreground">{url}</code>
      <button
        type="button"
        onClick={() => navigator.clipboard.writeText(url)}
        className="rounded p-1 hover:bg-accent"
        title="Copiar"
      >
        <Copy className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
