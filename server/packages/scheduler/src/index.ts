import { CronJob } from "cron";
import { env, logger } from "@sarai/shared";
import { runFollowupTick } from "./followup";
import { runWarmupTick } from "./warmup";

logger.info({ tz: env.SCHEDULER_TZ }, "scheduler starting");

new CronJob("*/10 8-21 * * *", runFollowupTick, null, true, env.SCHEDULER_TZ);
new CronJob("*/10 * * * *", runWarmupTick, null, true, env.SCHEDULER_TZ);
