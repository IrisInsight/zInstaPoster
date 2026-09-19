import type { PostStatus } from "@/lib/db/schema";

/**
 * draft → pending_approval → approved → scheduled → publishing → published
 *                         ↘ rejected                          ↘ failed
 *
 * There is no transition into `publishing` that does not pass through a human
 * setting `approved`. That is a compliance requirement, not a preference, so
 * it is expressed as data here and asserted on every transition.
 */

export type Actor =
  | { type: "human"; id: string; label: string }
  | { type: "system"; label: string };

interface TransitionRule {
  from: PostStatus[];
  /** Only a human may make this transition. No service account, no API key. */
  humanOnly?: boolean;
  /** Blocking compliance findings must be absent. */
  requiresClean?: boolean;
}

export const TRANSITIONS: Record<PostStatus, TransitionRule> = {
  draft: { from: ["draft", "pending_approval", "rejected"] },
  pending_approval: { from: ["draft", "rejected"], requiresClean: true },
  approved: {
    // `scheduled` is here so a human can clear a schedule without re-approving;
    // the approval itself is unchanged by that.
    from: ["pending_approval", "scheduled"],
    humanOnly: true,
    requiresClean: true,
  },
  rejected: { from: ["pending_approval", "approved"], humanOnly: true },
  scheduled: { from: ["approved", "scheduled", "failed"], humanOnly: true },
  publishing: { from: ["approved", "scheduled", "failed"] },
  published: { from: ["publishing"] },
  failed: { from: ["publishing", "scheduled"] },
};

export class TransitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TransitionError";
  }
}

export function assertTransition(input: {
  from: PostStatus;
  to: PostStatus;
  actor: Actor;
  hasBlockingFindings?: boolean;
  approvedBy?: string | null;
}): void {
  const rule = TRANSITIONS[input.to];
  if (!rule) throw new TransitionError(`Unknown status "${input.to}".`);
  if (!rule.from.includes(input.from)) {
    throw new TransitionError(
      `A post cannot go from ${label(input.from)} to ${label(input.to)}.`,
    );
  }
  if (rule.humanOnly && input.actor.type !== "human") {
    throw new TransitionError(
      `Only a person can move a post to ${label(input.to)}.`,
    );
  }
  if (rule.requiresClean && input.hasBlockingFindings) {
    throw new TransitionError(
      "This post has blocking compliance errors and cannot be advanced until they are resolved.",
    );
  }
  // The publish path is the one that matters most: a post reaches `publishing`
  // only if a human already recorded an approval on it.
  if (input.to === "publishing" && !input.approvedBy) {
    throw new TransitionError(
      "This post has never been approved by a person, so it cannot be published.",
    );
  }
}

export function label(status: PostStatus): string {
  return status.replace(/_/g, " ");
}

export const TERMINAL: PostStatus[] = ["published"];

/**
 * Whether a post's content can still be changed. A failed post is editable —
 * that is how a rejected publish gets fixed — and the edit withdraws its
 * approval. A published post is a record, and a publishing one is in flight.
 */
export function isEditable(status: PostStatus): boolean {
  return status !== "published" && status !== "publishing";
}

/**
 * After an approval, any content edit sends the post back for re-approval.
 *
 * This is keyed on the approval itself rather than on a list of statuses: a
 * `failed` post still carries the approver who signed off on the content that
 * failed, and retrying it after an edit would publish something nobody read.
 */
export function editInvalidatesApproval(post: {
  status: PostStatus;
  approvedBy?: string | null;
}): boolean {
  if (post.status === "published") return false;
  return Boolean(post.approvedBy);
}
