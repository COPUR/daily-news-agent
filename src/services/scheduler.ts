import cron, { type ScheduledTask } from "node-cron";
import { RunTrigger } from "@prisma/client";
import { env } from "../config/env.js";
import { logger } from "../utils/logger.js";
import { runPipeline } from "./pipeline.js";

let task: ScheduledTask | null = null;
let startedAtIso: string | null = null;

export function startScheduler() {
  stopScheduler();
  const expression = `${env.DAILY_POST_MINUTE_UTC} ${env.DAILY_POST_HOUR_UTC} * * *`;
  task = cron.schedule(expression, async () => {
    try {
      await runPipeline({ trigger: RunTrigger.scheduled });
    } catch (error) {
      logger.error({ error: String(error) }, "scheduled_pipeline_failed");
    }
  }, {
    timezone: "UTC",
  });
  startedAtIso = new Date().toISOString();
  logger.info({ hourUtc: env.DAILY_POST_HOUR_UTC, minuteUtc: env.DAILY_POST_MINUTE_UTC }, "scheduler_started");
}

export function stopScheduler() {
  if (task) {
    task.stop();
    task.destroy();
    task = null;
    startedAtIso = null;
    logger.info("scheduler_stopped");
  }
}

export function schedulerStatus() {
  return {
    running: Boolean(task),
    expression: `${env.DAILY_POST_MINUTE_UTC} ${env.DAILY_POST_HOUR_UTC} * * *`,
    timezone: "UTC",
    startedAt: startedAtIso,
    hourUtc: env.DAILY_POST_HOUR_UTC,
    minuteUtc: env.DAILY_POST_MINUTE_UTC,
  };
}
