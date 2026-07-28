// Monitor de SAÚDE das integrações de agenda (lógica canônica, server-only).
//
// Uma integração de agenda pode morrer sem ninguém perceber: o refresh_token do
// Google é revogado/expira, um token de API é trocado, uma conta é suspensa. O
// agente só descobre no pior momento possível — quando um lead pede horário — e
// hoje NINGUÉM é avisado. Caso real (16/07/2026): 2 das 5 contas com Google
// Calendar ativo estavam com o refresh_token rejeitado (400) havia dias, e isso
// só apareceu porque uma verificação manual bateu na API por outro motivo.
//
// Este monitor faz, por conta ATIVA, a chamada de leitura mais barata que exige
// autenticação real — a mesma que o "testar conexão" do painel usa — e reporta
// quem está quebrado. Somente LEITURA: não escreve, não desativa integração e
// não fala com lead nenhum. A ação (reconectar o OAuth, trocar o token) é do
// dono da conta.
import type { SupabaseClient } from "@supabase/supabase-js";

export type ProvedorAgenda = "google_calendar" | "clinicorp" | "clinic_experts" | "clinup";

export interface IntegracaoStatus {
  conta: string;
  provedor: ProvedorAgenda;
  ok: boolean;
  /** Mensagem do erro real da API (truncada), só quando ok=false. */
  erro?: string;
}

export interface IntegracoesResumo {
  total: number;
  ok: number;
  quebradas: number;
  status: IntegracaoStatus[];
}

/** Tabela de config + provedor correspondente. O Clinup entrou aqui quando o
 *  despacho do scheduler passou a existir de fato — antes ficava de fora porque
 *  monitorá-lo sugeriria um suporte que não havia. */
const FONTES: { tabela: string; provedor: ProvedorAgenda }[] = [
  { tabela: "google_calendar_tokens", provedor: "google_calendar" },
  { tabela: "clinicorp_config", provedor: "clinicorp" },
  { tabela: "clinic_experts_config", provedor: "clinic_experts" },
  { tabela: "clinup_config", provedor: "clinup" },
];

/** Chamada de leitura mais barata que valida credencial de verdade, por provedor.
 *  Google: `listAvailableCalendars` força o refresh do OAuth — é exatamente onde
 *  o token revogado estoura. Clinicorp/Clinic Experts: lista de profissionais
 *  (uma requisição), em vez da busca de horários (que varre vários dias). */
async function checarProvedor(provedor: ProvedorAgenda, accountId: string): Promise<void> {
  if (provedor === "google_calendar") {
    const { listAvailableCalendars } = await import("@/lib/tools/google-calendar.server");
    await listAvailableCalendars(accountId);
    return;
  }
  if (provedor === "clinicorp") {
    const { listClinicorpProfessionals } = await import("@/lib/tools/clinicorp.server");
    await listClinicorpProfessionals(accountId);
    return;
  }
  if (provedor === "clinup") {
    const { listClinupProfessionals } = await import("@/lib/tools/clinup.server");
    await listClinupProfessionals(accountId);
    return;
  }
  const { listClinicExpertsProfessionals } = await import("@/lib/tools/clinic-experts.server");
  await listClinicExpertsProfessionals(accountId);
}

/**
 * Verifica todas as integrações de agenda ATIVAS e devolve quem responde e quem
 * está quebrado. Nunca lança: uma integração quebrada é um resultado, não um
 * erro do scan — senão a primeira falha esconderia todas as outras.
 */
export async function scanIntegracoesAgenda(sb: SupabaseClient): Promise<IntegracoesResumo> {
  const alvos: { conta: string; provedor: ProvedorAgenda }[] = [];
  for (const { tabela, provedor } of FONTES) {
    const { data, error } = await sb.from(tabela).select("account_id").eq("ativo", true);
    if (error) {
      console.error(`[monitor] integracoes: falha lendo ${tabela}: ${error.message}`);
      continue;
    }
    for (const row of data ?? []) {
      alvos.push({ conta: String((row as { account_id: string }).account_id), provedor });
    }
  }

  const status = await Promise.all(
    alvos.map(async ({ conta, provedor }): Promise<IntegracaoStatus> => {
      try {
        await checarProvedor(provedor, conta);
        return { conta, provedor, ok: true };
      } catch (e) {
        const erro = e instanceof Error ? e.message : String(e);
        return { conta, provedor, ok: false, erro: erro.slice(0, 200) };
      }
    }),
  );

  return {
    total: status.length,
    ok: status.filter((s) => s.ok).length,
    quebradas: status.filter((s) => !s.ok).length,
    status,
  };
}
