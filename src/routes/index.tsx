import { createFileRoute, Link } from "@tanstack/react-router";
import { Bot, Layers, Webhook, Workflow } from "lucide-react";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Plataforma de Agentes IA — CRM Helena" },
      {
        name: "description",
        content:
          "Painel para gerenciar agentes de IA conectados ao CRM Helena. Substitui fluxos n8n por uma aplicação dedicada.",
      },
      { property: "og:title", content: "Plataforma de Agentes IA — CRM Helena" },
      {
        property: "og:description",
        content:
          "Crie, configure e monitore agentes Sarai dentro do CRM Helena.",
      },
    ],
  }),
  component: Index,
});

function Index() {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="border-b border-border">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
          <div className="flex items-center gap-2">
            <div className="flex h-8 w-8 items-center justify-center rounded-md bg-primary text-primary-foreground">
              <Bot className="h-5 w-5" />
            </div>
            <span className="font-semibold tracking-tight">Sarai Platform</span>
          </div>
          <nav className="flex items-center gap-3 text-sm">
            <Link
              to="/admin"
              className="rounded-md border border-border px-3 py-1.5 hover:bg-accent"
            >
              Admin
            </Link>
            <Link
              to="/embed"
              className="rounded-md bg-primary px-3 py-1.5 text-primary-foreground hover:bg-primary/90"
            >
              Embed demo
            </Link>
          </nav>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-6 py-16">
        <section className="max-w-3xl">
          <p className="text-xs uppercase tracking-widest text-muted-foreground">
            Plataforma interna · Helena × Clinicorp
          </p>
          <h1 className="mt-3 text-4xl font-bold tracking-tight md:text-5xl">
            Agentes de IA centralizados, sem n8n.
          </h1>
          <p className="mt-4 text-base text-muted-foreground md:text-lg">
            Cada conta do CRM Helena tem seu próprio agente principal,
            follow-up e warm-up — configurados aqui e executados pelo seu
            backend Node + Supabase self-hosted.
          </p>
        </section>

        <section className="mt-12 grid gap-4 md:grid-cols-3">
          <FeatureCard
            icon={<Layers className="h-5 w-5" />}
            title="Templates por integração"
            description="Clinicorp, Google Agenda, Clinup. Prompt, tools e webhooks pré-configurados."
          />
          <FeatureCard
            icon={<Workflow className="h-5 w-5" />}
            title="Follow-up & warm-up"
            description="Crons no Postgres acionam follow-ups e lembretes de agendamento por janela."
          />
          <FeatureCard
            icon={<Webhook className="h-5 w-5" />}
            title="Webhooks Helena"
            description="Cada agente expõe um endpoint único para receber mensagens do CRM."
          />
        </section>

        <section className="mt-16 rounded-lg border border-border bg-card p-6">
          <h2 className="text-lg font-semibold">Como integrar com o Helena</h2>
          <ol className="mt-4 space-y-2 text-sm text-muted-foreground">
            <li>
              1. No CRM Helena, crie um menu personalizado do tipo{" "}
              <em>Página interna</em>.
            </li>
            <li>
              2. Aponte para{" "}
              <code className="rounded bg-muted px-1.5 py-0.5 text-foreground">
                /embed?accountId={"{{id_da_conta}}"}&amp;userId=
                {"{{id_do_usuario}}"}&amp;sig=…
              </code>
            </li>
            <li>
              3. O painel autentica via HMAC e mostra os agentes daquela conta.
            </li>
          </ol>
        </section>
      </main>
    </div>
  );
}

function FeatureCard({
  icon,
  title,
  description,
}: {
  icon: ReactNode;
  title: string;
  description: string;
}) {
  return (
    <div className="rounded-lg border border-border bg-card p-5">
      <div className="flex h-9 w-9 items-center justify-center rounded-md bg-secondary text-secondary-foreground">
        {icon}
      </div>
      <h3 className="mt-3 font-semibold">{title}</h3>
      <p className="mt-1 text-sm text-muted-foreground">{description}</p>
    </div>
  );
}

type ReactNode = React.ReactNode;
