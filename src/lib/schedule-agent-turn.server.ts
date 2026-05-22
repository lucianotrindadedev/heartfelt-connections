// Agenda execução do agente após debounce — não depende só do pg_cron.
import { runAgentTurn, ConversationLockedError } from "@/lib/agent-turn.server";
import { resolveAppBaseUrl } from "@/lib/app-base-url";

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
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
/** Segundos extras na fila pg_cron se waitUntil/drain falhar (cron ~1 min). */
const QUEUE_BACKUP_EXTRA_SEC = 15;

export async function dispatchInboundAgentTurn(
  conversationId: string,
  delaySeconds: number,
): Promise<void> {
  scheduleConversationAgentTurn(conversationId, delaySeconds);

  // Rede de segurança: se waitUntil/drain HTTP falhar, o cron processa depois.
  // processQueue ignora se o agente já respondeu (evita duplicata).
  const { enqueueMessage } = await import("@/lib/message-queue.server");
  await enqueueMessage(conversationId, delaySeconds + QUEUE_BACKUP_EXTRA_SEC);
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
  void fetch(`${base}/api/public/cron/drain-conversation`, {
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
  })
    .then(async (res) => {
      if (res.ok) return;
      const body = await res.text();
      console.error(
        `[schedule] drain HTTP ${res.status} ${conversationId}: ${body.slice(0, 300)}`,
      );
      const { enqueueMessage } = await import("@/lib/message-queue.server");
      await enqueueMessage(conversationId, Math.max(delaySeconds, 5));
    })
    .catch(async (err) => {
      console.error("[schedule] drain HTTP falhou:", err);
      const { enqueueMessage } = await import("@/lib/message-queue.server");
      await enqueueMessage(conversationId, Math.max(delaySeconds, 5));
    });
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
