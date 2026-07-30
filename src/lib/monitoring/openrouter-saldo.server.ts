// Monitor PREVENTIVO do saldo da OpenRouter (lógica canônica, server-only).
//
// O corte por falta de saldo (src/lib/credits.server.ts) é a rede de segurança:
// ele age quando o dinheiro JÁ acabou e algum lead já ficou sem resposta
// automática. Este monitor existe para que esse momento não chegue de surpresa:
// 2x/dia lê o saldo de cada conta e avisa o grupo de notificações quando ele
// cruza o limite (padrão US$ 2, configurável em OPENROUTER_LOW_BALANCE_USD).
//
// Somente LEITURA: não desliga IA, não etiqueta contato, não fala com lead. A
// ação — recarregar — é do dono da conta.
import type { SupabaseClient } from "@supabase/supabase-js";

import { decryptValue } from "@/lib/crypto.server";
import {
  alertLowBalance,
  fetchOpenRouterBalance,
  recordBalanceReading,
} from "@/lib/credits.server";

/** Limite de aviso em USD. Abaixo disso o grupo é notificado. */
export function lowBalanceThresholdUsd(): number {
  const raw = Number(process.env.OPENROUTER_LOW_BALANCE_USD);
  return Number.isFinite(raw) && raw > 0 ? raw : 2;
}

export interface SaldoStatus {
  conta: string;
  contaNome?: string;
  /** Saldo em USD; null quando a chave não permite ler saldo. */
  saldoUsd: number | null;
  /** Abaixo do limite de aviso. */
  baixo: boolean;
  /** Alerta enviado agora (false quando em cooldown ou sem grupo). */
  alertado: boolean;
  erro?: string;
}

export interface SaldoResumo {
  total: number;
  baixos: number;
  ilegiveis: number;
  limiteUsd: number;
  status: SaldoStatus[];
}

/**
 * Lê o saldo de todas as contas com chave OpenRouter cadastrada e alerta as que
 * estão abaixo do limite. Nunca lança: conta ilegível é resultado, não erro do
 * scan — senão a primeira falha esconderia todas as outras.
 */
export async function scanSaldoOpenRouter(sb: SupabaseClient): Promise<SaldoResumo> {
  const limiteUsd = lowBalanceThresholdUsd();

  const { data: secrets, error } = await sb
    .from("account_secrets")
    .select("account_id, openrouter_api_key_enc");
  if (error) {
    console.error(`[monitor] saldo: falha lendo account_secrets: ${error.message}`);
    return { total: 0, baixos: 0, ilegiveis: 0, limiteUsd, status: [] };
  }

  const contas = (secrets ?? []).filter(
    (r) => !!(r as { openrouter_api_key_enc: string | null }).openrouter_api_key_enc,
  );

  const { data: nomes } = await sb.from("accounts").select("id, nome");
  const nomePorConta = new Map<string, string>();
  for (const a of nomes ?? []) {
    const row = a as { id: string; nome: string | null };
    if (row.nome) nomePorConta.set(row.id, row.nome);
  }

  const status: SaldoStatus[] = [];
  for (const row of contas) {
    const conta = String((row as { account_id: string }).account_id);
    const contaNome = nomePorConta.get(conta);
    try {
      const orKey = await decryptValue(
        (row as { openrouter_api_key_enc: string }).openrouter_api_key_enc,
      );
      if (!orKey) {
        status.push({
          conta,
          contaNome,
          saldoUsd: null,
          baixo: false,
          alertado: false,
          erro: "chave OpenRouter ilegível (falha ao descriptografar)",
        });
        continue;
      }

      const { saldoUsd, erro } = await fetchOpenRouterBalance(orKey);
      await recordBalanceReading(conta, saldoUsd);

      const baixo = saldoUsd !== null && saldoUsd < limiteUsd;
      let alertado = false;
      if (baixo) {
        alertado = await alertLowBalance({
          accountId: conta,
          saldoUsd: saldoUsd!,
          limiteUsd,
          contaLabel: contaNome,
        });
      }
      status.push({ conta, contaNome, saldoUsd, baixo, alertado, erro });
    } catch (e) {
      status.push({
        conta,
        contaNome,
        saldoUsd: null,
        baixo: false,
        alertado: false,
        erro: (e instanceof Error ? e.message : String(e)).slice(0, 200),
      });
    }
  }

  return {
    total: status.length,
    baixos: status.filter((s) => s.baixo).length,
    ilegiveis: status.filter((s) => s.saldoUsd === null).length,
    limiteUsd,
    status,
  };
}
