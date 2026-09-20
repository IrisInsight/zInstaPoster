import { env } from "@/lib/env";

/**
 * The scheduler.
 *
 * Vercel Cron is deliberately not used: its granularity is too coarse for
 * minute-level publishing. QStash fires a single job at publish time, and
 * that one job runs all three Instagram steps — containers expire after 24
 * hours, so nothing can be created in advance.
 *
 * With no QSTASH_TOKEN the local driver runs instead: an in-process timer for
 * this process's lifetime, plus a sweep endpoint that catches anything due.
 * The sweep is the durable half; the timer just makes dev feel immediate.
 */

export type SchedulerDriver = "qstash" | "local";

/**
 * How long a post may sit in `publishing` before the sweep calls it failed.
 *
 * Has to stay comfortably longer than PUBLISH_BUDGET_MS, the longest a live
 * publish can run: a sweep that failed a post still in flight would invite a
 * retry alongside it, and that is how a carousel goes out twice.
 */
export const STUCK_PUBLISHING_MS = 20 * 60 * 1000;

/**
 * How long one sweep may spend publishing before it leaves the rest to the
 * next run. The sweep is a safety net that can find several due posts at once,
 * and a sweep killed mid-publish parks that post in `publishing` — the exact
 * state it exists to clear.
 */
export const SWEEP_PUBLISH_BUDGET_MS = 8 * 60 * 1000;

/**
 * Below this, a due post waits for the next sweep instead of being published
 * against a stopwatch: a publish that runs out of time marks the post failed,
 * and that takes a scheduled post out of automation for a clock reason rather
 * than a real one.
 */
const MIN_PUBLISH_SLICE_MS = 2 * 60 * 1000;

export function schedulerDriver(): SchedulerDriver {
  return env.qstashToken ? "qstash" : "local";
}

export interface ScheduledJob {
  jobId: string;
  driver: SchedulerDriver;
}

const localTimers = new Map<string, ReturnType<typeof setTimeout>>();

function publishEndpoint(): string {
  return `${env.appBaseUrl}/api/jobs/publish`;
}

export async function schedulePublish(input: {
  postId: string;
  at: Date;
}): Promise<ScheduledJob> {
  const delayMs = Math.max(0, input.at.getTime() - Date.now());

  if (schedulerDriver() === "qstash") {
    const { Client } = await import("@upstash/qstash");
    const client = new Client({ token: env.qstashToken as string });
    const result = await client.publishJSON({
      url: publishEndpoint(),
      body: { postId: input.postId },
      headers: { "x-cron-secret": env.cronSecret ?? "" },
      notBefore: Math.floor(input.at.getTime() / 1000),
      retries: 2,
    });
    return { jobId: result.messageId, driver: "qstash" };
  }

  const jobId = `local:${input.postId}:${input.at.getTime()}`;
  cancelLocal(input.postId);
  // Node caps setTimeout at ~24.8 days; beyond that the sweep handles it.
  if (delayMs < 2_000_000_000) {
    const timer = setTimeout(() => {
      localTimers.delete(input.postId);
      void runLocalPublish(input.postId);
    }, delayMs);
    if (typeof timer.unref === "function") timer.unref();
    localTimers.set(input.postId, timer);
  }
  return { jobId, driver: "local" };
}

export async function cancelScheduledJob(jobId: string | null | undefined): Promise<void> {
  if (!jobId) return;
  if (jobId.startsWith("local:")) {
    const postId = jobId.split(":")[1];
    cancelLocal(postId);
    return;
  }
  if (!env.qstashToken) return;
  const { Client } = await import("@upstash/qstash");
  const client = new Client({ token: env.qstashToken });
  await client.messages.delete(jobId).catch(() => undefined);
}

function cancelLocal(postId: string): void {
  const existing = localTimers.get(postId);
  if (existing) {
    clearTimeout(existing);
    localTimers.delete(postId);
  }
}

async function runLocalPublish(postId: string): Promise<void> {
  const { publishPostById } = await import("@/lib/instagram/publish");
  try {
    await publishPostById({ postId, actorLabel: "scheduler (local)" });
  } catch (error) {
    console.error(`Local scheduler failed to publish ${postId}`, error);
  }
}

/**
 * Publishes everything whose scheduled time has passed. Idempotent: a post
 * already publishing or published is skipped.
 */
export async function sweepDuePosts(
  now = new Date(),
  options: { budgetMs?: number } = {},
): Promise<{ postId: string; status: string; error?: string }[]> {
  const { and, eq, lt, lte } = await import("drizzle-orm");
  const { getDb, post } = await import("@/lib/db");
  const { publishPostById } = await import("@/lib/instagram/publish");

  const db = await getDb();

  // A post whose publish job died mid-flight would otherwise sit in
  // `publishing` forever, invisible to both the scheduler and the operator.
  const stuckSince = new Date(now.getTime() - STUCK_PUBLISHING_MS);
  const stuck = await db
    .update(post)
    .set({
      status: "failed",
      failureReason:
        "The publish job stopped before it finished. Nothing was confirmed published — check the account before retrying.",
      updatedAt: now,
    })
    .where(and(eq(post.status, "publishing"), lt(post.updatedAt, stuckSince)))
    .returning();
  const due = await db
    .select()
    .from(post)
    .where(and(eq(post.status, "scheduled"), lte(post.scheduledFor, now)));

  const results: { postId: string; status: string; error?: string }[] = stuck.map(
    (row) => ({ postId: row.id, status: "stuck-marked-failed" }),
  );
  const deadline =
    Date.now() + (options.budgetMs ?? SWEEP_PUBLISH_BUDGET_MS);
  for (const row of due) {
    const budgetMs = deadline - Date.now();
    if (budgetMs < MIN_PUBLISH_SLICE_MS) {
      // Still `scheduled`, so the next sweep picks it up with a full slice.
      results.push({ postId: row.id, status: "deferred" });
      continue;
    }
    try {
      const outcome = await publishPostById({
        postId: row.id,
        actorLabel: "scheduler (sweep)",
        budgetMs,
      });
      results.push({ postId: row.id, status: outcome.status, error: outcome.error });
    } catch (error) {
      results.push({ postId: row.id, status: "error", error: String(error) });
    }
  }
  return results;
}

/** Restores in-process timers after a restart, for the local driver. */
export async function rehydrateLocalSchedule(): Promise<number> {
  if (schedulerDriver() !== "local") return 0;
  const { and, eq, gt } = await import("drizzle-orm");
  const { getDb, post } = await import("@/lib/db");
  const db = await getDb();
  const upcoming = await db
    .select()
    .from(post)
    .where(and(eq(post.status, "scheduled"), gt(post.scheduledFor, new Date())));
  for (const row of upcoming) {
    if (row.scheduledFor) {
      await schedulePublish({ postId: row.id, at: row.scheduledFor });
    }
  }
  return upcoming.length;
}
