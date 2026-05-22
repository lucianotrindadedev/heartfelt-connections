import { Queue, Worker, type Job } from "bullmq";
import { createRedisConnection, isRedisAgentQueueActive, isRedisConfigured } from "@/lib/redis.server";
import { runAgentTurn, ConversationLockedError } from "@/lib/agent-turn.server";
import { conversationNeedsAgentReply } from "@/lib/conversation-reply.server";

const QUEUE_NAME = "agent-turn";

export type AgentTurnJobData = {
  conversationId: string;
  lockRetry: number;
};

let queue: Queue<AgentTurnJobData> | null = null;
let worker: Worker<AgentTurnJobData> | null = null;
let workerStarting = false;

function getQueue(): Queue<AgentTurnJobData> {
  if (!queue) {
    queue = new Queue<AgentTurnJobData>(QUEUE_NAME, {
      connection: createRedisConnection("queue"),
      defaultJobOptions: {
        removeOnComplete: true,
        removeOnFail: 50,
        attempts: 1,
      },
    });
  }
  return queue;
}

async function processAgentTurnJob(job: Job<AgentTurnJobData>): Promise<void> {
  const { conversationId, lockRetry } = job.data;

  if (!(await conversationNeedsAgentReply(conversationId))) {
    console.log(`[redis-queue] ${conversationId} sem resposta pendente — job ignorado`);
    return;
  }

  try {
    await runAgentTurn(conversationId);
  } catch (e) {
    if (e instanceof ConversationLockedError) {
      const maxLockRetries = 5;
      if (lockRetry < maxLockRetries) {
        await enqueueAgentTurn(conversationId, 2, lockRetry + 1);
      }
      console.log(`[redis-queue] ${conversationId} ocupada (retry ${lockRetry})`);
      return;
    }
    throw e;
  }
}

/** Inicia o worker no processo Node (Coolify). Idempotente. */
export function ensureAgentQueueWorker(): void {
  if (!isRedisAgentQueueActive() || worker || workerStarting) return;
  workerStarting = true;

  try {
    worker = new Worker<AgentTurnJobData>(QUEUE_NAME, processAgentTurnJob, {
      connection: createRedisConnection("worker"),
      concurrency: 4,
    });

    worker.on("failed", (job, err) => {
      console.error(`[redis-queue] job ${job?.id} falhou:`, err);
    });

    worker.on("error", (err) => {
      console.error("[redis-queue] worker error:", err);
    });

    console.log("[redis-queue] worker BullMQ iniciado");
  } catch (err) {
    workerStarting = false;
    console.error("[redis-queue] falha ao iniciar worker:", err);
  }
}

/**
 * Agenda turno do agente após debounce. jobId = conversationId substitui job anterior (debounce).
 */
export async function enqueueAgentTurn(
  conversationId: string,
  delaySeconds: number,
  lockRetry = 0,
): Promise<void> {
  if (!isRedisConfigured()) return;

  ensureAgentQueueWorker();

  const q = getQueue();
  const delayMs = Math.max(0, Math.round(delaySeconds * 1000));

  try {
    const existing = await q.getJob(conversationId);
    if (existing) {
      await existing.remove();
    }
  } catch {
    // ignore
  }

  await q.add(
    "turn",
    { conversationId, lockRetry },
    {
      jobId: conversationId,
      delay: delayMs,
    },
  );
}

/** Remove jobs pendentes da conversa (pause IA, reset, etc.). */
export async function cancelAgentTurnJobs(conversationId: string): Promise<void> {
  if (!isRedisConfigured()) return;

  const q = getQueue();
  const job = await q.getJob(conversationId);
  if (job) {
    await job.remove();
  }
}
