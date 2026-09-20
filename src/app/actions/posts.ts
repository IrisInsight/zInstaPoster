"use server";

import { revalidatePath } from "next/cache";
import { actorFor, assertTenantAccess, requireUser } from "@/lib/auth";
import {
  approvePost,
  deleteSlide,
  loadPost,
  photoHistory,
  recomputeCompliance,
  regenerateSlidePhoto,
  rejectPost,
  reorderSlides,
  schedulePost,
  selectPhoto,
  submitForApproval,
  unschedulePost,
  updateCaption,
  updateSlideCopy,
} from "@/lib/posts/service";
import { renderPost } from "@/lib/content/pipeline";
import {
  INTERACTIVE_PUBLISH_BUDGET_MS,
  publishPostById,
} from "@/lib/instagram/publish";
import { schedulePublish } from "@/lib/scheduler";
import { getDb, igAccount as igAccountTable, post as postTable } from "@/lib/db";
import { and, eq } from "drizzle-orm";
import { fromLocalInputValue } from "@/lib/time";

export interface ActionResult {
  ok: boolean;
  error?: string;
  message?: string;
}

async function withPost(postId: string) {
  const user = await requireUser();
  const loaded = await loadPost(postId);
  await assertTenantAccess(user, loaded.tenantId);
  return { user, ...loaded };
}

function fail(error: unknown): ActionResult {
  return { ok: false, error: error instanceof Error ? error.message : String(error) };
}

function refresh(postId: string) {
  revalidatePath(`/posts/${postId}/review`);
  revalidatePath(`/posts/${postId}`);
  revalidatePath("/");
}

export async function saveCaptionAction(
  postId: string,
  caption: string,
): Promise<ActionResult> {
  try {
    const { user } = await withPost(postId);
    await updateCaption({ postId, caption, actor: actorFor(user) });
    refresh(postId);
    return { ok: true, message: "Caption saved." };
  } catch (error) {
    return fail(error);
  }
}

export async function saveSlideAction(input: {
  postId: string;
  slideId: string;
  copy: Record<string, unknown>;
  altText?: string;
}): Promise<ActionResult> {
  try {
    const { user, tenant, slides } = await withPost(input.postId);
    const target = slides.find((s) => s.id === input.slideId);
    if (!target) throw new Error("That slide no longer exists.");

    await updateSlideCopy({
      postId: input.postId,
      slideId: input.slideId,
      copy: input.copy,
      altText: input.altText,
      actor: actorFor(user),
    });
    // Editing one slide re-renders that slide only.
    await renderPost({ tenant, postId: input.postId, position: target.position });
    await recomputeCompliance(input.postId);
    refresh(input.postId);
    return { ok: true, message: `Slide ${target.position} re-rendered.` };
  } catch (error) {
    return fail(error);
  }
}

export async function regeneratePhotoAction(input: {
  postId: string;
  slideId: string;
  prompt: string;
}): Promise<ActionResult> {
  try {
    const { user } = await withPost(input.postId);
    const { approvalWithdrawn } = await regenerateSlidePhoto({
      ...input,
      actor: actorFor(user),
    });
    await recomputeCompliance(input.postId);
    refresh(input.postId);
    return {
      ok: true,
      message: approvalWithdrawn
        ? "New photo generated. The approval was withdrawn — someone has to look again."
        : "New photo generated.",
    };
  } catch (error) {
    return fail(error);
  }
}

export async function selectPhotoAction(input: {
  postId: string;
  slideId: string;
  generationId: string;
}): Promise<ActionResult> {
  try {
    const { user, tenant, slides } = await withPost(input.postId);
    const target = slides.find((s) => s.id === input.slideId);
    if (!target) throw new Error("That slide no longer exists.");
    await selectPhoto({ ...input, actor: actorFor(user) });
    await renderPost({ tenant, postId: input.postId, position: target.position });
    refresh(input.postId);
    return { ok: true, message: "Photo selected." };
  } catch (error) {
    return fail(error);
  }
}

/** Scoped to a post the caller can reach: generation prompts are tenant content. */
export async function photoHistoryAction(postId: string, slideId: string) {
  await withPost(postId);
  const rows = await photoHistory({ postId, slideId });
  return rows.map((row) => ({
    id: row.id,
    url: row.url,
    prompt: row.prompt,
    provider: row.provider,
    selected: row.selected === "true",
    createdAt: row.createdAt.toISOString(),
  }));
}

export async function reorderSlidesAction(
  postId: string,
  order: string[],
): Promise<ActionResult> {
  try {
    const { user } = await withPost(postId);
    await reorderSlides({ postId, order, actor: actorFor(user) });
    await recomputeCompliance(postId);
    refresh(postId);
    return { ok: true };
  } catch (error) {
    return fail(error);
  }
}

export async function deleteSlideAction(
  postId: string,
  slideId: string,
): Promise<ActionResult> {
  try {
    const { user } = await withPost(postId);
    await deleteSlide({ postId, slideId, actor: actorFor(user) });
    await recomputeCompliance(postId);
    refresh(postId);
    return { ok: true, message: "Slide deleted." };
  } catch (error) {
    return fail(error);
  }
}

export async function submitForApprovalAction(postId: string): Promise<ActionResult> {
  try {
    const { user } = await withPost(postId);
    await submitForApproval({ postId, actor: actorFor(user) });
    refresh(postId);
    return { ok: true, message: "Sent for approval." };
  } catch (error) {
    return fail(error);
  }
}

/**
 * The approval gate. This is the only path into `approved`, and it runs as the
 * signed-in person — there is no service-account or API-key equivalent.
 */
export async function approveAction(postId: string): Promise<ActionResult> {
  try {
    const { user } = await withPost(postId);
    await approvePost({ postId, actor: actorFor(user) });
    refresh(postId);
    return { ok: true, message: "Approved. Publishing is a separate step." };
  } catch (error) {
    return fail(error);
  }
}

export async function rejectAction(
  postId: string,
  note?: string,
): Promise<ActionResult> {
  try {
    const { user } = await withPost(postId);
    await rejectPost({ postId, actor: actorFor(user), note });
    refresh(postId);
    return { ok: true, message: "Rejected." };
  } catch (error) {
    return fail(error);
  }
}

export async function scheduleAction(input: {
  postId: string;
  localDateTime: string;
}): Promise<ActionResult> {
  try {
    const { user, tenant } = await withPost(input.postId);
    const at = fromLocalInputValue(input.localDateTime, tenant.timezone);
    await schedulePost({ postId: input.postId, at, actor: actorFor(user) });
    refresh(input.postId);
    return { ok: true, message: "Scheduled." };
  } catch (error) {
    return fail(error);
  }
}

export async function unscheduleAction(postId: string): Promise<ActionResult> {
  try {
    const { user } = await withPost(postId);
    await unschedulePost({ postId, actor: actorFor(user) });
    refresh(postId);
    return { ok: true, message: "Schedule cleared." };
  } catch (error) {
    return fail(error);
  }
}

/**
 * Post now. Separate from Approve on purpose: approving is a judgement,
 * publishing is an action, and fusing them means someone ships a post while
 * skimming.
 *
 * This runs inside a server action, which the platform kills at a timeout we
 * do not control — and a publish killed mid-flight is what leaves a post
 * parked in `publishing`. So it publishes on a short budget, and if Instagram
 * is still processing the images when that runs out, the post is handed to the
 * background job, which has the whole budget to wait it out.
 */
export async function publishNowAction(postId: string): Promise<ActionResult> {
  try {
    const { user, post } = await withPost(postId);
    if (!post.approvedBy) {
      return { ok: false, error: "This post has not been approved by a person." };
    }
    const result = await publishPostById({
      postId,
      actorLabel: actorFor(user).label,
      budgetMs: INTERACTIVE_PUBLISH_BUDGET_MS,
    });
    if (result.status === "failed" && result.stillProcessing) {
      const handed = await handOffToScheduler(postId);
      refresh(postId);
      return handed;
    }
    refresh(postId);
    if (result.status === "failed") {
      return { ok: false, error: result.error ?? "Publishing failed." };
    }
    return { ok: true, message: "Published." };
  } catch (error) {
    return fail(error);
  }
}

/**
 * Nothing was published and the post is sitting in `failed`, which the publish
 * flow accepts as a starting point — so the same publish can be run again by
 * the job, off the request. If queueing itself fails, say so plainly: the post
 * is still retryable by hand.
 */
async function handOffToScheduler(postId: string): Promise<ActionResult> {
  try {
    await schedulePublish({ postId, at: new Date() });
    return {
      ok: true,
      message:
        "Instagram is still processing the images. This post will publish as soon as they are ready.",
    };
  } catch {
    return {
      ok: false,
      error:
        "Instagram is still processing the images, and the publish could not be queued. Nothing was published — press Retry in a minute.",
    };
  }
}

export async function retryPublishAction(postId: string): Promise<ActionResult> {
  return publishNowAction(postId);
}

export async function rerenderAction(postId: string): Promise<ActionResult> {
  try {
    const { tenant } = await withPost(postId);
    await renderPost({ tenant, postId });
    await recomputeCompliance(postId);
    refresh(postId);
    return { ok: true, message: "Slides re-rendered." };
  } catch (error) {
    return fail(error);
  }
}

export async function assignAccountAction(
  postId: string,
  igAccountId: string | null,
): Promise<ActionResult> {
  try {
    const { tenantId } = await withPost(postId);
    const db = await getDb();
    if (igAccountId) {
      // The dropdown is tenant-scoped, but this is an HTTP endpoint and the id
      // is whatever the caller sends. Publishing to another tenant's account
      // would decrypt their token and spend their daily quota.
      const [account] = await db
        .select()
        .from(igAccountTable)
        .where(
          and(eq(igAccountTable.id, igAccountId), eq(igAccountTable.tenantId, tenantId)),
        );
      if (!account) {
        return { ok: false, error: "That account does not belong to this tenant." };
      }
    }
    await db
      .update(postTable)
      .set({ igAccountId, updatedAt: new Date() })
      .where(eq(postTable.id, postId));
    refresh(postId);
    return { ok: true };
  } catch (error) {
    return fail(error);
  }
}
