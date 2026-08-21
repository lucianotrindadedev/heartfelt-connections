import { useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { useQuery } from "@tanstack/react-query";
import {
  BarChart3,
  Loader2,
  CalendarCheck,
  Timer,
  MessageSquare,
  TrendingUp,
  AlertTriangle,
  ShieldCheck,
  Heart,
  Info,
} from "lucide-react";
import { getAgentMetrics } from "@/lib/metrics.functions";
import { OBJECTION_LABELS, type ObjectionKey } from "@/lib/metrics/lead-signals";

type Periodo = 7 | 30 | 90;

/** ms → texto curto que o dono lê sem traduzir ("8s", "1min 20s"). */
function fmtDuration(ms: number): string {
  if (!ms || ms < 0) return "—";
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rest = s % 60;
  if (m < 60) return rest ? `${m}min ${rest}s` : `${m}min`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}min`;
}

function fmtDateTime(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "—";
  return new Intl.DateTimeFormat("pt-BR", {
    timeZone: "America/Sao_Paulo",
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(d);
}

function Kpi({
  icon,
  label,
  value,
  hint,
  tone = "slate",
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  hint?: string;
  tone?: "slate" | "emerald" | "amber" | "sky";
}) {
  const toneClass = {
    slate: "bg-slate-100 text-slate-600",
    emerald: "bg-emerald-100 text-emerald-700",
    amber: "bg-amber-100 text-amber-700",
    sky: "bg-sky-100 text-sky-700",
  }[tone];
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-4">
      <div className="flex items-center gap-2">
        <span className={`flex h-7 w-7 items-center justify-center rounded-lg ${toneClass}`}>
          {icon}
        </span>
        <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
          {label}
        </span>
      </div>
      <p className="mt-2 text-2xl font-bold tracking-tight text-slate-900">{value}</p>
      {hint && <p className="mt-0.5 text-[11px] text-slate-500">{hint}</p>}
    </div>
  );
}

function Section({
  title,
  subtitle,
  icon,
  children,
}: {
  title: string;
  subtitle?: string;
  icon?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    // min-w-0: como item de grid, o padrão é min-width:auto e o conteúdo mais
    // largo estica a coluna para além da tela.
    <section className="min-w-0 rounded-2xl border border-slate-200 bg-white p-5">
      <div className="flex items-start gap-2">
        {icon && <span className="mt-0.5 text-slate-400">{icon}</span>}
        <div>
          <h3 className="text-sm font-semibold text-slate-900">{title}</h3>
          {subtitle && <p className="mt-0.5 text-[12px] leading-snug text-slate-500">{subtitle}</p>}
        </div>
      </div>
      <div className="mt-4">{children}</div>
    </section>
  );
}

/** Barra horizontal proporcional ao maior valor da lista. */
function BarList({
  items,
  emptyText,
  barClass = "bg-primary",
  suffix,
}: {
  items: { label: string; count: number }[];
  emptyText: string;
  barClass?: string;
  suffix?: (item: { label: string; count: number }) => string;
}) {
  if (items.length === 0) {
    return <p className="text-[13px] text-slate-400">{emptyText}</p>;
  }
  const max = Math.max(...items.map((i) => i.count), 1);
  return (
    <ul className="space-y-2.5">
      {items.map((item) => (
        <li key={item.label}>
          <div className="flex items-baseline justify-between gap-3">
            {/* min-w-0 é o que faz `truncate` truncar de verdade: sem ele o item
                flex não encolhe abaixo do próprio conteúdo, e um motivo de
                escalada comprido esticava a coluna inteira, jogando scroll
                horizontal na página no celular. */}
            <span className="min-w-0 flex-1 truncate text-[13px] text-slate-700" title={item.label}>
              {item.label}
            </span>
            <span className="shrink-0 text-[13px] font-semibold text-slate-900">
              {item.count}
              {suffix ? <span className="ml-1 font-normal text-slate-400">{suffix(item)}</span> : null}
            </span>
          </div>
          <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-slate-100">
            <div
              className={`h-full rounded-full ${barClass}`}
              style={{ width: `${Math.max(3, (item.count / max) * 100)}%` }}
            />
          </div>
        </li>
      ))}
    </ul>
  );
}

export function MetricsView({
  accountId,
  onClose,
}: {
  accountId: string;
  onClose: () => void;
}) {
  const [days, setDays] = useState<Periodo>(30);
  const fetchMetrics = useServerFn(getAgentMetrics);

  const q = useQuery({
    queryKey: ["agent-metrics", accountId, days],
    queryFn: () => fetchMetrics({ data: { accountId, days } }),
    // O painel roda em cima de milhares de mensagens: sem cache, cada troca de
    // aba refaria a varredura inteira.
    staleTime: 2 * 60 * 1000,
  });

  const m = q.data;

  return (
    <div className="flex min-h-screen flex-col bg-slate-50">
      {/* Title bar — precisa QUEBRAR: em 375px o título + o seletor de período
          não cabem na mesma linha e, sem wrap, empurravam a página inteira pra
          542px de largura (scroll horizontal no embed dentro do CRM). */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-slate-200 bg-white px-5 py-3">
        <button
          onClick={onClose}
          className="flex shrink-0 items-center gap-1 text-xs font-semibold text-primary hover:text-primary/80"
        >
          ← VOLTAR
        </button>
        <div className="mx-1 hidden h-4 w-px bg-slate-200 sm:block" />
        <div className="flex min-w-0 items-center gap-2">
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-xl bg-emerald-100">
            <BarChart3 className="h-3.5 w-3.5 text-emerald-600" />
          </span>
          <span className="truncate text-sm font-semibold text-foreground">Métricas do agente</span>
        </div>
        <div className="flex-1" />
        <div className="flex shrink-0 items-center gap-1 rounded-full bg-slate-100 p-0.5">
          {([7, 30, 90] as Periodo[]).map((d) => (
            <button
              key={d}
              onClick={() => setDays(d)}
              className={`rounded-full px-3 py-1 text-xs font-semibold transition-colors ${
                days === d ? "bg-white text-slate-900 shadow-sm" : "text-slate-500 hover:text-slate-700"
              }`}
            >
              {d}d
            </button>
          ))}
        </div>
      </div>

      {q.isLoading && (
        <div className="flex flex-1 items-center justify-center">
          <Loader2 className="h-6 w-6 animate-spin text-primary" />
        </div>
      )}

      {q.error && (
        <div className="p-5">
          <p className="text-sm text-rose-600">
            {q.error instanceof Error ? q.error.message : "Erro ao carregar métricas"}
          </p>
        </div>
      )}

      {m && (
        <div className="mx-auto w-full max-w-6xl space-y-5 p-5">
          {(m.truncated.conversas || m.truncated.mensagens) && (
            <div className="flex items-start gap-2 rounded-xl border border-amber-300 bg-amber-50 p-3 text-[12px] text-amber-900">
              <Info className="mt-0.5 h-4 w-4 shrink-0" />
              <span>
                Volume alto no período — os números vêm de uma amostra das conversas mais
                recentes, não do total.{" "}
                {m.truncated.conversas ? (
                  <>
                    Vale para <b>tudo</b> nesta tela.
                  </>
                ) : (
                  <>
                    Conversas, agendamentos, funil e interesses estão <b>completos</b>; só
                    tempo de resposta e objeções (que dependem de ler as mensagens) saem de
                    amostra.
                  </>
                )}{" "}
                As proporções seguem válidas; os absolutos são um piso. Use um período menor
                para o total exato.
              </span>
            </div>
          )}

          {/* ── KPIs ── */}
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Kpi
              icon={<MessageSquare className="h-3.5 w-3.5" />}
              label="Conversas"
              value={m.kpis.conversas.toLocaleString("pt-BR")}
              hint={`${m.kpis.mensagensLead.toLocaleString("pt-BR")} msgs de leads`}
            />
            <Kpi
              icon={<CalendarCheck className="h-3.5 w-3.5" />}
              label="Agendamentos"
              value={m.kpis.agendamentos.toLocaleString("pt-BR")}
              hint="confirmados na agenda"
              tone="emerald"
            />
            <Kpi
              icon={<TrendingUp className="h-3.5 w-3.5" />}
              label="Taxa de agendamento"
              value={`${m.kpis.taxaAgendamento.toLocaleString("pt-BR")}%`}
              hint="das conversas do período"
              tone="sky"
            />
            <Kpi
              icon={<Timer className="h-3.5 w-3.5" />}
              label="Resposta ao lead"
              value={fmtDuration(m.tempoResposta.medianaMs)}
              hint={`mediana · p90 ${fmtDuration(m.tempoResposta.p90Ms)}`}
            />
          </div>

          {/* ── Tempo de resposta detalhado ── */}
          <Section
            title="Tempo de resposta"
            icon={<Timer className="h-4 w-4" />}
            subtitle="O tempo que o lead espera inclui o agrupamento de mensagens (debounce). O tempo do modelo é só o que a IA levou pra pensar — se um subir sem o outro, o gargalo está no ajuste, não na IA."
          >
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <div className="rounded-xl bg-slate-50 p-3">
                <p className="text-[11px] uppercase tracking-wide text-slate-500">Lead esperou (mediana)</p>
                <p className="mt-1 text-lg font-bold text-slate-900">
                  {fmtDuration(m.tempoResposta.medianaMs)}
                </p>
              </div>
              <div className="rounded-xl bg-slate-50 p-3">
                <p className="text-[11px] uppercase tracking-wide text-slate-500">Lead esperou (p90)</p>
                <p className="mt-1 text-lg font-bold text-slate-900">
                  {fmtDuration(m.tempoResposta.p90Ms)}
                </p>
                <p className="text-[10px] text-slate-400">9 em cada 10 abaixo disso</p>
              </div>
              <div className="rounded-xl bg-slate-50 p-3">
                <p className="text-[11px] uppercase tracking-wide text-slate-500">Modelo (mediana)</p>
                <p className="mt-1 text-lg font-bold text-slate-900">
                  {fmtDuration(m.tempoResposta.llmMedianaMs)}
                </p>
                <p className="text-[10px] text-slate-400">p90 {fmtDuration(m.tempoResposta.llmP90Ms)}</p>
              </div>
              <div className="rounded-xl bg-slate-50 p-3">
                <p className="text-[11px] uppercase tracking-wide text-slate-500">Fora do horário</p>
                <p className="mt-1 text-lg font-bold text-slate-900">
                  {m.tempoResposta.foraDeExpediente}
                </p>
                <p className="text-[10px] text-slate-400">respostas após 2h — agente pausado</p>
              </div>
            </div>
            <p className="mt-3 text-[11px] text-slate-400">
              Base: {m.tempoResposta.amostra.toLocaleString("pt-BR")} respostas medidas.
            </p>
          </Section>

          {/* ── Funil ── */}
          <Section
            title="Em que ponto as conversas param"
            icon={<TrendingUp className="h-4 w-4" />}
            subtitle="Onde cada conversa está agora. Acúmulo num degrau é onde você perde lead — é o lugar certo pra mexer no roteiro."
          >
            <BarList
              items={m.funil.map((f) => ({ label: f.label, count: f.count }))}
              emptyText="Sem conversas no período."
              barClass="bg-gradient-to-r from-sky-400 to-sky-500"
            />
            {m.funilSemEstagio > 0 && (
              <p className="mt-3 text-[11px] text-slate-400">
                +{m.funilSemEstagio.toLocaleString("pt-BR")} conversa(s) sem estágio registrado
                (contato que chegou mas nunca teve um turno do agente) — por isso o funil não
                soma o total de conversas.
              </p>
            )}
          </Section>

          {/* ── Objeções + Interesses ── */}
          <div className="grid gap-5 lg:grid-cols-2">
            <Section
              title="Principais objeções dos leads"
              icon={<AlertTriangle className="h-4 w-4" />}
              subtitle={`O que trava a venda, contado uma vez por lead. Leitura automática das mensagens — cobre as formas comuns de escrever, então use a proporção entre os grupos, não o número exato. Base: ${m.objecoesLeadsAnalisados.toLocaleString("pt-BR")} conversas.`}
            >
              <BarList
                items={m.objecoes.map((o) => ({
                  label: OBJECTION_LABELS[o.key as ObjectionKey] ?? o.key,
                  count: o.count,
                }))}
                emptyText="Nenhuma objeção reconhecida no período."
                barClass="bg-gradient-to-r from-rose-400 to-rose-500"
                suffix={(i) =>
                  m.objecoesLeadsAnalisados > 0
                    ? `(${Math.round((i.count / m.objecoesLeadsAnalisados) * 100)}%)`
                    : ""
                }
              />
            </Section>

            <Section
              title="Interesses mais buscados"
              icon={<Heart className="h-4 w-4" />}
              subtitle="O que o lead disse que quer, agrupado. Serve pra decidir campanha, tabela e o que treinar no agente."
            >
              <BarList
                items={m.interesses}
                emptyText="Nenhum interesse registrado no período."
                barClass="bg-gradient-to-r from-violet-400 to-violet-500"
              />
            </Section>
          </div>

          {/* ── Últimos agendamentos ── */}
          <Section
            title="Últimos agendamentos feitos"
            icon={<CalendarCheck className="h-4 w-4" />}
            subtitle="Só os que existem de verdade na agenda (com reserva criada)."
          >
            {m.agendamentos.length === 0 ? (
              <p className="text-[13px] text-slate-400">Nenhum agendamento no período.</p>
            ) : (
              <div className="-mx-1 overflow-x-auto">
                <table className="w-full min-w-[560px] text-[13px]">
                  <thead>
                    <tr className="text-left text-[11px] uppercase tracking-wide text-slate-400">
                      <th className="px-1 pb-2 font-semibold">Paciente</th>
                      <th className="px-1 pb-2 font-semibold">Consulta</th>
                      <th className="px-1 pb-2 font-semibold">Interesse</th>
                      <th className="px-1 pb-2 font-semibold">Agenda</th>
                      <th className="px-1 pb-2 font-semibold">Marcado em</th>
                    </tr>
                  </thead>
                  <tbody>
                    {m.agendamentos.map((a, i) => (
                      <tr key={`${a.name}-${a.bookedAt}-${i}`} className="border-t border-slate-100">
                        <td className="px-1 py-2 font-medium text-slate-800">{a.name}</td>
                        <td className="px-1 py-2 text-slate-600">{fmtDateTime(a.slotIso)}</td>
                        <td className="px-1 py-2 text-slate-600">{a.interest ?? "—"}</td>
                        <td className="px-1 py-2 text-slate-600">{a.agenda ?? "—"}</td>
                        <td className="px-1 py-2 text-slate-500">{fmtDateTime(a.bookedAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Section>

          {/* ── Escaladas + Canais ── */}
          <div className="grid gap-5 lg:grid-cols-2">
            <Section
              title="Motivos de escalada para humano"
              icon={<AlertTriangle className="h-4 w-4" />}
              subtitle="Quando o agente passa a conversa pra equipe. Motivo repetido é buraco de roteiro ou de integração."
            >
              <BarList
                items={m.escaladas.map((e) => ({ label: e.motivo, count: e.count }))}
                emptyText="Nenhuma escalada no período."
                barClass="bg-gradient-to-r from-amber-400 to-amber-500"
              />
            </Section>

            <Section
              title="Canais de entrada"
              icon={<MessageSquare className="h-4 w-4" />}
              subtitle="De onde o lead chega."
            >
              <BarList
                items={m.canais}
                emptyText="Sem conversas no período."
                barClass="bg-gradient-to-r from-slate-400 to-slate-500"
              />
            </Section>
          </div>

          {/* ── Saúde do agendamento ── */}
          <Section
            title="Saúde do agendamento"
            icon={<ShieldCheck className="h-4 w-4" />}
            subtitle="Quantas vezes as travas de segurança precisaram entrar. Zero é o normal; número subindo aqui é problema chegando na agenda antes de virar reclamação."
          >
            <BarList
              items={m.saudeAgendamento}
              emptyText="Nenhuma trava precisou entrar no período. 👌"
              barClass="bg-gradient-to-r from-orange-400 to-orange-500"
            />
            {m.kpis.falhasEntrega > 0 && (
              <p className="mt-3 text-[12px] text-amber-700">
                {m.kpis.falhasEntrega} resposta(s) não confirmaram entrega ao lead.
              </p>
            )}
          </Section>

          {/* ── Volume diário ── */}
          {m.daily.length > 1 && (
            <Section
              title="Volume por dia"
              icon={<BarChart3 className="h-4 w-4" />}
              subtitle="Conversas iniciadas por dia. Serve pra cruzar pico de demanda com campanha e com o tempo de resposta."
            >
              <div className="flex h-32 items-end gap-[3px]">
                {m.daily.map((d) => {
                  const max = Math.max(...m.daily.map((x) => x.conversas), 1);
                  return (
                    <div
                      key={d.day}
                      className="group relative flex-1 rounded-t bg-primary/70 transition-colors hover:bg-primary"
                      style={{ height: `${Math.max(2, (d.conversas / max) * 100)}%` }}
                      title={`${d.day}: ${d.conversas} conversa(s), ${d.mensagens} mensagem(ns)`}
                    />
                  );
                })}
              </div>
              <div className="mt-1.5 flex justify-between text-[10px] text-slate-400">
                <span>{m.daily[0]?.day}</span>
                <span>{m.daily[m.daily.length - 1]?.day}</span>
              </div>
            </Section>
          )}

          <p className="pb-6 text-center text-[11px] text-slate-400">
            Período: últimos {m.days} dias · fuso de Brasília
          </p>
        </div>
      )}
    </div>
  );
}
