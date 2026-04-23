/**
 * Seed mínimo: cria conta de exemplo e um agente "main" usando o template clinicorp_dental.
 * Uso: bun run db:seed
 */
import { db } from "./client";
import { accounts, agents, agentFollowupConfig, agentWarmupConfig } from "./schema";
import { clinicorpDental } from "../templates/clinicorp_dental";
import { sql } from "drizzle-orm";

const ACCOUNT_ID = process.env.SEED_ACCOUNT_ID ?? "demo-account";
const ACCOUNT_NAME = process.env.SEED_ACCOUNT_NAME ?? "Conta Demo";

async function main() {
  console.log(`[seed] criando conta ${ACCOUNT_ID}…`);
  await db
    .insert(accounts)
    .values({ id: ACCOUNT_ID, name: ACCOUNT_NAME })
    .onConflictDoNothing();

  const existing = await db.execute(
    sql`select id from agents where account_id = ${ACCOUNT_ID} and kind = 'main' limit 1`,
  );
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  if ((existing as any).length) {
    console.log("[seed] já existe agente main — pulando.");
    process.exit(0);
  }

  const [agent] = await db
    .insert(agents)
    .values({
      accountId: ACCOUNT_ID,
      name: "Sarai (principal)",
      kind: "main",
      template: clinicorpDental.key,
      systemPrompt: clinicorpDental.default_prompt,
      tools: [...clinicorpDental.default_tools],
    })
    .returning({ id: agents.id });

  await db.insert(agentFollowupConfig).values({
    agentId: agent.id,
    cronExpression: clinicorpDental.followup_defaults.cron,
    maxFollowups: clinicorpDental.followup_defaults.max,
    prompts: clinicorpDental.followup_defaults.prompts,
  });

  await db.insert(agentWarmupConfig).values({
    agentId: agent.id,
    tempoWu1: clinicorpDental.warmup_defaults.wu1,
    tempoWu2: clinicorpDental.warmup_defaults.wu2,
    tempoWu3: clinicorpDental.warmup_defaults.wu3,
    tempoWu4: clinicorpDental.warmup_defaults.wu4,
    tempoWu5: clinicorpDental.warmup_defaults.wu5,
    prompts: clinicorpDental.warmup_defaults.prompts,
  });

  console.log(`[seed] OK — conta=${ACCOUNT_ID} agent=${agent.id}`);
  process.exit(0);
}

main().catch((e) => {
  console.error("[seed] erro:", e);
  process.exit(1);
});
