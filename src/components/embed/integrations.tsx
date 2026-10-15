// Peças visuais da tela de Integrações (mesma linguagem do FireLeads).
//
// As logos ficam em /public/images/integrations (128px, reduzidas das originais
// de ~1000px). Integração ativa mostra a logo colorida; inativa mostra a mesma
// logo dessaturada — o estado fica legível na varredura da lista sem depender
// só de ler o selo.
import type { ReactNode } from "react";
import { ChevronRight } from "lucide-react";

export const INTEGRATION_LOGOS = {
  clinicorp: "/images/integrations/clinicorp.png",
  clinup: "/images/integrations/clinup.png",
  clinicExperts: "/images/integrations/clinic-experts.png",
  googleCalendar: "/images/integrations/google-calendar.png",
  openrouter: "/images/integrations/openrouter.png",
} as const;

/**
 * Logo oficial do Google Sheets desenhada em SVG (o arquivo não existia nos
 * projetos; a forma é simples o bastante para reproduzir sem imagem).
 */
export function GoogleSheetsLogo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 48 48" aria-hidden="true" className={className}>
      <path d="M29 4H13a3 3 0 0 0-3 3v34a3 3 0 0 0 3 3h22a3 3 0 0 0 3-3V13L29 4Z" fill="#1E8E3E" />
      <path d="M29 4v6a3 3 0 0 0 3 3h6L29 4Z" fill="#8ED1A4" />
      <path
        d="M16 22h16v14H16V22Zm2 2v3h5v-3h-5Zm7 0v3h5v-3h-5Zm-7 5v3h5v-3h-5Zm7 0v3h5v-3h-5Z"
        fill="#fff"
        fillRule="evenodd"
      />
    </svg>
  );
}

/**
 * Quadro da logo. Recebe `src` (imagem) ou `children` (um ícone, para
 * integrações sem logo pública — o CRM da conta é white-label).
 */
export function IntegrationLogo({
  src,
  active,
  children,
}: {
  src?: string;
  active: boolean;
  children?: ReactNode;
}) {
  const estado = active ? "" : "grayscale opacity-40";
  return (
    <span className="flex h-11 w-11 shrink-0 items-center justify-center overflow-hidden rounded-xl border border-slate-200 bg-white p-1">
      {src ? (
        // As logos têm proporções bem diferentes depois de aparadas (ClinUp é
        // quase 4:1, Google Calendar é quadrada). max-* + object-contain deixa
        // cada uma ocupar o máximo do quadro sem distorcer.
        <img
          src={src}
          alt=""
          aria-hidden="true"
          className={`max-h-full max-w-full object-contain transition duration-200 ${estado}`}
        />
      ) : (
        <span
          className={`flex h-full w-full items-center justify-center transition duration-200 ${estado}`}
        >
          {children}
        </span>
      )}
    </span>
  );
}

export function IntegrationStatus({
  active,
  labelOn = "Conectado",
  labelOff = "Inativo",
  tone = "neutral",
}: {
  active: boolean;
  labelOn?: string;
  labelOff?: string;
  /** Cor do selo quando inativo: cinza (padrão) ou âmbar (pendência que trava o agente). */
  tone?: "neutral" | "warn";
}) {
  const off =
    tone === "warn"
      ? { pill: "bg-amber-50 text-amber-700", dot: "bg-amber-500" }
      : { pill: "bg-slate-100 text-slate-500", dot: "bg-slate-400" };
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium ${
        active ? "bg-emerald-50 text-emerald-700" : off.pill
      }`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${active ? "bg-emerald-500" : off.dot}`} />
      {active ? labelOn : labelOff}
    </span>
  );
}

/**
 * Uma linha da lista de integrações: cabeçalho clicável + corpo expansível.
 * Usa <span> no lugar de <p> porque o cabeçalho inteiro é um <button>, e
 * parágrafo dentro de botão é HTML inválido.
 *
 * `standalone`: a linha vira um cartão próprio (borda arredondada + sombra),
 * para integrações que não pertencem a um grupo (CRM, OpenRouter).
 */
export function IntegrationRow({
  logo,
  icon,
  name,
  description,
  active,
  statusOn,
  statusOff,
  statusTone,
  expanded,
  onToggle,
  standalone = false,
  children,
}: {
  logo?: string;
  icon?: ReactNode;
  name: string;
  description: string;
  active: boolean;
  statusOn?: string;
  statusOff?: string;
  statusTone?: "neutral" | "warn";
  expanded: boolean;
  onToggle: () => void;
  standalone?: boolean;
  children: ReactNode;
}) {
  return (
    <div
      className={
        standalone
          ? "overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm"
          : "border-t border-slate-100 first:border-t-0"
      }
    >
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        className="flex w-full items-center gap-3.5 px-5 py-3.5 text-left transition-colors hover:bg-slate-50"
      >
        <IntegrationLogo src={logo} active={active}>
          {icon}
        </IntegrationLogo>
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-semibold text-slate-900">{name}</span>
          <span className="block truncate text-xs text-slate-500">{description}</span>
        </span>
        <IntegrationStatus
          active={active}
          labelOn={statusOn}
          labelOff={statusOff}
          tone={statusTone}
        />
        <ChevronRight
          className={`h-4 w-4 shrink-0 text-slate-400 transition-transform ${expanded ? "rotate-90" : ""}`}
        />
      </button>
      {expanded && (
        <div className="space-y-3 border-t border-slate-100 bg-slate-50/60 px-5 pb-5 pt-4">
          {children}
        </div>
      )}
    </div>
  );
}

/** Cabeçalho de um grupo de integrações ("Integrações de agenda", "Fontes de dados"). */
export function IntegrationGroup({
  icon,
  iconClassName,
  title,
  description,
  children,
}: {
  icon: ReactNode;
  /** Cores do quadro do ícone, ex.: "bg-blue-50 text-blue-600". */
  iconClassName: string;
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
      <header className="flex items-start gap-3.5 px-5 py-4">
        <span
          className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ${iconClassName}`}
        >
          {icon}
        </span>
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-slate-900">{title}</h3>
          <p className="mt-0.5 text-xs text-slate-500">{description}</p>
        </div>
      </header>
      <div className="border-t border-slate-100">{children}</div>
    </section>
  );
}
