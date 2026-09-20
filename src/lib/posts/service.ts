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
  isEditable,
  TransitionError,
  type Actor,
} from "./state-machine";
import { MAX_CAROUSEL_ITEMS, MIN_MEDIA_ITEMS } from "@/lib/instagram/publish";

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

/**
 * Any change to what would be published withdraws the approval and cancels the
 * schedule. Called by every mutator that touches content — caption, slide copy,
 * slide order, slide deletion and the hook photo — so that "approved" always
 * refers to the bytes that are actually on the post.
 */
async function withdrawApprovalIfContentChanged(input: {
  postId: string;
  actor: Actor;
  reason: string;
}): Promise<boolean> {
  const db = await getDb();
  const [current] = await db.select().from(post).where(eq(post.id, input.postId));
  if (!current) throw new Error(`No post ${input.postId}.`);
  if (
    !editInvalidatesApproval({
      status: current.status as PostStatus,
      approvedBy: current.approvedBy,
    })
  ) {
    return false;
  }

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

  await recordAudit({
    tenantId: current.tenantId,
    postId: input.postId,
    actor: input.actor,
    action: "post.approval_withdrawn",
    payload: {
      reason: input.reason,
      previousStatus: current.status,
      previousApprover: current.approvedBy,
    },
  });
  return true;
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
  const db = await getDb();
  const [current] = await db.select().from(post).where(eq(post.id, input.postId));
  if (!current) throw new TransitionError(`No post ${input.postId}.`);
  // Only from pending_approval. `scheduled` can reach `approved` through
  // unschedulePost, which cancels the queued job; coming through here would
  // leave that job armed behind an "approved" label.
  if (current.status !== "pending_approval") {
    throw new TransitionError(
      `A post that is ${current.status.replace("_", " ")} is not awaiting approval.`,
    );
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
  if (!current) throw new TransitionError(`No post ${input.postId}.`);
  // Only a scheduled post has a schedule to clear. Without this check a
  // published post could be walked back to `approved` and published again.
  if (current.status !== "scheduled") {
    throw new TransitionError(
      `A post with status "${current.status}" has no schedule to clear.`,
    );
  }
  if (current.scheduleJobId) await cancelScheduledJob(current.scheduleJobId);

  return transition({
    postId: input.postId,
    to: "approved",
    actor: input.actor,
    patch: { scheduledFor: null, scheduleJobId: null },
    action: "post.unscheduled",
  });
}

export async function updateCaption(input: {
  postId: string;
  caption: string;
  actor: Actor;
}): Promise<ComplianceReport> {
  const db = await getDb();
  const [current] = await db.select().from(post).where(eq(post.id, input.postId));
  if (!current) throw new Error(`No post ${input.postId}.`);
  if (!isEditable(current.status as PostStatus)) {
    throw new TransitionError(
      `A post that is ${current.status.replace("_", " ")} cannot be edited.`,
    );
  }

  // Withdraw first: if anything fails between these two writes, the post is
  // left needing approval rather than approved with content nobody read.
  const withdrawn = await withdrawApprovalIfContentChanged({
    postId: input.postId,
    actor: input.actor,
    reason: "caption edited",
  });
  await db
    .update(post)
    .set({ caption: input.caption, updatedAt: new Date() })
    .where(eq(post.id, input.postId));
  await recordAudit({
    tenantId: current.tenantId,
    postId: current.id,
    actor: input.actor,
    action: "post.caption_edited",
    payload: { approvalWithdrawn: withdrawn },
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
  if (!isEditable(current.status as PostStatus)) {
    throw new TransitionError(
      `A post that is ${current.status.replace("_", " ")} cannot be edited.`,
    );
  }

  const [target] = await db
    .select()
    .from(slide)
    .where(and(eq(slide.id, input.slideId), eq(slide.postId, input.postId)));
  if (!target) throw new Error("That slide does not belong to this post.");

  const withdrawn = await withdrawApprovalIfContentChanged({
    postId: input.postId,
    actor: input.actor,
    reason: "slide copy edited",
  });
  await db
    .update(slide)
    .set({
      copy: input.copy,
      ...(input.altText !== undefined ? { altText: input.altText } : {}),
    })
    .where(and(eq(slide.id, input.slideId), eq(slide.postId, input.postId)));
  await recordAudit({
    tenantId: current.tenantId,
    postId: current.id,
    actor: input.actor,
    action: "slide.edited",
    payload: { slideId: input.slideId, approvalWithdrawn: withdrawn },
  });
}

export async function reorderSlides(input: {
  postId: string;
  order: string[];
  actor: Actor;
}): Promise<void> {
  const db = await getDb();
  const [current] = await db.select().from(post).where(eq(post.id, input.postId));
  if (!current) throw new Error(`No post ${input.postId}.`);
  if (!isEditable(current.status as PostStatus)) {
    throw new TransitionError(
      `A post that is ${current.status.replace("_", " ")} cannot be reordered.`,
    );
  }

  const rows = await db.select().from(slide).where(eq(slide.postId, input.postId));
  // The order has to be a permutation of this post's slides. A subset would
  // renumber into a collision with the slides it left behind and strand them
  // at negative positions.
  const owned = new Set(rows.map((row) => row.id));
  const unique = new Set(input.order);
  if (
    input.order.length !== owned.size ||
    unique.size !== input.order.length ||
    input.order.some((id) => !owned.has(id))
  ) {
    throw new Error("The new slide order does not match this post's slides.");
  }
  if (input.order.length < MIN_MEDIA_ITEMS || input.order.length > MAX_CAROUSEL_ITEMS) {
    throw new Error(
      `A post must have between ${MIN_MEDIA_ITEMS} and ${MAX_CAROUSEL_ITEMS} slides.`,
    );
  }

  const withdrawn = await withdrawApprovalIfContentChanged({
    postId: input.postId,
    actor: input.actor,
    reason: "slides reordered",
  });

  await db.transaction(async (tx) => {
    // Two passes: positions are unique per post, so park them out of the way.
    for (const [index, id] of input.order.entries()) {
      await tx
        .update(slide)
        .set({ position: -(index + 1) })
        .where(and(eq(slide.id, id), eq(slide.postId, input.postId)));
    }
    for (const [index, id] of input.order.entries()) {
      await tx
        .update(slide)
        .set({ position: index + 1 })
        .where(and(eq(slide.id, id), eq(slide.postId, input.postId)));
    }
  });

  await recordAudit({
    tenantId: current.tenantId,
    postId: input.postId,
    actor: input.actor,
    action: "slides.reordered",
    payload: { order: input.order, approvalWithdrawn: withdrawn },
  });
}

export async function deleteSlide(input: {
  postId: string;
  slideId: string;
  actor: Actor;
}): Promise<void> {
  const db = await getDb();
  const [current] = await db.select().from(post).where(eq(post.id, input.postId));
  if (!current) throw new Error(`No post ${input.postId}.`);
  // Checked before the delete, not after: a guard that runs afterwards still
  // destroys the slide on the way to reporting failure.
  if (!isEditable(current.status as PostStatus)) {
    throw new TransitionError(
      `A post that is ${current.status.replace("_", " ")} cannot be edited.`,
    );
  }

  const rows = await db.select().from(slide).where(eq(slide.postId, input.postId));
  if (!rows.some((row) => row.id === input.slideId)) {
    throw new Error("That slide does not belong to this post.");
  }
  if (rows.length - 1 < MIN_MEDIA_ITEMS) {
    throw new Error(
      `A post needs at least ${MIN_MEDIA_ITEMS} slide. Delete the post instead.`,
    );
  }

  const withdrawn = await withdrawApprovalIfContentChanged({
    postId: input.postId,
    actor: input.actor,
    reason: "slide deleted",
  });

  const remaining = rows
    .filter((row) => row.id !== input.slideId)
    .sort((a, b) => a.position - b.position);

  // The delete and the renumber are one unit: a slide removed without the
  // renumber leaves a gap in the carousel's positions.
  await db.transaction(async (tx) => {
    const deleted = await tx
      .delete(slide)
      .where(and(eq(slide.id, input.slideId), eq(slide.postId, input.postId)))
      .returning();
    if (deleted.length === 0) {
      throw new Error("That slide no longer exists.");
    }
    for (const [index, row] of remaining.entries()) {
      await tx
        .update(slide)
        .set({ position: -(index + 1) })
        .where(and(eq(slide.id, row.id), eq(slide.postId, input.postId)));
    }
    for (const [index, row] of remaining.entries()) {
      await tx
        .update(slide)
        .set({ position: index + 1 })
        .where(and(eq(slide.id, row.id), eq(slide.postId, input.postId)));
    }
  });

  await recordAudit({
    tenantId: current.tenantId,
    postId: input.postId,
    actor: input.actor,
    action: "slide.deleted",
    payload: { slideId: input.slideId, approvalWithdrawn: withdrawn },
  });
}

/**
 * Regenerating the hook photo replaces the image that is most of the post on
 * Instagram, so it goes through the same guard and withdrawal as every other
 * content change rather than straight to the pipeline.
 */
export async function regenerateSlidePhoto(input: {
  postId: string;
  slideId: string;
  prompt: string;
  actor: Actor;
  /** Seam for tests, like `sleep` on the publish path. */
  generate?: (args: {
    tenant: TenantConfig;
    postId: string;
    slideId: string;
    position: number;
    prompt: string;
    slideType: string;
    templateName: string;
  }) => Promise<string>;
}): Promise<{ photoUrl: string; approvalWithdrawn: boolean }> {
  const db = await getDb();
  const [current] = await db.select().from(post).where(eq(post.id, input.postId));
  if (!current) throw new Error(`No post ${input.postId}.`);
  if (!isEditable(current.status as PostStatus)) {
    throw new TransitionError(
      `A post that is ${current.status.replace("_", " ")} cannot be edited.`,
    );
  }

  const [target] = await db
    .select()
    .from(slide)
    .where(and(eq(slide.id, input.slideId), eq(slide.postId, input.postId)));
  if (!target) throw new Error("That slide does not belong to this post.");

  const withdrawn = await withdrawApprovalIfContentChanged({
    postId: input.postId,
    actor: input.actor,
    reason: "hook photo regenerated",
  });

  const { generateSlidePhoto, renderPost } = await import("@/lib/content/pipeline");
  const config = await loadTenantConfig(current.tenantId);
  const generate = input.generate ?? generateSlidePhoto;
  const photoUrl = await generate({
    tenant: config,
    postId: input.postId,
    slideId: input.slideId,
    position: target.position,
    prompt: input.prompt,
    slideType: target.type,
    templateName: current.template,
  });
  if (!input.generate) {
    await renderPost({
      tenant: config,
      postId: input.postId,
      position: target.position,
    });
  }

  await recordAudit({
    tenantId: current.tenantId,
    postId: input.postId,
    actor: input.actor,
    action: "photo.regenerated",
    payload: {
      slideId: input.slideId,
      prompt: input.prompt,
      approvalWithdrawn: withdrawn,
    },
  });
  return { photoUrl, approvalWithdrawn: withdrawn };
}

export async function photoHistory(input: { postId: string; slideId: string }) {
  const db = await getDb();
  const [target] = await db
    .select()
    .from(slide)
    .where(and(eq(slide.id, input.slideId), eq(slide.postId, input.postId)));
  if (!target) return [];
  return db
    .select()
    .from(photoGeneration)
    .where(eq(photoGeneration.slideId, input.slideId))
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
  const [current] = await db.select().from(post).where(eq(post.id, input.postId));
  if (!current) throw new Error(`No post ${input.postId}.`);
  if (!isEditable(current.status as PostStatus)) {
    throw new TransitionError(
      `A post that is ${current.status.replace("_", " ")} cannot be edited.`,
    );
  }

  const [target] = await db
    .select()
    .from(slide)
    .where(and(eq(slide.id, input.slideId), eq(slide.postId, input.postId)));
  if (!target) throw new Error("That slide does not belong to this post.");

  // Scoped to the slide: a generation id alone would let any image in the
  // database be pasted onto this slide.
  const [generation] = await db
    .select()
    .from(photoGeneration)
    .where(
      and(
        eq(photoGeneration.id, input.generationId),
        eq(photoGeneration.slideId, input.slideId),
      ),
    );
  if (!generation) throw new Error("That generation no longer exists.");

  const withdrawn = await withdrawApprovalIfContentChanged({
    postId: input.postId,
    actor: input.actor,
    reason: "hook photo changed",
  });

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

  await recordAudit({
    tenantId: current.tenantId,
    postId: input.postId,
    actor: input.actor,
    action: "photo.selected",
    payload: {
      slideId: input.slideId,
      generationId: input.generationId,
      approvalWithdrawn: withdrawn,
    },
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
  // The requested tenant comes from a query parameter. It narrows the user's
  // own memberships and can never widen them.
  const requested =
    filters.tenantId && filters.tenantId !== "all" ? filters.tenantId : null;
  if (requested && !filters.tenantIds.includes(requested)) return [];
  const scope = requested ? [requested] : filters.tenantIds;
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
  const tenants = await db
    .select()
    .from(tenant)
    .where(inArray(tenant.id, scope));

  return posts.map((p) => ({
    post: p,
    slides: slides.filter((s) => s.postId === p.id),
    tenant: tenants.find((t) => t.id === p.tenantId),
  }));
}
