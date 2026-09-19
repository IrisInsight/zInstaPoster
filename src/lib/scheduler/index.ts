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
export async function sweepDuePosts(now = new Date()): Promise<
  { postId: string; status: string; error?: string }[]
> {
  const { and, eq, lte } = await import("drizzle-orm");
  const { getDb, post } = await import("@/lib/db");
  const { publishPostById } = await import("@/lib/instagram/publish");

  const db = await getDb();
  const due = await db
    .select()
    .from(post)
    .where(and(eq(post.status, "scheduled"), lte(post.scheduledFor, now)));

  const results: { postId: string; status: string; error?: string }[] = [];
  for (const row of due) {
    try {
      const outcome = await publishPostById({
        postId: row.id,
        actorLabel: "scheduler (sweep)",
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
