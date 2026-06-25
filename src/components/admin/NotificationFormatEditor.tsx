// Editor do formato da notificação de agendamento.
// Vive dentro do AccountEscalationTab — só renderiza quando o toggle
// "Notificar agendamentos" está ligado.
//
// Permite ao superadmin:
//   - editar o TEMPLATE Markdown (com botão "Inserir variável")
//   - ligar/desligar o RESUMO gerado por IA
//   - editar a INSTRUÇÃO usada para gerar o resumo
//   - ver a PRÉ-VISUALIZAÇÃO renderizada com dados de exemplo

import { useEffect, useMemo, useRef, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { useQuery } from "@tanstack/react-query";
import { previewBookingNotification } from "@/lib/evolution.functions";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ChevronDown, RotateCcw } from "lucide-react";

const DEFAULT_TEMPLATE_HINT =
  "*{{tipo_consulta}} {{evento}}*\n\n" +
  "{{nome}} acabou de agendar para o dia {{data}} às {{hora}}.\n" +
  "📱 Telefone: {{telefone}}\n\n" +
  "📝 Resumo: {{resumo}}";

const DEFAULT_INSTRUCTION_HINT =
  "Resuma em 1-2 frases o contexto do lead e o que foi agendado. " +
  "Não use saudações, primeira pessoa, telefone ou links. Máximo 60 palavras.";

interface Props {
  template: string;
  summaryEnabled: boolean;
  summaryInstruction: string;
  onChange: (patch: {
    template?: string;
    summaryEnabled?: boolean;
    summaryInstruction?: string;
  }) => void;
}

export function NotificationFormatEditor({
  template,
  summaryEnabled,
  summaryInstruction,
  onChange,
}: Props) {
  const preview = useServerFn(previewBookingNotification);
  const templateRef = useRef<HTMLTextAreaElement>(null);

  // Debounce do template/toggle para a query de preview (evita 1 request por tecla).
  const [debounced, setDebounced] = useState({ template, summaryEnabled });
  useEffect(() => {
    const t = setTimeout(() => setDebounced({ template, summaryEnabled }), 350);
    return () => clearTimeout(t);
  }, [template, summaryEnabled]);

  const previewQ = useQuery({
    queryKey: ["admin", "booking-preview", debounced.template, debounced.summaryEnabled],
    queryFn: () =>
      preview({
        data: {
          template: debounced.template,
          summary_enabled: debounced.summaryEnabled,
        },
      }),
  });

  // Variáveis usadas no template — para validação visual ("variável desconhecida").
  const usedVars = useMemo(() => {
    const re = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_.]*)\s*\}\}/g;
    const set = new Set<string>();
    let m: RegExpExecArray | null;
    while ((m = re.exec(template))) set.add(m[1]);
    return [...set];
  }, [template]);

  const knownVars = useMemo(() => {
    const groups = previewQ.data?.variables ?? [];
    const set = new Set<string>();
    for (const g of groups) for (const v of g.items) {
      // "cf.<chave>" é placeholder; aceitamos qualquer cf.*
      if (v === "cf.<chave>") continue;
      set.add(v);
    }
    return set;
  }, [previewQ.data?.variables]);

  const unknownVars = usedVars.filter(
    (v) => !knownVars.has(v) && !v.startsWith("cf."),
  );

  function insertVariable(name: string) {
    const ta = templateRef.current;
    const token = `{{${name}}}`;
    if (!ta) {
      onChange({ template: (template || "") + token });
      return;
    }
    const start = ta.selectionStart ?? template.length;
    const end = ta.selectionEnd ?? template.length;
    const next = template.slice(0, start) + token + template.slice(end);
    onChange({ template: next });
    // Reposiciona o cursor depois do token inserido.
    requestAnimationFrame(() => {
      ta.focus();
      const pos = start + token.length;
      ta.setSelectionRange(pos, pos);
    });
  }

  return (
    <div className="space-y-4 border-t border-slate-200 pt-4">
      {/* ── Template da mensagem ─────────────────────────────────────── */}
      <div className="space-y-1.5">
        <div className="flex items-center justify-between gap-2">
          <Label className="text-sm font-medium">Formato da mensagem</Label>
          <div className="flex items-center gap-1">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button size="sm" variant="outline" className="h-7 text-xs">
                  Inserir variável <ChevronDown className="ml-1 h-3 w-3" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="max-h-80 overflow-auto">
                {(previewQ.data?.variables ?? []).map((g, idx) => (
                  <DropdownMenuGroup key={g.group}>
                    {idx > 0 && <DropdownMenuSeparator />}
                    <DropdownMenuLabel className="text-[11px] uppercase tracking-wider text-muted-foreground">
                      {g.group}
                    </DropdownMenuLabel>
                    {g.items.map((v) => (
                      <DropdownMenuItem
                        key={v}
                        onSelect={(e) => {
                          e.preventDefault();
                          if (v === "cf.<chave>") {
                            const k = window.prompt(
                              "Nome do custom field (ex: idade, convidados):",
                            );
                            if (k?.trim()) insertVariable(`cf.${k.trim()}`);
                          } else {
                            insertVariable(v);
                          }
                        }}
                      >
                        <code className="text-xs">{`{{${v}}}`}</code>
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuGroup>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
            <Button
              size="sm"
              variant="ghost"
              className="h-7 text-xs"
              onClick={() => onChange({ template: "" })}
              title="Limpa o campo — volta a usar o template padrão do sistema"
            >
              <RotateCcw className="mr-1 h-3 w-3" /> Restaurar padrão
            </Button>
          </div>
        </div>
        <Textarea
          ref={templateRef}
          value={template}
          onChange={(e) => onChange({ template: e.target.value })}
          placeholder={DEFAULT_TEMPLATE_HINT}
          rows={8}
          className="font-mono text-xs"
        />
        {!template.trim() && (
          <p className="text-[11px] text-muted-foreground">
            Vazio = usa o template padrão do sistema.
          </p>
        )}
        {unknownVars.length > 0 && (
          <p className="text-[11px] text-rose-600">
            Variável desconhecida: {unknownVars.map((v) => `{{${v}}}`).join(", ")}
            {" "}— vai renderizar vazia.
          </p>
        )}
      </div>

      {/* ── Resumo IA ──────────────────────────────────────────────── */}
      <div className="space-y-1.5">
        <div className="flex items-center justify-between gap-2">
          <div>
            <Label className="text-sm font-medium">Resumo gerado por IA</Label>
            <p className="mt-0.5 text-[11px] text-muted-foreground">
              Quando ligado, a IA preenche {"{{resumo}}"} com 1-2 frases sobre o lead.
              Quando desligado, {"{{resumo}}"} fica vazio e o LLM nem é chamado (economiza tokens).
            </p>
          </div>
          <Switch
            checked={summaryEnabled}
            onCheckedChange={(v) => onChange({ summaryEnabled: v })}
          />
        </div>
        <Textarea
          value={summaryInstruction}
          onChange={(e) => onChange({ summaryInstruction: e.target.value })}
          placeholder={DEFAULT_INSTRUCTION_HINT}
          rows={4}
          disabled={!summaryEnabled}
          className="text-xs"
        />
        {summaryEnabled && !summaryInstruction.trim() && (
          <p className="text-[11px] text-muted-foreground">
            Vazio = usa a instrução padrão do sistema.
          </p>
        )}
      </div>

      {/* ── Pré-visualização ───────────────────────────────────────── */}
      <div className="space-y-1.5">
        <Label className="text-sm font-medium">Pré-visualização</Label>
        <div className="whitespace-pre-wrap rounded-md border border-slate-200 bg-slate-50 p-3 text-xs text-slate-800 min-h-[140px]">
          {previewQ.isLoading
            ? "Carregando…"
            : previewQ.data?.rendered || "(vazio)"}
        </div>
        <p className="text-[11px] text-muted-foreground">
          Renderizado com dados de exemplo (Maria Silva / Visita guiada / amanhã). O
          resumo é simulado — não chama o LLM aqui.
        </p>
      </div>
    </div>
  );
}
