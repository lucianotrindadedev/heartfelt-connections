// SALDO DA OPENROUTER — o lead nunca paga pela conta zerada.
//
// Quando o saldo da chave acaba, a OpenRouter devolve 402 e TODA chamada do
// agente falha. O comportamento antigo era o pior possível: o orquestrador caía
// no catch genérico e mandava ao lead "Desculpe, tive uma instabilidade
// técnica. Pode me enviar a mensagem de novo em alguns segundos?" — o lead
// reenviava, falhava de novo, e a clínica lia aquilo como bug do produto.
// Ninguém era avisado de que o problema era saldo.
//
// Regra nova (falta de saldo é caso à parte, não "erro técnico"):
//   1. NÃO responde nada ao lead — silêncio total, sem desculpa técnica.
//   2. Etiqueta o contato como "IA Desligada" no CRM → a atendente humana
//      assume aquele atendimento e dá continuidade.
//   3. Alerta o grupo de notificações (Evolution) dizendo que é SALDO, com
//      cooldown para não repetir a cada mensagem que chega.
// Quando o saldo for recarregado, a atendente remove a etiqueta e a IA volta
// naquele contato (a etiqueta já é respeitada por webhook, follow-up e warm-up).
//
// O monitor preventivo (cron monitor-saldo) usa o mesmo canal e o mesmo estado
// para avisar ANTES de zerar — ver src/lib/monitoring/openrouter-saldo.server.ts.
import { getSelfhost } from "@/integrations/selfhost/client.server";
import { AI_DISABLED_TAG } from "@/lib/agent-block.server";
import {
  EvolutionApiError,
  EvolutionConfigMissingError,
  sendText as evoSendText,
} from "@/lib/evolution.server";
import { loadHelenaAccount, setHelenaContactTags } from "@/lib/helena.server";

const CREDITS_URL = "https://openrouter.ai/api/v1/credits";
const KEY_URL = "https://openrouter.ai/api/v1/key";

/** Tipo de alerta de saldo. Cada um tem seu próprio cooldown. */
export type CreditAlertKind = "sem_saldo" | "saldo_baixo";

/** Cooldown por tipo, em minutos.
 *  - sem_saldo: 30min. Com a conta zerada, TODA mensagem que chega cai aqui;
 *    sem cooldown o grupo receberia dezenas de alertas iguais em minutos.
 *  - saldo_baixo: 12h. O monitor roda 2x/dia; um aviso por rodada basta. */
const ALERT_COOLDOWN_MIN: Record<CreditAlertKind, number> = {
  sem_saldo: 30,
  saldo_baixo: 720,
};

const COOLDOWN_COLUMN: Record<CreditAlertKind, string> = {
  sem_saldo: "last_alert_sem_saldo_at",
  saldo_baixo: "last_alert_baixo_at",
};

// ── Leitura do saldo ───────────────────────────────────────────────────────

export interface OpenRouterBalance {
  /** Saldo disponível em USD. null quando a API não permitiu calcular. */
  saldoUsd: number | null;
  /** Endpoint que respondeu ("credits" | "key"). */
  fonte: "credits" | "key" | null;
  /** Erro (truncado) quando não foi possível ler. */
  erro?: string;
}

/**
 * Saldo restante da chave. Tenta /credits (saldo da conta = comprado - gasto) e,
 * se falhar, /key (limit_remaining — só existe em chaves com limite definido).
 * Nunca lança: saldo ilegível é um resultado, não um erro do chamador.
 */
export async function fetchOpenRouterBalance(orKey: string): Promise<OpenRouterBalance> {
  try {
    const res = await fetch(CREDITS_URL, {
      headers: { Authorization: `Bearer ${orKey}` },
      signal: AbortSignal.timeout(20_000),
    });
    if (res.ok) {
      const json = (await res.json()) as {
        data?: { total_credits?: number; total_usage?: number };
      };
      const comprado = Number(json.data?.total_credits);
      const gasto = Number(json.data?.total_usage);
      if (Number.isFinite(comprado) && Number.isFinite(gasto)) {
        return { saldoUsd: comprado - gasto, fonte: "credits" };
      }
    }
  } catch (e) {
    console.warn(`[credits] /credits falhou: ${e instanceof Error ? e.message : e}`);
  }

  try {
    const res = await fetch(KEY_URL, {
      headers: { Authorization: `Bearer ${orKey}` },
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) {
      return {
        saldoUsd: null,
        fonte: null,
        erro: `OpenRouter ${res.status}: ${(await res.text()).slice(0, 200)}`,
      };
    }
    const json = (await res.json()) as {
      data?: { limit_remaining?: number | null; limit?: number | null; usage?: number };
    };
    const restante = json.data?.limit_remaining;
    if (typeof restante === "number" && Number.isFinite(restante)) {
      return { saldoUsd: restante, fonte: "key" };
    }
    // Chave sem limite: /key não informa saldo. Sem erro — só sem número.
    return { saldoUsd: null, fonte: "key" };
  } catch (e) {
    return {
      saldoUsd: null,
      fonte: null,
      erro: (e instanceof Error ? e.message : String(e)).slice(0, 200),
    };
  }
}

// ── Estado por conta (cooldown de alerta) ──────────────────────────────────

/**
 * Reserva o direito de alertar: true só quando não houve alerta do MESMO tipo
 * dentro do cooldown. Já grava o carimbo ao devolver true (quem chama envia em
 * seguida) — repetir a leitura depois do envio abriria janela para duplicar.
 */
async function reserveAlertSlot(accountId: string, kind: CreditAlertKind): Promise<boolean> {
  const sb = getSelfhost();
  const coluna = COOLDOWN_COLUMN[kind];
  const { data } = await sb
    .from("account_credit_state")
    .select(coluna)
    .eq("account_id", accountId)
    .maybeSingle();

  const ultimo = (data as Record<string, string | null> | null)?.[coluna];
  if (ultimo) {
    const idadeMin = (Date.now() - new Date(ultimo).getTime()) / 60_000;
    if (Number.isFinite(idadeMin) && idadeMin < ALERT_COOLDOWN_MIN[kind]) return false;
  }

  const agora = new Date().toISOString();
  const { error } = await sb
    .from("account_credit_state")
    .upsert({ account_id: accountId, [coluna]: agora }, { onConflict: "account_id" });
  if (error) {
    // Falha ao gravar o carimbo não pode calar o alerta — melhor alertar duas
    // vezes do que a clínica nunca descobrir que a IA parou por saldo.
    console.error(`[credits] falha ao gravar cooldown (${kind}): ${error.message}`);
  }
  return true;
}

/** Registra a falha de saldo observada num turno (diagnóstico, não bloqueia nada). */
export async function recordNoCreditsFailure(accountId: string, erro: string): Promise<void> {
  const sb = getSelfhost();
  const { error } = await sb.from("account_credit_state").upsert(
    {
      account_id: accountId,
      last_sem_saldo_at: new Date().toISOString(),
      last_error: erro.slice(0, 500),
    },
    { onConflict: "account_id" },
  );
  if (error) console.error(`[credits] falha ao registrar sem-saldo: ${error.message}`);
}

/** Registra o saldo lido pelo monitor preventivo. */
export async function recordBalanceReading(
  accountId: string,
  saldoUsd: number | null,
): Promise<void> {
  const sb = getSelfhost();
  await sb
    .from("account_credit_state")
    .upsert({ account_id: accountId, last_balance_usd: saldoUsd }, { onConflict: "account_id" });
}

// ── Canal de notificações (grupo Evolution por agente) ─────────────────────

interface AlertTarget {
  instance: string;
  grupo: string;
}

/**
 * Grupos de notificação da conta. Diferente da escalada humana, aqui NÃO
 * checamos o toggle `ativo`: isso não é um alerta de lead, é um aviso
 * operacional de que a IA da conta parou. Quem configurou instância + grupo
 * quer ser avisado disso.
 */
async function resolveAlertTargets(accountId: string): Promise<AlertTarget[]> {
  const sb = getSelfhost();
  const { data: agents } = await sb.from("agents").select("id").eq("account_id", accountId);
  const ids = (agents ?? []).map((a) => (a as { id: string }).id);
  if (ids.length === 0) return [];

  const { data: escs } = await sb
    .from("agent_escalation")
    .select("evolution_instance, grupo_alerta")
    .in("agent_id", ids);

  const vistos = new Set<string>();
  const out: AlertTarget[] = [];
  for (const row of escs ?? []) {
    const instance = (
      (row as { evolution_instance: string | null }).evolution_instance ?? ""
    ).trim();
    const grupo = ((row as { grupo_alerta: string | null }).grupo_alerta ?? "").trim();
    if (!instance || !grupo) continue;
    const chave = `${instance}|${grupo}`;
    if (vistos.has(chave)) continue;
    vistos.add(chave);
    out.push({ instance, grupo });
  }
  return out;
}

/** Envia o texto a todos os grupos de notificação da conta. Nunca lança. */
async function sendToAlertChannels(accountId: string, text: string): Promise<boolean> {
  const targets = await resolveAlertTargets(accountId);
  if (targets.length === 0) {
    console.warn(
      `[credits] conta ${accountId} sem grupo de notificação configurado — alerta de saldo não enviado`,
    );
    return false;
  }
  let algumOk = false;
  for (const t of targets) {
    try {
      const res = await evoSendText({ instance: t.instance, number: t.grupo, text });
      if (res.ok) algumOk = true;
      else {
        console.error(
          `[credits] Evolution sendText falhou ${res.status}: ${res.body.slice(0, 200)}`,
        );
      }
    } catch (e) {
      if (e instanceof EvolutionConfigMissingError) {
        console.warn("[credits] Evolution global não configurada — alerta não enviado");
      } else if (e instanceof EvolutionApiError) {
        console.error(`[credits] Evolution API error: ${e.message}`);
      } else {
        console.error("[credits] falha ao enviar alerta Evolution:", e);
      }
    }
  }
  return algumOk;
}

// ── Mensagens ──────────────────────────────────────────────────────────────

function formatPhoneDisplay(phone: string): string {
  const digits = (phone ?? "").replace(/\D/g, "");
  if (!digits) return phone;
  if (digits.startsWith("55") && digits.length >= 12) return `+${digits}`;
  if (digits.length === 10 || digits.length === 11) return `+55${digits}`;
  return `+${digits}`;
}

function nowBrt(): string {
  return new Intl.DateTimeFormat("pt-BR", {
    timeZone: "America/Sao_Paulo",
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date());
}

function formatUsd(v: number): string {
  return `US$ ${v.toFixed(2)}`;
}

function buildNoCreditsMessage(args: {
  agentName?: string;
  leadName?: string;
  phone?: string;
  tagged: boolean;
}): string {
  const lines: string[] = [];
  lines.push(
    args.agentName
      ? `🔴 *IA PAUSADA — SALDO ESGOTADO*  •  _${args.agentName}_`
      : "🔴 *IA PAUSADA — SALDO ESGOTADO*",
  );
  lines.push("");
  lines.push("O saldo da OpenRouter acabou e a IA não consegue responder.");
  lines.push("");
  if (args.leadName?.trim()) lines.push(`👤 *Lead:* ${args.leadName.trim()}`);
  if (args.phone) lines.push(`📱 *Telefone:* ${formatPhoneDisplay(args.phone)}`);
  lines.push(`🕒 *Quando:* ${nowBrt()}`);
  lines.push("");
  lines.push("⚠️ O lead *não recebeu resposta automática* — nada de desculpa técnica.");
  lines.push(
    args.tagged
      ? `🏷️ O contato foi etiquetado como "${AI_DISABLED_TAG}": *assumam esse atendimento manualmente*.`
      : `🏷️ Não foi possível etiquetar o contato no CRM — *respondam esse lead manualmente*.`,
  );
  lines.push("");
  lines.push(
    `✅ Depois de recarregar o saldo, remova a etiqueta "${AI_DISABLED_TAG}" do contato para a IA voltar a atender.`,
  );
  return lines.join("\n");
}

function buildLowBalanceMessage(args: {
  saldoUsd: number;
  limiteUsd: number;
  contaLabel?: string;
}): string {
  const lines: string[] = [];
  lines.push(
    args.contaLabel
      ? `🟡 *SALDO BAIXO NA OPENROUTER*  •  _${args.contaLabel}_`
      : "🟡 *SALDO BAIXO NA OPENROUTER*",
  );
  lines.push("");
  lines.push(`💳 *Saldo atual:* ${formatUsd(args.saldoUsd)}`);
  lines.push(`📉 *Aviso a partir de:* ${formatUsd(args.limiteUsd)}`);
  lines.push(`🕒 *Verificado em:* ${nowBrt()}`);
  lines.push("");
  lines.push(
    "Quando zerar, a IA para de responder e cada atendimento passa para a equipe. Recarregue antes disso.",
  );
  return lines.join("\n");
}

// ── Ações ──────────────────────────────────────────────────────────────────

export interface NoCreditsHaltResult {
  /** Etiqueta "IA Desligada" aplicada no contato. */
  tagged: boolean;
  /** Alerta enviado ao grupo neste turno (false também quando em cooldown). */
  alerted: boolean;
}

/**
 * Corte por falta de saldo: pausa a IA NESTE contato e avisa o grupo.
 * NÃO envia nada ao lead — o silêncio é proposital, quem continua o
 * atendimento é a atendente humana.
 */
export async function haltConversationForNoCredits(params: {
  accountId: string;
  agentId: string;
  conversationId: string;
  agentName?: string;
  helenaContactId?: string;
  /** Tags atuais do contato — evita que o CRM sobrescreva as demais etiquetas. */
  currentTags?: string[];
  leadName?: string;
  phone?: string;
  erro: string;
  /** Modo teste: não escreve etiqueta no CRM (mesma semântica da escalada). */
  disableTags?: boolean;
}): Promise<NoCreditsHaltResult> {
  await recordNoCreditsFailure(params.accountId, params.erro);

  let tagged = false;
  if (params.disableTags) {
    console.log(`[credits] modo teste — etiqueta "${AI_DISABLED_TAG}" NÃO aplicada (só alerta).`);
  } else if (params.helenaContactId) {
    try {
      const helena = await loadHelenaAccount(params.accountId);
      const res = await setHelenaContactTags(
        helena,
        params.helenaContactId,
        [AI_DISABLED_TAG],
        "InsertIfNotExists",
        { currentTags: params.currentTags },
      );
      tagged = res.ok;
      if (!res.ok) {
        console.error(
          `[credits] etiqueta "${AI_DISABLED_TAG}" falhou: ${res.status} ${res.body?.slice(0, 200)}`,
        );
      }
    } catch (e) {
      console.error("[credits] falha ao etiquetar no Helena:", e);
    }
  } else {
    console.warn(
      "[credits] sem helenaContactId — etiqueta não aplicada (o alerta segue para o grupo)",
    );
  }

  let alerted = false;
  if (await reserveAlertSlot(params.accountId, "sem_saldo")) {
    alerted = await sendToAlertChannels(
      params.accountId,
      buildNoCreditsMessage({
        agentName: params.agentName,
        leadName: params.leadName,
        phone: params.phone,
        tagged,
      }),
    );
  }

  console.error(
    `[credits:telemetry] ${JSON.stringify({
      event: "openrouter_sem_saldo",
      account: params.accountId,
      agent: params.agentId,
      conv: params.conversationId,
      tagged,
      alerted,
      erro: params.erro.slice(0, 200),
    })}`,
  );

  return { tagged, alerted };
}

/** Aviso preventivo de saldo baixo (cron). Respeita o cooldown de 12h. */
export async function alertLowBalance(params: {
  accountId: string;
  saldoUsd: number;
  limiteUsd: number;
  contaLabel?: string;
}): Promise<boolean> {
  if (!(await reserveAlertSlot(params.accountId, "saldo_baixo"))) return false;
  return sendToAlertChannels(
    params.accountId,
    buildLowBalanceMessage({
      saldoUsd: params.saldoUsd,
      limiteUsd: params.limiteUsd,
      contaLabel: params.contaLabel,
    }),
  );
}
