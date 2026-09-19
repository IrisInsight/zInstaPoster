import Link from "next/link";
import { notFound } from "next/navigation";
import { assertTenantAccess, requireUser } from "@/lib/auth";
import { auditTrail, loadPost } from "@/lib/posts/service";
import type { PostStatus } from "@/lib/db/schema";
import { StatusPill } from "@/components/status-pill";
import { RetryButton } from "@/components/retry-button";
import { formatInZone, relativeTime } from "@/lib/time";

export const dynamic = "force-dynamic";

const ACTION_LABELS: Record<string, string> = {
  "post.generated": "Generated",
  "post.seeded": "Seeded",
  "post.pending_approval": "Sent for approval",
  "post.approved": "Approved",
  "post.rejected": "Rejected",
  "post.scheduled": "Scheduled",
  "post.unscheduled": "Schedule cleared",
  "post.publishing": "Publishing started",
  "post.published": "Published",
  "post.publish_failed": "Publish failed",
  "post.caption_edited": "Caption edited",
  "slide.edited": "Slide edited",
  "slides.reordered": "Slides reordered",
  "photo.selected": "Photo selected",
};

export default async function PostDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const user = await requireUser();

  let loaded;
  try {
    loaded = await loadPost(id);
  } catch {
    notFound();
  }
  await assertTenantAccess(user, loaded.tenantId);

  const trail = await auditTrail(id);
  const { post, slides, tenant } = loaded;
  const status = post.status as PostStatus;

  return (
    <div className="mx-auto max-w-[1100px]">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Link href="/" className="text-[12.5px] text-[var(--color-muted)] hover:underline">
          ← Queue
        </Link>
        <StatusPill status={status} size="md" />
        <h1 className="text-[15px] font-semibold tracking-tight">{post.title}</h1>
        <span className="text-[12px] text-[var(--color-muted)]">{tenant.name}</span>
        <div className="ml-auto flex items-center gap-2">
          {status === "failed" && <RetryButton postId={post.id} />}
          {status !== "published" && (
            <Link
              href={`/posts/${post.id}/review`}
              className="rounded-md border border-[var(--color-line-strong)] px-2.5 py-1 text-[12.5px] font-medium"
            >
              Open review
            </Link>
          )}
          {post.permalink && (
            <a
              href={post.permalink}
              target="_blank"
              rel="noreferrer"
              className="rounded-md bg-[var(--color-ink)] px-2.5 py-1 text-[12.5px] font-medium text-white"
            >
              View on Instagram
            </a>
          )}
        </div>
      </div>

      {post.failureReason && (
        <section className="mb-4 rounded-lg border border-[#efc0b8] bg-[var(--color-danger-soft)] p-3">
          <h2 className="text-[12px] font-semibold uppercase tracking-wider text-[var(--color-danger)]">
            What Instagram said
          </h2>
          <pre className="mt-1.5 overflow-x-auto whitespace-pre-wrap font-mono text-[11.5px] leading-snug text-[var(--color-danger)]">
            {post.failureReason}
          </pre>
        </section>
      )}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_340px]">
        <div>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {slides.map((slide) => (
              <figure key={slide.id}>
                <div
                  className="overflow-hidden rounded-md border border-[var(--color-line)] bg-[var(--color-canvas)]"
                  style={{ aspectRatio: "4 / 5" }}
                >
                  {slide.renderedUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={slide.renderedUrl}
                      alt={slide.altText}
                      className="size-full object-cover"
                    />
                  ) : (
                    <div className="flex size-full items-center justify-center text-[11px] text-[var(--color-faint)]">
                      not rendered
                    </div>
                  )}
                </div>
                <figcaption className="mt-1 text-[10.5px] text-[var(--color-faint)]">
                  {slide.position} · {slide.type}
                </figcaption>
              </figure>
            ))}
          </div>

          <section className="mt-4 rounded-lg border border-[var(--color-line)] bg-[var(--color-surface)] p-3.5">
            <h2 className="text-[12px] font-semibold uppercase tracking-wider text-[var(--color-muted)]">
              Caption as published
            </h2>
            <p className="mt-2 whitespace-pre-wrap text-[13.5px] leading-relaxed">
              {post.caption}
            </p>
          </section>
        </div>

        <aside className="space-y-3">
          <section className="rounded-lg border border-[var(--color-line)] bg-[var(--color-surface)] p-3.5">
            <h2 className="text-[12px] font-semibold uppercase tracking-wider text-[var(--color-muted)]">
              Record
            </h2>
            <dl className="mt-2 space-y-1 text-[12.5px]">
              <Row label="Generated by" value={post.createdBy ?? "—"} />
              <Row label="Approved by" value={post.approvedBy ?? "not approved"} />
              <Row
                label="Approved at"
                value={
                  post.approvedAt
                    ? formatInZone(post.approvedAt, tenant.timezone)
                    : "—"
                }
              />
              <Row
                label="Scheduled for"
                value={
                  post.scheduledFor
                    ? formatInZone(post.scheduledFor, tenant.timezone)
                    : "—"
                }
              />
              <Row
                label="Published"
                value={
                  post.publishedAt
                    ? formatInZone(post.publishedAt, tenant.timezone)
                    : "—"
                }
              />
              <Row label="Media ID" value={post.publishedMediaId ?? "—"} mono />
            </dl>
          </section>

          <section className="rounded-lg border border-[var(--color-line)] bg-[var(--color-surface)]">
            <h2 className="border-b border-[var(--color-line)] px-3.5 py-2 text-[12px] font-semibold uppercase tracking-wider text-[var(--color-muted)]">
              Audit trail
            </h2>
            <ol className="divide-y divide-[var(--color-line)]">
              {trail.map((entry) => (
                <li key={entry.id} className="px-3.5 py-2">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="text-[12.5px] font-medium">
                      {ACTION_LABELS[entry.action] ?? entry.action}
                    </span>
                    <span
                      className="tabular shrink-0 text-[10.5px] text-[var(--color-faint)]"
                      title={entry.createdAt.toISOString()}
                    >
                      {relativeTime(entry.createdAt)}
                    </span>
                  </div>
                  <p className="text-[11.5px] text-[var(--color-muted)]">
                    {entry.actorType === "system" ? "system · " : ""}
                    {entry.actor}
                  </p>
                </li>
              ))}
              {trail.length === 0 && (
                <li className="px-3.5 py-3 text-[12.5px] text-[var(--color-muted)]">
                  Nothing recorded yet.
                </li>
              )}
            </ol>
          </section>
        </aside>
      </div>
    </div>
  );
}

function Row({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="flex items-baseline gap-2">
      <dt className="w-[92px] shrink-0 text-[var(--color-faint)]">{label}</dt>
      <dd className={`min-w-0 break-words ${mono ? "font-mono text-[11.5px]" : ""}`}>
        {value}
      </dd>
    </div>
  );
}
