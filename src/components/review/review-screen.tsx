"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import {
  approveAction,
  assignAccountAction,
  publishNowAction,
  rejectAction,
  submitForApprovalAction,
} from "@/app/actions/posts";
import type { ComplianceReport } from "@/lib/compliance/types";
import type { PostStatus } from "@/lib/db/schema";
import { StatusPill } from "@/components/status-pill";
import { CarouselPane } from "./carousel-pane";
import { CaptionEditor } from "./caption-editor";
import { CompliancePanel } from "./compliance-panel";
import { SchedulePopover } from "./schedule-popover";
import { SlideEditor } from "./slide-editor";
import type { PhotoOption, ReviewPost, ReviewSlide, WindowSuggestion } from "./types";

export function ReviewScreen({
  post,
  slides,
  report,
  tenant,
  accounts,
  photoGenerations,
  windowSuggestions,
  photoAvailable,
}: {
  post: ReviewPost;
  slides: ReviewSlide[];
  report: ComplianceReport | null;
  tenant: { name: string; timezone: string; disclaimers: Record<string, string> };
  accounts: { id: string; username: string; status: string }[];
  photoGenerations: PhotoOption[];
  windowSuggestions: WindowSuggestion[];
  photoAvailable: boolean;
}) {
  const router = useRouter();
  const [selectedId, setSelectedId] = useState(slides[0]?.id ?? "");
  const [toast, setToast] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 3200);
    return () => clearTimeout(timer);
  }, [toast]);

  const selected = slides.find((s) => s.id === selectedId) ?? slides[0];
  const blocking = report?.findings.filter((f) => f.severity === "blocking") ?? [];
  const approvable = (report?.approvable ?? false) && blocking.length === 0;
  const status = post.status as PostStatus;
  const editable = status !== "published" && status !== "publishing";
  const approved = Boolean(post.approvedBy);

  function announce(message: string) {
    setToast(message);
    setError(null);
    router.refresh();
  }

  function run(action: () => Promise<{ ok: boolean; error?: string; message?: string }>, fallback: string) {
    startTransition(async () => {
      const result = await action();
      if (result.ok) announce(result.message ?? fallback);
      else setError(result.error ?? "Something went wrong.");
    });
  }

  return (
    <div className="pb-20">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Link href="/" className="text-[12.5px] text-[var(--color-muted)] hover:underline">
          ← Queue
        </Link>
        <StatusPill status={status} size="md" />
        <h1 className="text-[15px] font-semibold tracking-tight">{post.title}</h1>
        <span className="text-[12px] text-[var(--color-muted)]">{tenant.name}</span>
        {approved && (
          <span className="rounded border border-[#bcd8c6] bg-[var(--color-ok-soft)] px-1.5 py-[1px] text-[11px] text-[var(--color-ok)]">
            approved by {post.approvedBy}
          </span>
        )}
        <Link
          href={`/posts/${post.id}`}
          className="ml-auto text-[12.5px] text-[var(--color-muted)] hover:underline"
        >
          Audit trail
        </Link>
      </div>

      {post.failureReason && (
        <p className="mb-3 rounded-md border border-[#efc0b8] bg-[var(--color-danger-soft)] px-3 py-2 font-mono text-[12px] leading-snug text-[var(--color-danger)]">
          {post.failureReason}
        </p>
      )}

      <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(400px,480px)]">
        <div className="lg:sticky lg:top-[60px]">
          <CarouselPane
            slides={slides}
            selectedId={selected?.id ?? null}
            onSelect={setSelectedId}
          />
          <p className="mt-2 text-[11.5px] text-[var(--color-faint)]">
            These are the rendered JPEGs that get published, not a preview of
            them. Click to enlarge and swipe as Instagram presents them. Edits
            save as you make them.
          </p>
        </div>

        <div className="space-y-3">
          <CompliancePanel report={report} />

          <CaptionEditor
            key={post.caption}
            postId={post.id}
            initial={post.caption}
            editable={editable}
            onSaved={announce}
          />

          {selected && (
            <SlideEditor
              key={selected.id + selected.renderedUrl}
              postId={post.id}
              slides={slides}
              slide={selected}
              photoOptions={photoGenerations.filter(
                (option) => option.slideId === selected.id,
              )}
              photoAvailable={photoAvailable}
              editable={editable}
              onSelect={setSelectedId}
              onChanged={announce}
            />
          )}

          <section className="rounded-lg border border-[var(--color-line)] bg-[var(--color-surface)] px-3 py-2.5">
            <label className="flex items-center gap-2 text-[12px] font-medium uppercase tracking-wider text-[var(--color-muted)]">
              Account
              <select
                value={post.igAccountId ?? ""}
                onChange={(event) =>
                  run(
                    () =>
                      assignAccountAction(post.id, event.target.value || null),
                    "Account updated.",
                  )
                }
                className="ml-auto rounded border border-[var(--color-line)] px-2 py-1 text-[12.5px] font-normal normal-case tracking-normal text-[var(--color-ink)]"
              >
                <option value="">Not selected</option>
                {accounts.map((account) => (
                  <option key={account.id} value={account.id}>
                    @{account.username}
                    {account.status === "connected" ? "" : ` (${account.status})`}
                  </option>
                ))}
              </select>
            </label>
            {accounts.length === 0 && (
              <p className="mt-1.5 text-[11.5px] text-[var(--color-warn)]">
                No Instagram account is connected for this tenant.{" "}
                <Link href="/accounts" className="underline">
                  Connect one
                </Link>
                .
              </p>
            )}
          </section>
        </div>
      </div>

      <footer className="fixed inset-x-0 bottom-0 z-30 border-t border-[var(--color-line)] bg-[var(--color-surface)]/97 backdrop-blur">
        <div className="mx-auto flex max-w-[1560px] flex-wrap items-center gap-2 px-4 py-2.5">
          <div className="min-w-0 flex-1">
            {error ? (
              <p className="truncate text-[12.5px] text-[var(--color-danger)]">{error}</p>
            ) : toast ? (
              <p className="fade-up truncate text-[12.5px] text-[var(--color-ok)]">{toast}</p>
            ) : (
              <p className="truncate text-[12px] text-[var(--color-faint)]">
                {approved
                  ? "Approved. Any edit withdraws this approval. Publishing is a separate, deliberate action."
                  : blocking.length > 0
                    ? `${blocking.length} blocking ${blocking.length === 1 ? "error" : "errors"} to resolve before approval.`
                    : "Nothing publishes until a person approves it."}
              </p>
            )}
          </div>

          {(status === "pending_approval" || status === "draft") && (
            <button
              type="button"
              disabled={pending}
              onClick={() => run(() => rejectAction(post.id), "Rejected.")}
              className="rounded-md border border-[var(--color-line)] px-3 py-1.5 text-[13px] text-[var(--color-muted)] disabled:opacity-40"
            >
              Reject
            </button>
          )}

          {(status === "draft" || status === "rejected") && (
            <button
              type="button"
              disabled={pending || !approvable}
              title={
                approvable
                  ? "Send this post for approval"
                  : "Blocking compliance errors must be resolved first"
              }
              onClick={() =>
                run(() => submitForApprovalAction(post.id), "Sent for approval.")
              }
              className="rounded-md bg-[var(--color-ink)] px-4 py-1.5 text-[13px] font-medium text-white disabled:opacity-40"
            >
              Send for approval
            </button>
          )}

          {status === "pending_approval" && (
            <button
              type="button"
              disabled={pending || !approvable}
              title={
                approvable
                  ? "Approve this post"
                  : "Blocking compliance errors must be resolved first"
              }
              onClick={() => run(() => approveAction(post.id), "Approved.")}
              className="rounded-md bg-[var(--color-ink)] px-4 py-1.5 text-[13px] font-medium text-white disabled:opacity-40"
            >
              Approve
            </button>
          )}

          {approved && status !== "published" && (
            <>
              <SchedulePopover
                postId={post.id}
                timezone={tenant.timezone}
                suggestions={windowSuggestions}
                scheduledFor={post.scheduledFor}
                disabled={pending}
                onDone={announce}
              />
              <button
                type="button"
                disabled={pending || !post.igAccountId}
                title={
                  post.igAccountId
                    ? "Publish this carousel now"
                    : "Select an Instagram account first"
                }
                onClick={() => run(() => publishNowAction(post.id), "Published.")}
                className="rounded-md bg-[var(--color-flame)] px-4 py-1.5 text-[13px] font-medium text-white disabled:opacity-40"
              >
                {pending ? "Working…" : "Post now"}
              </button>
            </>
          )}
        </div>
      </footer>
    </div>
  );
}
