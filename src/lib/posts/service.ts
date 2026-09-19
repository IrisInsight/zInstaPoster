import { and, desc, eq, inArray } from "drizzle-orm";
import { recordAudit } from "@/lib/audit";
import { evaluate, type ComplianceReport } from "@/lib/compliance/engine";
import { complianceSubjectFor } from "@/lib/content/pipeline";
import {
  auditLog,
  getDb,
  igAccount,
  photoGeneration,
  post,
  slide,
  tenant,
  type Post,
  type PostStatus,
  type Slide,
} from "@/lib/db";
import { cancelScheduledJob, schedulePublish } from "@/lib/scheduler";
import { tenantConfigFromRow, type TenantConfig } from "@/lib/tenants";
import {
  assertTransition,
  editInvalidatesApproval,
  TransitionError,
  type Actor,
} from "./state-machine";
import { MAX_CAROUSEL_ITEMS, MIN_CAROUSEL_ITEMS } from "@/lib/instagram/publish";

export interface PostWithSlides {
  post: Post;
  slides: Slide[];
  tenant: TenantConfig;
  tenantId: string;
  account?: { id: string; username: string } | null;
}

export async function loadTenantConfig(tenantId: string): Promise<TenantConfig> {
  const db = await getDb();
  const [row] = await db.select().from(tenant).where(eq(tenant.id, tenantId));
  if (!row) throw new Error(`No tenant ${tenantId}.`);
  return tenantConfigFromRow(row);
}

export async function loadPost(postId: string): Promise<PostWithSlides> {
  const db = await getDb();
  const [row] = await db.select().from(post).where(eq(post.id, postId));
  if (!row) throw new Error(`No post ${postId}.`);
  const slides = await db
    .select()
    .from(slide)
    .where(eq(slide.postId, postId))
    .orderBy(slide.position);
  const config = await loadTenantConfig(row.tenantId);
  let account: { id: string; username: string } | null = null;
  if (row.igAccountId) {
    const [acc] = await db
      .select()
      .from(igAccount)
      .where(eq(igAccount.id, row.igAccountId));
    account = acc ? { id: acc.id, username: acc.username } : null;
  }
  return { post: row, slides, tenant: config, tenantId: row.tenantId, account };
}

export async function recomputeCompliance(postId: string): Promise<ComplianceReport> {
  const db = await getDb();
  const { post: current, slides, tenant: config } = await loadPost(postId);
  const report = evaluate(
    config.compliance_rules,
    complianceSubjectFor({
      caption: current.caption,
      slides: slides.map((s) => ({
        position: s.position,
        type: s.type,
        copy: s.copy as Record<string, unknown>,
        photoUrl: s.photoUrl,
        photoPrompt: s.photoPrompt,
      })),
    }),
  );
  await db
    .update(post)
    .set({ complianceReport: report, updatedAt: new Date() })
    .where(eq(post.id, postId));
  return report;
}

async function transition(input: {
  postId: string;
  to: PostStatus;
  actor: Actor;
  patch?: Partial<typeof post.$inferInsert>;
  action?: string;
  payload?: Record<string, unknown>;
}): Promise<Post> {
  const db = await getDb();
  const [current] = await db.select().from(post).where(eq(post.id, input.postId));
  if (!current) throw new TransitionError(`No post ${input.postId}.`);

  const report = (current.complianceReport ?? null) as ComplianceReport | null;
  assertTransition({
    from: current.status as PostStatus,
    to: input.to,
    actor: input.actor,
    hasBlockingFindings: report
      ? report.findings.some((f) => f.severity === "blocking")
      : false,
    approvedBy: current.approvedBy,
  });

  const [updated] = await db
    .update(post)
    .set({ status: input.to, updatedAt: new Date(), ...input.patch })
    .where(eq(post.id, input.postId))
    .returning();

  await recordAudit({
    tenantId: current.tenantId,
    postId: current.id,
    actor: input.actor,
    action: input.action ?? `post.${input.to}`,
    payload: { from: current.status, to: input.to, ...(input.payload ?? {}) },
  });
  return updated;
}

export async function submitForApproval(input: {
  postId: string;
  actor: Actor;
}): Promise<Post> {
  const report = await recomputeCompliance(input.postId);
  if (!report.approvable) {
    throw new TransitionError(
      "This post has blocking compliance errors and cannot be submitted for approval.",
    );
  }
  return transition({ ...input, to: "pending_approval" });
}

/**
 * The approval gate. Only a human, only from pending_approval, only with a
 * clean compliance report. Approving does not publish anything — Approve and
 * Post now are separate actions on purpose.
 */
export async function approvePost(input: {
  postId: string;
  actor: Actor;
}): Promise<Post> {
  if (input.actor.type !== "human") {
    throw new TransitionError("Only a person can approve a post.");
  }
  const report = await recomputeCompliance(input.postId);
  if (!report.approvable) {
    throw new TransitionError(
      "Compliance errors appeared since this post was last checked. Resolve them and try again.",
    );
  }
  return transition({
    postId: input.postId,
    to: "approved",
    actor: input.actor,
    patch: { approvedBy: input.actor.label, approvedAt: new Date() },
    action: "post.approved",
  });
}

export async function rejectPost(input: {
  postId: string;
  actor: Actor;
  note?: string;
}): Promise<Post> {
  const db = await getDb();
  const [current] = await db.select().from(post).where(eq(post.id, input.postId));
  if (current?.scheduleJobId) await cancelScheduledJob(current.scheduleJobId);
  return transition({
    postId: input.postId,
    to: "rejected",
    actor: input.actor,
    patch: { approvedBy: null, approvedAt: null, scheduleJobId: null, scheduledFor: null },
    action: "post.rejected",
    payload: { note: input.note ?? null },
  });
}

export async function schedulePost(input: {
  postId: string;
  at: Date;
  actor: Actor;
}): Promise<Post> {
  if (input.actor.type !== "human") {
    throw new TransitionError("Only a person can schedule a post.");
  }
  if (input.at.getTime() <= Date.now()) {
    throw new TransitionError("Pick a time in the future.");
  }
  const db = await getDb();
  const [current] = await db.select().from(post).where(eq(post.id, input.postId));
  if (current?.scheduleJobId) await cancelScheduledJob(current.scheduleJobId);

  // The job is registered first: if scheduling fails, the post stays approved
  // rather than claiming a schedule that does not exist.
  const job = await schedulePublish({ postId: input.postId, at: input.at });

  return transition({
    postId: input.postId,
    to: "scheduled",
    actor: input.actor,
    patch: { scheduledFor: input.at, scheduleJobId: job.jobId },
    action: "post.scheduled",
    payload: { scheduledFor: input.at.toISOString(), driver: job.driver },
  });
}

export async function unschedulePost(input: {
  postId: string;
  actor: Actor;
}): Promise<Post> {
  const db = await getDb();
  const [current] = await db.select().from(post).where(eq(post.id, input.postId));
  if (current?.scheduleJobId) await cancelScheduledJob(current.scheduleJobId);
  const [updated] = await db
    .update(post)
    .set({
      status: "approved",
      scheduledFor: null,
      scheduleJobId: null,
      updatedAt: new Date(),
    })
    .where(eq(post.id, input.postId))
    .returning();
  await recordAudit({
    tenantId: updated.tenantId,
    postId: updated.id,
    actor: input.actor,
    action: "post.unscheduled",
  });
  return updated;
}

export async function updateCaption(input: {
  postId: string;
  caption: string;
  actor: Actor;
}): Promise<ComplianceReport> {
  const db = await getDb();
  const [current] = await db.select().from(post).where(eq(post.id, input.postId));
  if (!current) throw new Error(`No post ${input.postId}.`);

  const patch: Partial<typeof post.$inferInsert> = {
    caption: input.caption,
    updatedAt: new Date(),
  };
  // Editing after approval withdraws the approval. Someone has to look again.
  if (editInvalidatesApproval(current.status as PostStatus)) {
    if (current.scheduleJobId) await cancelScheduledJob(current.scheduleJobId);
    patch.status = "pending_approval";
    patch.approvedBy = null;
    patch.approvedAt = null;
    patch.scheduledFor = null;
    patch.scheduleJobId = null;
  }
  await db.update(post).set(patch).where(eq(post.id, input.postId));
  await recordAudit({
    tenantId: current.tenantId,
    postId: current.id,
    actor: input.actor,
    action: "post.caption_edited",
    payload: { approvalWithdrawn: Boolean(patch.approvedBy === null && current.approvedBy) },
  });
  return recomputeCompliance(input.postId);
}

export async function updateSlideCopy(input: {
  postId: string;
  slideId: string;
  copy: Record<string, unknown>;
  altText?: string;
  actor: Actor;
}): Promise<void> {
  const db = await getDb();
  const [current] = await db.select().from(post).where(eq(post.id, input.postId));
  if (!current) throw new Error(`No post ${input.postId}.`);

  await db
    .update(slide)
    .set({
      copy: input.copy,
      ...(input.altText !== undefined ? { altText: input.altText } : {}),
    })
    .where(eq(slide.id, input.slideId));

  if (editInvalidatesApproval(current.status as PostStatus)) {
    if (current.scheduleJobId) await cancelScheduledJob(current.scheduleJobId);
    await db
      .update(post)
      .set({
        status: "pending_approval",
        approvedBy: null,
        approvedAt: null,
        scheduledFor: null,
        scheduleJobId: null,
        updatedAt: new Date(),
      })
      .where(eq(post.id, input.postId));
  }

  await recordAudit({
    tenantId: current.tenantId,
    postId: current.id,
    actor: input.actor,
    action: "slide.edited",
    payload: { slideId: input.slideId },
  });
}

export async function reorderSlides(input: {
  postId: string;
  order: string[];
  actor: Actor;
}): Promise<void> {
  if (input.order.length < MIN_CAROUSEL_ITEMS || input.order.length > MAX_CAROUSEL_ITEMS) {
    throw new Error(
      `A carousel must have between ${MIN_CAROUSEL_ITEMS} and ${MAX_CAROUSEL_ITEMS} slides.`,
    );
  }
  const db = await getDb();
  // Two passes: positions are unique per post, so park them out of the way.
  for (const [index, id] of input.order.entries()) {
    await db
      .update(slide)
      .set({ position: -(index + 1) })
      .where(and(eq(slide.id, id), eq(slide.postId, input.postId)));
  }
  for (const [index, id] of input.order.entries()) {
    await db
      .update(slide)
      .set({ position: index + 1 })
      .where(and(eq(slide.id, id), eq(slide.postId, input.postId)));
  }
  const [current] = await db.select().from(post).where(eq(post.id, input.postId));
  await recordAudit({
    tenantId: current.tenantId,
    postId: input.postId,
    actor: input.actor,
    action: "slides.reordered",
    payload: { order: input.order },
  });
}

export async function deleteSlide(input: {
  postId: string;
  slideId: string;
  actor: Actor;
}): Promise<void> {
  const db = await getDb();
  const rows = await db.select().from(slide).where(eq(slide.postId, input.postId));
  if (rows.length - 1 < MIN_CAROUSEL_ITEMS) {
    throw new Error(
      `A carousel needs at least ${MIN_CAROUSEL_ITEMS} slides. Delete the post instead.`,
    );
  }
  await db.delete(slide).where(eq(slide.id, input.slideId));
  const remaining = rows
    .filter((r) => r.id !== input.slideId)
    .sort((a, b) => a.position - b.position);
  await reorderSlides({
    postId: input.postId,
    order: remaining.map((r) => r.id),
    actor: input.actor,
  });
}

export async function photoHistory(slideId: string) {
  const db = await getDb();
  return db
    .select()
    .from(photoGeneration)
    .where(eq(photoGeneration.slideId, slideId))
    .orderBy(desc(photoGeneration.createdAt))
    .limit(4);
}

export async function selectPhoto(input: {
  postId: string;
  slideId: string;
  generationId: string;
  actor: Actor;
}): Promise<string> {
  const db = await getDb();
  const [generation] = await db
    .select()
    .from(photoGeneration)
    .where(eq(photoGeneration.id, input.generationId));
  if (!generation) throw new Error("That generation no longer exists.");

  await db
    .update(photoGeneration)
    .set({ selected: "false" })
    .where(eq(photoGeneration.slideId, input.slideId));
  await db
    .update(photoGeneration)
    .set({ selected: "true" })
    .where(eq(photoGeneration.id, input.generationId));
  await db
    .update(slide)
    .set({ photoUrl: generation.url })
    .where(eq(slide.id, input.slideId));

  const [current] = await db.select().from(post).where(eq(post.id, input.postId));
  await recordAudit({
    tenantId: current.tenantId,
    postId: input.postId,
    actor: input.actor,
    action: "photo.selected",
    payload: { slideId: input.slideId, generationId: input.generationId },
  });
  return generation.url;
}

export async function auditTrail(postId: string) {
  const db = await getDb();
  return db
    .select()
    .from(auditLog)
    .where(eq(auditLog.postId, postId))
    .orderBy(auditLog.createdAt);
}

export interface QueueFilters {
  tenantIds: string[];
  status?: PostStatus | "all";
  tenantId?: string | "all";
}

export async function listQueue(filters: QueueFilters) {
  const db = await getDb();
  const scope = filters.tenantId && filters.tenantId !== "all"
    ? [filters.tenantId]
    : filters.tenantIds;
  if (scope.length === 0) return [];

  const where =
    filters.status && filters.status !== "all"
      ? and(inArray(post.tenantId, scope), eq(post.status, filters.status))
      : inArray(post.tenantId, scope);

  const posts = await db
    .select()
    .from(post)
    .where(where)
    .orderBy(desc(post.createdAt))
    .limit(200);

  if (posts.length === 0) return [];
  const slides = await db
    .select()
    .from(slide)
    .where(inArray(slide.postId, posts.map((p) => p.id)))
    .orderBy(slide.position);
  const tenants = await db.select().from(tenant);

  return posts.map((p) => ({
    post: p,
    slides: slides.filter((s) => s.postId === p.id),
    tenant: tenants.find((t) => t.id === p.tenantId),
  }));
}
