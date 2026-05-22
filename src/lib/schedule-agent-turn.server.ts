// Agenda execução do agente após debounce — não depende só do pg_cron.
import { runAgentTurn, ConversationLockedError } from "@/lib/agent-turn.server";

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function resolveAppBaseUrl(): string | null {
  const raw =
    process.env.APP_URL ??
    process.env.PUBLIC_APP_URL ??
    process.env.VERCEL_URL ??
    null;
  if (!raw) return null;
  return raw.startsWith("http") ? raw.replace(/\/$/, "") : `https://${raw}`;
}

type WaitUntilFn = (promise: Promise<unknown>) => void;

function getWaitUntil(): WaitUntilFn | null {
  const g = globalThis as { waitUntil?: WaitUntilFn };
  if (typeof g.waitUntil === "function") return g.waitUntil;
  return null;
}

/** Vercel / runtimes com waitUntil — não precisam da fila pg_cron no mesmo evento. */
export function hasBackgroundTaskSupport(): boolean {
  return getWaitUntil() !== null;
}

/**
 * Dispara UM único caminho de execução após debounce.
 *
 * Na Vercel Build Output API o handler custom não expõe waitUntil no globalThis.
 * Nesse caso NÃO usar só message_queue — o pg_cron roda a cada 1 min (~0–60s de atraso
 * mesmo com debounce=0). Preferir drain HTTP (nova invocação imediata).
 */
export async function dispatchInboundAgentTurn(
  conversationId: string,
  delaySeconds: number,
): Promise<void> {
  if (hasBackgroundTaskSupport()) {
    scheduleConversationAgentTurn(conversationId, delaySeconds);
    return;
  }

  const base = resolveAppBaseUrl();
  const secret = process.env.CRON_SECRET;
  if (base && secret) {
    scheduleConversationAgentTurn(conversationId, delaySeconds);
    return;
  }

  console.warn(
    "[schedule] APP_URL/CRON_SECRET ausente — agente só via pg_cron (até ~60s de atraso)",
  );
  const { enqueueMessage } = await import("@/lib/message-queue.server");
  await enqueueMessage(conversationId, delaySeconds);
}

async function runTurnWithLockRetries(
  conversationId: string,
  lockRetry: number,
): Promise<void> {
  try {
    await runAgentTurn(conversationId);
  } catch (e) {
    if (e instanceof ConversationLockedError) {
      // Outro turno já está rodando; o finally dele reagenda se chegou msg nova.
      console.log(`[schedule] ${conversationId} ocupada — execução duplicada ignorada`);
      return;
    }
    console.error(`[schedule] turn falhou ${conversationId}:`, e);
  }
}

function triggerDrainHttp(
  conversationId: string,
  delaySeconds: number,
  lockRetry: number,
): void {
  const base = resolveAppBaseUrl();
  const secret = process.env.CRON_SECRET;
  if (!base || !secret) {
    console.warn("[schedule] APP_URL ou CRON_SECRET ausente — use pg_cron /api/public/cron/queue");
    return;
  }

  const notBeforeMs = Date.now() + delaySeconds * 1000;
  fetch(`${base}/api/public/cron/drain-conversation`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-cron-secret": secret,
    },
    body: JSON.stringify({
      conversation_id: conversationId,
      not_before_ms: notBeforeMs,
      lock_retry: lockRetry,
    }),
  }).catch((err) => console.error("[schedule] drain HTTP falhou:", err));
}

/**
 * Dispara o agente após o debounce. Usa waitUntil (Vercel) ou HTTP interno como fallback.
 */
export function scheduleConversationAgentTurn(
  conversationId: string,
  delaySeconds: number,
  lockRetry = 0,
): void {
  const task = () => runTurnWithLockRetries(conversationId, lockRetry);

  const waitUntil = getWaitUntil();
  if (waitUntil) {
    waitUntil(
      (async () => {
        if (delaySeconds > 0) await delay(delaySeconds * 1000);
        await task();
      })(),
    );
    return;
  }

  // Sem waitUntil: void task() morre quando o webhook encerra res.end() na mesma invocação.
  triggerDrainHttp(conversationId, delaySeconds, lockRetry);
}
